import {
  AgentxError,
  ErrorCode,
  TaskCancelledError,
  ToolTimeoutError,
  toAgentxError,
  type AgentTool,
  type Logger,
  type ToolContext,
  type ToolExecutorLike,
  type ToolResult,
} from "@agentx/core";

export interface ToolExecutorOptions {
  logger: Logger;
  /** 单个工具的兜底超时（毫秒）；0/未设置表示不额外限时。 */
  toolTimeoutMs?: number;
}

const DEFAULT_TOOL_TIMEOUT_MS = 0;

function isCancelled(err: unknown): boolean {
  return err instanceof AgentxError && err.code === ErrorCode.CANCELLED;
}

/**
 * 真实 ToolExecutor：
 * - 不做授权（policy 在外层）
 * - 测量 durationMs 并写入 metadata
 * - 工具抛出的异常（除取消外）转成 { ok:false, error:"<code>: <message>" }，不冒泡
 */
export function createToolExecutor(options: ToolExecutorOptions): ToolExecutorLike {
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const logger = options.logger;

  return {
    async execute(tool: AgentTool, input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const startedAt = Date.now();
      const withDuration = (result: ToolResult): ToolResult => ({
        ...result,
        metadata: { ...(result.metadata ?? {}), durationMs: Date.now() - startedAt },
      });

      try {
        let result: ToolResult;
        if (toolTimeoutMs > 0) {
          result = await withTimeout(tool.execute(input, ctx), toolTimeoutMs, tool.name, ctx.signal);
        } else {
          result = await guardCancellation(tool.execute(input, ctx), ctx.signal);
        }
        if (ctx.signal.aborted && !result.ok) {
          throw new TaskCancelledError();
        }
        return withDuration(result);
      } catch (err) {
        if (isCancelled(err) || (ctx.signal.aborted && !(err instanceof ToolTimeoutError))) {
          throw new TaskCancelledError();
        }
        const axErr = toAgentxError(err);
        logger.warn("tool.executor.error", { tool: tool.name, errorCode: axErr.code, toolTaskId: ctx.taskId });
        return withDuration({
          ok: false,
          content: "",
          error: `${axErr.code}: ${axErr.message}`,
        });
      }
    },
  };
}

/** 任务取消时立刻返回 CANCELLED，而不是等工具自己结束。 */
function guardCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new TaskCancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new TaskCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new TaskCancelledError()));
    const timer = setTimeout(
      () => finish(() => reject(new ToolTimeoutError(`tool "${toolName}" exceeded ${timeoutMs}ms`))),
      Math.max(1, timeoutMs),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e)),
    );
  });
}
