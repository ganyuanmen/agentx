import {
  AgentxError,
  ErrorCode,
  ProviderBadResponseError,
  ProviderFailedError,
  TaskCancelledError,
  TaskTimeoutError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type Role,
  type ToolCall,
} from "@agentx/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: ModelInfo[];
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** 环境变量来源（默认 process.env）；只读取 apiKeyEnv 指定的键。 */
  env?: NodeJS.ProcessEnv;
  /** 额外请求头。 */
  headers?: Record<string, string>;
  /** 退避基数（毫秒），默认 500。测试可注入 0。 */
  retryBaseMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  logger?: { debug(m: string, o?: unknown): void; warn(m: string, o?: unknown): void };
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TaskCancelledError());
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new TaskCancelledError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mapUsage(usage: OpenAiResponse["usage"]): ModelUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

function toOpenAiMessages(messages: ModelRequest["messages"]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const role: Role = m.role;
    const out: Record<string, unknown> = { role, content: m.content };
    if (role === "tool") {
      out.tool_call_id = m.toolCallId ?? "";
    }
    if (role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }));
    }
    return out;
  });
}

/** OpenAI 兼容的 Chat Completions provider（含超时、重试与错误分类）。 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly models: ModelInfo[];
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly retryBaseMs: number;
  private readonly onRetry?: OpenAiCompatibleOptions["onRetry"];
  private readonly logger?: OpenAiCompatibleOptions["logger"];

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.models = options.models;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const env = options.env ?? process.env;
    const fromEnv = options.apiKeyEnv ? env[options.apiKeyEnv] : undefined;
    this.apiKey = options.apiKey ?? (fromEnv && fromEnv.trim() !== "" ? fromEnv : undefined);
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.headers = options.headers ?? {};
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.onRetry = options.onRetry;
    this.logger = options.logger;
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  async generate(req: ModelRequest, opts: { signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const signal = opts.signal;
    if (signal?.aborted) throw new TaskCancelledError();

    const body = {
      model: req.model,
      messages: toOpenAiMessages(req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };

    const attempts = this.maxRetries + 1;
    let lastError: AgentxError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new TaskCancelledError();
      try {
        return await this.attempt(body, signal);
      } catch (err) {
        if (signal?.aborted) throw new TaskCancelledError();
        if (!(err instanceof AgentxError)) {
          lastError = new ProviderFailedError(`provider "${this.id}" request failed: ${(err as Error).message}`, {
            retryable: true,
            cause: err,
          });
        } else {
          lastError = err;
        }
        if (!lastError.retryable) throw lastError;
        const isLast = attempt >= attempts - 1;
        if (isLast) {
          throw new ProviderFailedError(
            `provider "${this.id}" failed after ${attempts} attempt(s): ${lastError.code}: ${lastError.message}`,
            { retryable: false, detail: { code: lastError.code }, cause: lastError },
          );
        }
        const delayMs = Math.round(this.retryBaseMs * 2 ** attempt + Math.random() * this.retryBaseMs);
        this.onRetry?.({ attempt: attempt + 1, delayMs, reason: lastError.code });
        this.logger?.warn("provider.retry", {
          provider: this.id,
          attempt: attempt + 1,
          delayMs,
          reason: lastError.code,
        });
        try {
          await sleep(delayMs, signal);
        } catch {
          throw new TaskCancelledError();
        }
      }
    }
    throw lastError ?? new ProviderFailedError(`provider "${this.id}" failed`);
  }

  private async attempt(body: unknown, signal?: AbortSignal): Promise<ModelResponse> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) throw new TaskCancelledError();
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new TaskTimeoutError(`provider "${this.id}" timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new TaskCancelledError();
      const timeoutErr = controller.signal.reason;
      if (timeoutErr instanceof TaskTimeoutError) {
        throw new ProviderFailedError(timeoutErr.message, { retryable: true, cause: err });
      }
      throw new ProviderFailedError(`provider "${this.id}" network error: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }

    if (!res.ok) {
      throw new ProviderFailedError(`provider "${this.id}" responded with HTTP ${res.status}`, {
        retryable: RETRYABLE_STATUS(res.status),
        detail: { status: res.status },
      });
    }

    let payload: OpenAiResponse;
    try {
      payload = (await res.json()) as OpenAiResponse;
    } catch (err) {
      throw new ProviderBadResponseError(`provider "${this.id}" returned non-JSON body`, { cause: err });
    }
    return this.parseResponse(payload);
  }

  parseResponse(payload: OpenAiResponse): ModelResponse {
    const choice = payload.choices?.[0];
    if (!choice || !choice.message) {
      throw new ProviderBadResponseError(`provider "${this.id}" response missing choices[0].message`);
    }
    const usage = mapUsage(payload.usage);
    const message = choice.message;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls: ToolCall[] = [];
      for (const raw of message.tool_calls) {
        const name = raw.function?.name;
        if (!name) {
          throw new ProviderBadResponseError(`provider "${this.id}" returned a tool_call without function.name`);
        }
        const rawArgs = raw.function?.arguments;
        const text = rawArgs === undefined || rawArgs === "" ? "{}" : rawArgs;
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(text);
        } catch (err) {
          throw new ProviderBadResponseError(
            `provider "${this.id}" returned tool_call "${name}" with invalid JSON arguments`,
            { cause: err },
          );
        }
        calls.push({
          id: raw.id ?? `call_${calls.length}`,
          name,
          arguments: parsedArgs,
        });
      }
      const response: ModelResponse = { type: "tool_calls", calls, raw: payload };
      if (typeof message.content === "string" && message.content !== "") response.text = message.content;
      if (usage) response.usage = usage;
      return response;
    }
    const response: ModelResponse = { type: "final", text: message.content ?? "", raw: payload };
    if (usage) response.usage = usage;
    return response;
  }
}

export { AgentxError, ErrorCode };
