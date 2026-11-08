import {
  AgentxError,
  ErrorCode,
  ProviderBadResponseError,
  ProviderFailedError,
  TaskCancelledError,
  TaskTimeoutError,
  type ChatMessage,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from "@agentx/core";
import { sleep, type FetchLike } from "./openai-compatible.js";

/**
 * gate-service provider —— 让每一轮 agent 模型调用都经过本地 PoL 治理门禁。
 *
 * 与 openai-compatible 的根本差别：gate-service 不是 OpenAI 协议的透传代理，
 * 它是业务门禁。它的接口 `POST /api/v1/chat`：
 *   - 入参 `{ messages, metadata }`，最后一条必须是 user；
 *   - 出参 `{ success, data: { content, source, audit }, error?, request_id }`；
 *   - 拒绝时 success=false / error.code="POL_REJECTED"（HTTP 仍 200）。
 *
 * 因此本 provider 的工作是「协议翻译 + 语义映射」：
 *   1. agent 的 tool_calls / tool 结果 -> gate 能接受的 messages（见 encodeMessages）；
 *   2. gate 的 data.content -> 若可解析出工具调用则返回 tool_calls，否则 final 文本；
 *   3. POL_REJECTED / AUDIT_UNAVAILABLE 等 -> 明确错误，绝不当成正常回答放过。
 */

export interface GateOptions {
  id: string;
  baseUrl: string;
  models: ModelInfo[];
  /** gate 侧的 admin token 不用于 /api/v1/chat（该端点公开），保留以兼容配置形态。 */
  apiKey?: string;
  apiKeyEnv?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  headers?: Record<string, string>;
  retryBaseMs?: number;
  logger?: { debug(m: string, o?: unknown): void; warn(m: string, o?: unknown): void };
  /** 会话标识，写入 gate 的 metadata.conversation_id，便于后台审计串联。 */
  conversationId?: string;
}

interface GateResponse {
  success?: boolean;
  data?: { content?: string; source?: string; audit?: unknown; knowledge_id?: string | null };
  error?: { code?: string; message?: string };
  request_id?: string | null;
}

/** gate 的请求体只认 user/assistant/system/tool，且最后一条必须是 user。 */
const GATE_ROLES = new Set(["user", "assistant", "system", "tool"]);

/** gate 侧 messages 元素。tool 消息必须带 tool_call_id —— gate 会原样转发给云端 LLM。 */
type GateToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type GateMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: GateToolCall[];
};

/** 短内容指纹：用于让收尾 query 唯一，避免不同任务共用同一 intent_hash 命中同一缓存。 */
function shortDigest(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}-${(h >>> 0).toString(36)}`;
}

/**
 * 把 agent 的 ChatMessage[] 转成 gate 能接受的 messages。
 *
 * 关键约束（实测踩过）：
 *   1. 最后一条必须是 user —— agent 第二步常常是 tool 结果或 assistant 文本，gate 会 400；
 *   2. role="tool" 必须带 tool_call_id —— gate 的 validate 只校验 role/content，但消息对象被
 *      **原样转发**给云端 LLM，缺 tool_call_id 时云端回 422（missing field `tool_call_id`），
 *      gate 再把它包成 LLM_UNAVAILABLE —— 排查时极易误判成网络故障；
 *   3. 带 tool_calls 的 assistant 消息 content 常为空，gate 拒收空内容，需回填可读文本。
 */
export function encodeMessages(messages: ChatMessage[]): GateMessage[] {
  const out: GateMessage[] = [];
  let lastCallId = "";
  for (const m of messages) {
    const role = GATE_ROLES.has(m.role) ? m.role : "user";
    let content = m.content ?? "";
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // 必须发结构化 tool_calls：下游 tool 消息以 tool_call_id 引用它，云端会校验
      // 「role='tool' 必须是某个带 tool_calls 的 assistant 消息的回应」，只压成文本会被 400。
      lastCallId = m.toolCalls[m.toolCalls.length - 1]!.id;
      out.push({
        role: "assistant",
        // gate 的 validate 要求 content 是非空 string（它会拒绝 null / 空串），
        // 而 OpenAI 允许带 tool_calls 的 assistant 用 null content。这里用一段占位文本
        // 同时满足两边：下游 tool 消息靠 tool_calls[].id 关联，不依赖这段文本。
        content: content.trim() === "" ? "（调用工具）" : content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      });
      continue;
    }
    if (m.role === "tool") {
      // tool_call_id 缺失时用上一条 assistant 的最后一个调用 id 兜底；
      // 都拿不到就不发 tool 角色 —— 宁可降级为 user（云端不校验），也不要 422 打歪整轮。
      const callId = m.toolCallId ?? lastCallId;
      if (callId) {
        out.push({ role: "tool", content: content.trim() === "" ? "[空]" : content, tool_call_id: callId });
        continue;
      }
      content = `[工具结果]\n${content}`;
      out.push({ role: "user", content: content.trim() === "" ? "[空]" : content });
      continue;
    }
    if (content.trim() === "") content = "[空]";
    out.push({ role, content });
  }
  // gate 要求最后一条是 user。尾部是 assistant 时把它改写成 user 说明；尾部是 tool 时
  // **不能**改写 —— role="tool" + tool_call_id 必须成对发给云端，改成 user 会丢 id 触发 422
  // （agent 的第二轮永远是「…assistant tool_call, tool 结果」收尾，实测正是这里炸的）。
  // 因此 tool 结尾时改为在其后追加一条 user 收尾消息。
  //
  // 收尾文本必须唯一：gate 用 intent_hash(query) 做缓存命中判定，并把 query 连同回答
  // 写进知识库。若用固定常量，所有任务的收尾轮共享同一 intent_hash，会互相命中缓存并
  // 污染知识库（实测：一个读文件任务的答案被存成「（以上为工具结果，请基于它继续）」的答案）。
  const last = out[out.length - 1];
  if (last && last.role === "tool") {
    // 用上一条工具结果的内容做指纹，保证不同任务/不同轮次的收尾 query 互不相同。
    out.push({ role: "user", content: `（继续处理上一条工具结果 ${shortDigest(last.content ?? "")}）` });
  } else if (last && last.role !== "user") {
    out.splice(out.length - 1, 1);
    out.push({ role: "user", content: `（${last.role}）\n${last.content}` });
  }
  if (out.length === 0) out.push({ role: "user", content: "[空]" });
  return out;
}

/**
 * 让模型输出「可解析的工具调用」。
 *
 * gate 只回 content 文本，不认 tools 参数。为了在 B2 语义下仍然能驱动 agent 的工具循环，
 * 本 provider 在被提供了 tools 时，往消息里追加一段「工具调用协议」system 说明：
 * 模型要么输出普通回答，要么输出 `{"tool_call": {"name": ..., "arguments": {...}}}`。
 * parseToolReply 负责还原。
 */
export function buildToolProtocolPrompt(tools: ModelRequest["tools"]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
  return [
    "【工具调用协议】",
    "你可以使用以下工具：",
    ...lines,
    "需要调用工具时，只输出一个 JSON 对象，格式：",
    '{"tool_call":{"name":"工具名","arguments":{...参数...}}}',
    "不需要调用工具时，用普通自然语言直接回答用户，不要输出 JSON。",
    "一次只调用一个工具。工具执行结果会以 tool 消息回传给你。",
  ].join("\n");
}

/**
 * 从 gate 返回的 content 中还原工具调用。
 *
 * 只接受形如 {"tool_call":{"name":"...","arguments":{...}}} 的对象；
 * 解析失败一律返回 final —— 把模型的话当文本返回，比猜错工具名更安全。
 */
export function parseToolReply(
  content: string,
  allowed: string[],
  idSeed: number,
): { call: ToolCall; text?: string } | undefined {
  const trimmed = content.trim();
  if (trimmed === "") return undefined;

  // 模型经常在 JSON 前后加一句自然语言（"我先读取这两个文件。\n\n{...}"）。
  // 实测：只认「整体以 { 开头」会把这些调用漏成 final，工具永远不执行。
  // 因此两步：先整体解析，失败再在文本里定位 {"tool_call" 后做括号配平提取。
  const candidates: string[] = [];
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  candidates.push(unfenced);
  const embedded = extractBalancedObject(trimmed, '"tool_call"');
  if (embedded) candidates.push(embedded);

  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const raw = obj.tool_call;
    if (!raw || typeof raw !== "object") continue;
    const call = raw as Record<string, unknown>;
    const name = call.name;
    if (typeof name !== "string" || name === "") continue;
    if (allowed.length > 0 && !allowed.includes(name)) {
      // 模型编了不存在的工具名：不猜，交回文本让循环按 final 处理。
      continue;
    }
    // JSON 之前的自然语言作为 assistant 文本保留（便于下一轮上下文与日志）。
    const prefix = trimmed.slice(0, trimmed.indexOf(text)).trim();
    const result: { call: ToolCall; text?: string } = {
      call: {
        id: `gate_call_${idSeed}`,
        name,
        arguments: call.arguments ?? {},
      },
    };
    if (prefix !== "") result.text = prefix;
    return result;
  }

  // 兜底：DeepSeek 系模型在不走原生 tool_calls 通道时，会输出厂商私有的 DSML 标记，
  // 形如 <｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="path">a</...>。
  // 实测第二个工具轮就是这种输出：不解析 -> 整轮被当成 final 文本，任务中断在半路。
  return parseDsmlToolCall(trimmed, allowed, idSeed);
}

/**
 * 解析 DeepSeek DSML 工具调用标记。
 *
 * 只取第一个 invoke；参数按 string="true" 与裸值区分：前者原样当字符串，
 * 后者尝试 JSON.parse（数字/布尔/对象），失败则保留字符串。
 */
export function parseDsmlToolCall(
  content: string,
  allowed: string[],
  idSeed: number,
): { call: ToolCall; text?: string } | undefined {
  const invokeRe = /invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[^>]*invoke>/i;
  const m = invokeRe.exec(content);
  if (!m) return undefined;
  const name = m[1]!;
  if (allowed.length > 0 && !allowed.includes(name)) return undefined;

  const args: Record<string, unknown> = {};
  const paramRe = /parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/[^>]*parameter>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(m[2]!)) !== null) {
    const key = pm[1]!;
    const attrs = pm[2] ?? "";
    const raw = pm[3] ?? "";
    const isString = /string="true"/i.test(attrs);
    if (isString) {
      args[key] = raw;
      continue;
    }
    const text = raw.trim();
    try {
      args[key] = JSON.parse(text);
    } catch {
      args[key] = text;
    }
  }

  // DeepSeek 有时把参数再包一层：parameter name="arguments" 里放整个 JSON 对象，
  // 并额外给出 name="name"。此时真正的工具参数在 arguments 里，必须展平，
  // 否则模型明明给了 {"path": ...}，工具却收到空对象并报 "path: Required"（实测）。
  if (args.arguments !== undefined) {
    let inner: unknown = args.arguments;
    if (typeof inner === "string") {
      try {
        inner = JSON.parse(inner);
      } catch {
        inner = undefined;
      }
    }
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      delete args.arguments;
      delete args.name;
      Object.assign(args, inner as Record<string, unknown>);
    }
  }

  const prefix = content.slice(0, m.index).replace(/<[^>]*>/g, "").trim();
  const result: { call: ToolCall; text?: string } = {
    call: { id: `gate_call_${idSeed}`, name, arguments: args },
  };
  if (prefix !== "") result.text = prefix;
  return result;
}

/**
 * 在文本中定位包含 marker 的对象起始 `{`，并按花括号配平截出完整对象。
 * 只做结构提取，不做语义判断；JSON.parse 仍由调用方完成。
 */
function extractBalancedObject(text: string, marker: string): string | undefined {
  const markerAt = text.indexOf(marker);
  if (markerAt === -1) return undefined;
  const start = text.lastIndexOf("{", markerAt);
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** gate 的拒绝/技术故障 -> AgentxError；这些绝不能被当作正常回答。 */
function toAgentxError(
  providerId: string,
  payload: GateResponse,
  requestId: string | null,
): AgentxError | undefined {
  const code = payload.error?.code;
  if (!code) return undefined;
  const message = payload.error?.message ?? "gate rejected the request";
  // POL_REJECTED 是业务裁决（治理生效），不可重试。
  if (code === "POL_REJECTED") {
    return new AgentxError(ErrorCode.POLICY_DENIED, `gate rejected: ${message}`, {
      retryable: false,
      detail: { gateCode: code, requestId },
    });
  }
  // 审核不可用 / 理论库未就绪：按失败处理，不放行。
  if (code === "AUDIT_UNAVAILABLE" || code === "THEORY_NOT_READY" || code === "LLM_UNAVAILABLE") {
    return new ProviderFailedError(`gate "${providerId}" unavailable: ${code}: ${message}`, {
      retryable: true,
      detail: { gateCode: code, requestId },
    });
  }
  return new AgentxError(ErrorCode.PROVIDER_FAILED, `gate "${providerId}" error ${code}: ${message}`, {
    retryable: false,
    detail: { gateCode: code, requestId },
  });
}

export class GateProvider implements ModelProvider {
  readonly id: string;
  readonly models: ModelInfo[];
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly retryBaseMs: number;
  private readonly logger?: GateOptions["logger"];
  private readonly conversationId?: string;
  private callSeq = 0;

  constructor(options: GateOptions) {
    this.id = options.id;
    this.models = options.models;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.headers = options.headers ?? {};
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.logger = options.logger;
    this.conversationId = options.conversationId;
  }

  async generate(req: ModelRequest, opts: { signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const signal = opts.signal;
    if (signal?.aborted) throw new TaskCancelledError();

    const toolNames = req.tools.map((t) => t.name);
    const messages = encodeMessages(req.messages);
    if (req.tools.length > 0) {
      messages.unshift({ role: "system", content: buildToolProtocolPrompt(req.tools) });
    }

    const body = {
      messages,
      metadata: {
        ...(this.conversationId ? { conversation_id: this.conversationId } : {}),
        client: "agentx",
        model: req.model,
        tools_enabled: req.tools.length > 0,
      },
    };

    const attempts = this.maxRetries + 1;
    let lastError: AgentxError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new TaskCancelledError();
      try {
        return await this.attempt(body, toolNames, signal);
      } catch (err) {
        if (signal?.aborted) throw new TaskCancelledError();
        lastError =
          err instanceof AgentxError
            ? err
            : new ProviderFailedError(`gate "${this.id}" request failed: ${(err as Error).message}`, {
                retryable: true,
                cause: err,
              });
        if (!lastError.retryable) throw lastError;
        if (attempt >= attempts - 1) {
          throw new ProviderFailedError(
            `gate "${this.id}" failed after ${attempts} attempt(s): ${lastError.code}: ${lastError.message}`,
            { retryable: false, detail: { code: lastError.code }, cause: lastError },
          );
        }
        const delayMs = Math.round(this.retryBaseMs * 2 ** attempt);
        this.logger?.warn("gate.retry", { provider: this.id, attempt: attempt + 1, delayMs, reason: lastError.code });
        await sleep(delayMs, signal);
      }
    }
    throw lastError ?? new ProviderFailedError(`gate "${this.id}" failed`);
  }

  private async attempt(
    body: unknown,
    toolNames: string[],
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) throw new TaskCancelledError();
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new TaskTimeoutError(`gate "${this.id}" timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new TaskCancelledError();
      const reason = controller.signal.reason;
      if (reason instanceof TaskTimeoutError) {
        throw new ProviderFailedError(reason.message, { retryable: true, cause: err });
      }
      throw new ProviderFailedError(`gate "${this.id}" network error: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }

    const text = await res.text();
    if (res.status === 429) {
      throw new ProviderFailedError(`gate "${this.id}" rate limited (HTTP 429)`, {
        retryable: true,
        detail: { status: 429 },
      });
    }
    if (!res.ok) {
      throw new ProviderFailedError(`gate "${this.id}" responded with HTTP ${res.status}`, {
        retryable: res.status >= 500,
        detail: { status: res.status, body: text.slice(0, 300) },
      });
    }

    let payload: GateResponse;
    try {
      payload = JSON.parse(text) as GateResponse;
    } catch (err) {
      throw new ProviderBadResponseError(`gate "${this.id}" returned non-JSON body`, { cause: err });
    }

    const requestId = payload.request_id ?? null;
    const failure = toAgentxError(this.id, payload, requestId);
    if (failure) throw failure;
    if (payload.success === false) {
      throw new ProviderFailedError(
        `gate "${this.id}" returned success=false without error code`,
        { retryable: false, detail: { requestId } },
      );
    }

    const content = payload.data?.content;
    if (typeof content !== "string") {
      throw new ProviderBadResponseError(`gate "${this.id}" response missing data.content`, {
        detail: { requestId },
      });
    }

    this.callSeq += 1;
    const parsed = parseToolReply(content, toolNames, this.callSeq);
    if (parsed) {
      const response: ModelResponse = { type: "tool_calls", calls: [parsed.call], raw: payload };
      if (parsed.text !== undefined) response.text = parsed.text;
      return response;
    }
    const response: ModelResponse = { type: "final", text: content, raw: payload };
    return response;
  }
}
