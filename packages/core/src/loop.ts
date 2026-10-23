import { ContextBuilder } from "./context.js";
import {
  AgentxError,
  ApprovalRequiredError,
  BudgetExceededError,
  ErrorCode,
  InvalidToolArgsError,
  MaxStepsExceededError,
  PolicyDeniedError,
  ReadOnlyViolationError,
  TaskCancelledError,
  TaskTimeoutError,
  ToolLimitExceededError,
  UnknownToolError,
  toAgentxError,
} from "./errors.js";
import { assistantMessage, toolResultMessage, userMessage } from "./messages.js";
import type {
  AgentRequest,
  AgentResult,
  AgentTool,
  ChatMessage,
  Logger,
  ModelProvider,
  ModelUsage,
  TerminationReason,
  ToolCall,
  ToolContext,
  ToolResult,
} from "./types.js";

export interface ContextBuilderLike {
  /** turn 为本任务已产生的消息（含工具调用与结果），必须并入请求上下文。 */
  build(
    request: AgentRequest,
    turn?: import("./types.js").ChatMessage[],
  ): import("./types.js").ModelRequest;
}

export interface ToolRegistryLike {
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
}

export interface PolicyAuthorizeArgs {
  request: AgentRequest;
  tool: AgentTool;
  input: unknown;
}

export interface PolicyDecision {
  needApproval: boolean;
  prompt?: string;
}

export interface PolicyLike {
  authorize(args: PolicyAuthorizeArgs): Promise<PolicyDecision>;
}

export interface ApprovalRequest {
  toolName: string;
  riskLevel: string;
  summary: string;
  input: unknown;
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>;

export interface ToolExecutorLike {
  execute(tool: AgentTool, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface AgentLoopDeps {
  provider: ModelProvider;
  contextBuilder: ContextBuilderLike;
  tools: ToolRegistryLike;
  policy: PolicyLike;
  executor: ToolExecutorLike;
  logger: Logger;
  clock?: () => number;
  approval?: Approver;
  /** 是否可交互审批；false 时需审批即 APPROVAL_REQUIRED 失败。缺省 true。 */
  interactive?: boolean;
  /** 工具总调用次数上限；0 或缺省表示不限制。 */
  maxToolCalls?: number;
  /** 累计 usage.totalTokens 上限；0 或缺省表示不限制。 */
  maxTotalTokens?: number;
  /**
   * 达到 maxSteps 后是否再补一次「仅总结、不给工具」的收尾轮。
   * 缺省 true：用它把已完成的探索换成一段可读的结论，而不是直接丢弃。
   * 收尾轮的模型调用不计入 steps，但计入 usage；它同样受 timeoutMs 约束。
   */
  finalizeOnMaxSteps?: boolean;
  /** 审批状态变更通知（Runtime 用于写 waiting_approval）。 */
  onApprovalStateChange?: (state: "waiting" | "resolved", req: ApprovalRequest) => void;
  /** 每一步模型调用前通知（Runtime 用于写 running 状态）。 */
  onStepStart?: (step: number) => void;
  /**
   * 每一步模型调用结束后上报**该步**的 usage（不是累计值）。
   * chat 状态栏用它算「当前上下文占用」：累计值在 multi-step 任务里会重复计数。
   */
  onStepEnd?: (info: { step: number; usage: ModelUsage; responseType: "final" | "tool_calls" }) => void;
  /** 任务初始化完成后的回调。 */
  onStart?: () => void;
  /** 每个工具执行结束后的回调（Runtime 用于把 tool_calls 落库）。 */
  onToolCall?: (info: {
    callId: string;
    name: string;
    ok: boolean;
    durationMs: number;
    arguments: unknown;
    result: ToolResult;
  }) => void;
}

const ZERO_USAGE: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * 达到步数上限后的收尾指令。工具在这一轮被禁用，
 * 因此措辞必须明确「不要再请求工具、直接用已有信息作答」。
 */
const MAX_STEPS_FINALIZE_PROMPT =
  "You have reached the step limit for this task and no further tool calls are available. " +
  "Do not request any more tools. Using only the information already gathered above, " +
  "answer the user's request now with your best conclusion: state what you found, " +
  "what you could not determine, and what the next step would be. Answer directly, with no tool calls.";

export function addUsage(a: ModelUsage, b?: ModelUsage): ModelUsage {
  if (!b) return { ...a };
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, "failed" | "cancelled" | "timed_out">> = {
  [ErrorCode.CANCELLED]: "cancelled",
  [ErrorCode.TIMEOUT]: "timed_out",
  [ErrorCode.MAX_STEPS_EXCEEDED]: "failed",
  [ErrorCode.BUDGET_EXCEEDED]: "failed",
  [ErrorCode.UNKNOWN_TOOL]: "failed",
  [ErrorCode.INVALID_TOOL_ARGS]: "failed",
  [ErrorCode.POLICY_DENIED]: "failed",
  [ErrorCode.READ_ONLY_VIOLATION]: "failed",
  [ErrorCode.APPROVAL_REQUIRED]: "failed",
  [ErrorCode.TOOL_LIMIT_EXCEEDED]: "failed",
  [ErrorCode.PROVIDER_FAILED]: "failed",
  [ErrorCode.PROVIDER_BAD_RESPONSE]: "failed",
  [ErrorCode.TOOL_FAILED]: "failed",
};

const REASON_BY_CODE: Partial<Record<ErrorCode, TerminationReason>> = {
  [ErrorCode.CANCELLED]: "cancelled",
  [ErrorCode.TIMEOUT]: "timeout",
  [ErrorCode.MAX_STEPS_EXCEEDED]: "max_steps",
  [ErrorCode.BUDGET_EXCEEDED]: "budget_exceeded",
  [ErrorCode.POLICY_DENIED]: "policy_denied",
  [ErrorCode.READ_ONLY_VIOLATION]: "policy_denied",
  [ErrorCode.APPROVAL_REQUIRED]: "policy_denied",
  [ErrorCode.PROVIDER_FAILED]: "provider_failed",
  [ErrorCode.PROVIDER_BAD_RESPONSE]: "provider_failed",
  [ErrorCode.TOOL_FAILED]: "tool_failed",
  [ErrorCode.TOOL_LIMIT_EXCEEDED]: "tool_failed",
  [ErrorCode.UNKNOWN_TOOL]: "tool_failed",
  [ErrorCode.INVALID_TOOL_ARGS]: "tool_failed",
};

export function statusForErrorCode(
  code: ErrorCode,
): "failed" | "cancelled" | "timed_out" {
  const status = STATUS_BY_CODE[code];
  if (status === "cancelled" || status === "timed_out") return status;
  return "failed";
}

export function reasonForErrorCode(code: ErrorCode): TerminationReason {
  return REASON_BY_CODE[code] ?? "tool_failed";
}

function formatZodIssues(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return err instanceof Error ? err.message : String(err);
  }
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).join(".");
      return path ? `${path}: ${issue.message ?? "invalid"}` : (issue.message ?? "invalid");
    })
    .join("; ");
}

function isZodError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Agent Loop（PM_SPEC §5.1）。纯逻辑：不读写存储，不打印；
 * 所有异常都转换为 AgentResult 返回，绝不向调用方抛出。
 */
export async function runAgent(
  request: AgentRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentResult> {
  const clock = deps.clock ?? Date.now;
  const startedMs = clock();
  const startedAt = new Date(startedMs).toISOString();
  const logger = deps.logger;

  const messages: ChatMessage[] = [];
  let usage: ModelUsage = { ...ZERO_USAGE };
  let steps = 0;
  let toolCalls = 0;

  const finish = (
    status: AgentResult["status"],
    terminationReason: TerminationReason,
    finalText: string,
    err?: AgentxError,
  ): AgentResult => {
    const finishedMs = clock();
    const result: AgentResult = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      status,
      terminationReason,
      finalText,
      steps,
      usage,
      messages: [...messages],
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: Math.max(0, finishedMs - startedMs),
    };
    if (err) {
      result.errorCode = err.code;
      result.errorSummary = err.message;
    }
    logger.info("task.termination", {
      taskId: request.taskId,
      status,
      reason: terminationReason,
      steps,
      errorCode: err?.code,
    });
    return result;
  };

  const failWith = (err: AgentxError): AgentResult => {
    logger.warn("task.error", { taskId: request.taskId, errorCode: err.code, message: err.message });
    return finish(statusForErrorCode(err.code), reasonForErrorCode(err.code), "", err);
  };

  const elapsed = (): number => clock() - startedMs;

  /**
   * 达到 maxSteps 后的收尾轮：禁止调用工具，要求模型用已有信息作答。
   * 返回最终文本；模型仍坚持调工具、或返回空文本时返回 undefined，
   * 由调用方按 max_steps 失败处理。
   */
  const finalizeAfterMaxSteps = async (): Promise<string | undefined> => {
    messages.push(userMessage(MAX_STEPS_FINALIZE_PROMPT));
    const modelRequest = deps.contextBuilder.build(request, messages.slice());
    logger.info("task.finalize_start", { taskId: request.taskId, maxSteps: request.maxSteps });
    const modelStart = clock();
    try {
      const response = await withTimeout(
        deps.provider.generate({ ...modelRequest, tools: [] }, { signal }),
        request.timeoutMs > 0 ? request.timeoutMs - elapsed() : 0,
        () => new TaskTimeoutError(`task exceeded timeout of ${request.timeoutMs}ms`),
        signal,
      );
      usage = addUsage(usage, response.usage);
      logger.info("task.finalize_end", {
        taskId: request.taskId,
        durationMs: clock() - modelStart,
        responseType: response.type,
        tokenUsage: response.usage ?? { ...ZERO_USAGE },
      });
      if (response.type !== "final") {
        logger.warn("task.finalize_rejected", {
          taskId: request.taskId,
          reason: "model returned tool calls while tools were disabled",
        });
        return undefined;
      }
      const text = response.text?.trim();
      if (!text) {
        logger.warn("task.finalize_rejected", { taskId: request.taskId, reason: "empty text" });
        return undefined;
      }
      messages.push(assistantMessage(text));
      return text;
    } catch (err) {
      // 收尾轮本身失败（超时/取消/网络）不改变终止语义：仍按 max_steps 结束。
      logger.warn("task.finalize_failed", {
        taskId: request.taskId,
        errorCode: err instanceof AgentxError ? err.code : undefined,
        message: errorMessage(err),
      });
      return undefined;
    }
  };

  try {
    deps.onStart?.();
    logger.info("task.start", {
      taskId: request.taskId,
      sessionId: request.sessionId,
      model: request.model,
      maxSteps: request.maxSteps,
      timeoutMs: request.timeoutMs,
      readOnly: request.readOnly,
    });

    // 首轮：turn 只含本次 user 输入；后续轮由 build 时传入累积的 messages（含工具结果）。
    messages.push(userMessage(request.input));

    for (let step = 0; step < request.maxSteps; step++) {
      // 规则 2：每步开始检查取消与超时。
      if (signal.aborted) throw new TaskCancelledError();
      if (request.timeoutMs > 0 && elapsed() > request.timeoutMs) {
        throw new TaskTimeoutError(`task exceeded timeout of ${request.timeoutMs}ms`);
      }

      steps = step + 1;
      deps.onStepStart?.(steps);

      // 每步都用当前累积的本轮消息重新构建请求：模型必须看到本任务的工具调用与结果。
      const modelRequest = deps.contextBuilder.build(request, messages.slice());
      const modelStart = clock();
      logger.debug("model.start", { taskId: request.taskId, step: steps, model: modelRequest.model });
      let response;
      try {
        response = await withTimeout(
          deps.provider.generate(modelRequest, { signal }),
          request.timeoutMs > 0 ? request.timeoutMs - elapsed() : 0,
          () => new TaskTimeoutError(`task exceeded timeout of ${request.timeoutMs}ms`),
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw new TaskCancelledError();
        if (err instanceof AgentxError) throw err;
        throw new AgentxError(ErrorCode.PROVIDER_FAILED, `provider call failed: ${errorMessage(err)}`, {
          retryable: false,
          cause: err,
        });
      }
      usage = addUsage(usage, response.usage);
      deps.onStepEnd?.({
        step: steps,
        usage: response.usage ?? { ...ZERO_USAGE },
        responseType: response.type,
      });
      logger.info("model.end", {
        taskId: request.taskId,
        step: steps,
        durationMs: clock() - modelStart,
        tokenUsage: response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        responseType: response.type,
      });

      if (response.type === "final") {
        if (response.text) messages.push(assistantMessage(response.text));
        return finish("succeeded", "completed", response.text);
      }

      const calls: ToolCall[] = response.calls ?? [];
      messages.push(assistantMessage(response.text ?? "", calls));

      // 规则 5：多个工具调用按顺序串行执行，结果逐条回填。
      for (const call of calls) {
        if (signal.aborted) throw new TaskCancelledError();
        if (deps.maxToolCalls && deps.maxToolCalls > 0 && toolCalls >= deps.maxToolCalls) {
          throw new ToolLimitExceededError(`tool call limit of ${deps.maxToolCalls} exceeded`);
        }

        // 未知工具 -> 终止（规则 6）。
        const tool = deps.tools.get(call.name);
        if (!tool) throw new UnknownToolError(call.name);

        // Zod 参数校验 -> 终止（规则 7）。
        let input: unknown;
        try {
          input = tool.inputSchema.parse(call.arguments ?? {});
        } catch (err) {
          if (isZodError(err)) throw new InvalidToolArgsError(call.name, formatZodIssues(err));
          throw err;
        }

        // 策略（步骤 5）：POLICY_DENIED / READ_ONLY_VIOLATION / APPROVAL_REQUIRED 直接终止。
        const decision = await deps.policy.authorize({ request, tool, input });
        let approved = false;
        if (decision.needApproval) {
          const approvalRequest: ApprovalRequest = {
            toolName: tool.name,
            riskLevel: tool.riskLevel,
            summary: decision.prompt ?? `Approve ${tool.name} (${tool.riskLevel} risk)?`,
            input,
          };
          if (!deps.approval || deps.interactive === false) {
            throw new ApprovalRequiredError(
              `tool "${tool.name}" requires approval but no interactive approver is available`,
            );
          }
          deps.onApprovalStateChange?.("waiting", approvalRequest);
          logger.info("task.waiting_approval", { taskId: request.taskId, tool: tool.name });
          const ok = await deps.approval(approvalRequest);
          deps.onApprovalStateChange?.("resolved", approvalRequest);
          if (!ok) {
            throw new PolicyDeniedError(`approval rejected for tool "${tool.name}"`);
          }
          approved = true;
        }

        toolCalls++;
        const ctx: ToolContext = {
          taskId: request.taskId,
          cwd: request.cwd,
          signal,
          readOnly: request.readOnly,
          approved,
          logger,
          env: {},
        };

        const toolStart = clock();
        logger.info("tool.start", { taskId: request.taskId, step: steps, name: tool.name, callId: call.id });
        let result: ToolResult;
        try {
          result = await deps.executor.execute(tool, input, ctx);
        } catch (err) {
          // 工具抛异常（含 TOOL_TIMEOUT）转为失败结果回填，让模型自行纠正。
          const axErr = toAgentxError(err);
          if (axErr.code === ErrorCode.CANCELLED || signal.aborted) throw new TaskCancelledError();
          result = { ok: false, content: "", error: `${axErr.code}: ${axErr.message}` };
        }
        logger.info("tool.end", {
          taskId: request.taskId,
          step: steps,
          name: tool.name,
          callId: call.id,
          status: result.ok ? "ok" : "error",
          durationMs: clock() - toolStart,
        });

        // 把工具调用结果上报给 Runtime 落库（PM_SPEC §12：记录工具调用开始/结束）。
        deps.onToolCall?.({
          callId: call.id,
          name: tool.name,
          ok: result.ok,
          durationMs: clock() - toolStart,
          arguments: input,
          result,
        });

        messages.push(toolResultMessage(call.id, result));
      }

      // 规则 9：预算检查在本步 usage 累积后、下一模型调用前执行。
      if (deps.maxTotalTokens && deps.maxTotalTokens > 0 && usage.totalTokens > deps.maxTotalTokens) {
        throw new BudgetExceededError(
          `token budget exceeded: ${usage.totalTokens} > ${deps.maxTotalTokens}`,
        );
      }
    }

    // 规则 8：达到 maxSteps。
    // 先给模型一次「仅总结」的收尾机会（不给工具），把已完成的探索转成可读结论；
    // 拿不到可用答复时仍按 max_steps 失败，语义与终止原因保持不变。
    if (deps.finalizeOnMaxSteps !== false) {
      const summary = await finalizeAfterMaxSteps();
      if (summary !== undefined) return finish("succeeded", "completed", summary);
    }
    throw new MaxStepsExceededError(`max steps (${request.maxSteps}) exceeded`);
  } catch (err) {
    if (signal.aborted && !(err instanceof AgentxError && err.code === ErrorCode.TIMEOUT)) {
      return failWith(new TaskCancelledError());
    }
    if (err instanceof AgentxError) return failWith(err);
    return failWith(toAgentxError(err));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 竞速：超时、取消或原 promise 完成。timeoutMs<=0 表示不额外限时。 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0 && !signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(onTimeout())),
      timeoutMs > 0 ? Math.max(1, timeoutMs) : 2 ** 31 - 1,
    );
    const onAbort = (): void => done(() => reject(new TaskCancelledError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => done(() => resolve(v)),
      (e: unknown) => done(() => reject(e)),
    );
  });
}

export { ContextBuilder };
