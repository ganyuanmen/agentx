import { AgentxError, ErrorCode } from "./errors.js";
import { redactObject } from "./logger.js";

/** 安全的 JSON 序列化：无法序列化时退回字符串描述，绝不抛错。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

export interface SessionStoreLike {
  ensureSession(sessionId: string, cwd: string): Promise<void> | void;
  appendMessage(sessionId: string, message: import("./types.js").ChatMessage): Promise<void> | void;
  getHistory(sessionId: string): Promise<import("./types.js").ChatMessage[]> | import("./types.js").ChatMessage[];
}

export interface TaskRecordLike {
  taskId: string;
  sessionId: string;
  status: string;
  model: string;
  input: string;
  createdAt: string;
  /** 任务终止原因（PM_SPEC §5.2 / §12），结束时写入。 */
  terminationReason?: string;
  /** 终止错误码，成功时为 undefined。 */
  errorCode?: string;
  updatedAt?: string;
}

export interface TaskStoreLike {
  createTask(task: { taskId: string; sessionId: string; input: string; model: string }): Promise<void> | void;
  updateStatus(taskId: string, status: string, extra?: { terminationReason?: string; errorCode?: string }): Promise<void> | void;
  recordToolCall?(
    taskId: string,
    call: {
      callId: string;
      name: string;
      ok: boolean;
      durationMs?: number;
      argumentsJson?: string;
      resultJson?: string;
    },
  ): Promise<void> | void;
}

/** 内存 session 存储（未注入真实存储时使用）。 */
export class InMemorySessionStore implements SessionStoreLike {
  readonly sessions = new Map<string, import("./types.js").ChatMessage[]>();

  ensureSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
  }

  appendMessage(sessionId: string, message: import("./types.js").ChatMessage): void {
    this.ensureSession(sessionId);
    this.sessions.get(sessionId)!.push(structuredClone(message));
  }

  getHistory(sessionId: string): import("./types.js").ChatMessage[] {
    return structuredClone(this.sessions.get(sessionId) ?? []);
  }
}

/** 内存 task 存储（未注入真实存储时使用）。 */
export class InMemoryTaskStore implements TaskStoreLike {
  readonly tasks = new Map<string, TaskRecordLike>();

  createTask(task: { taskId: string; sessionId: string; input: string; model: string }): void {
    this.tasks.set(task.taskId, {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: "created",
      model: task.model,
      input: task.input,
      createdAt: new Date().toISOString(),
    });
  }

  updateStatus(
    taskId: string,
    status: string,
    extra?: { terminationReason?: string; errorCode?: string },
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentxError(ErrorCode.INTERNAL, `task not found: ${taskId}`);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (extra) Object.assign(task, extra);
  }
}

export interface AgentRuntimeOptions {
  sessionStore?: SessionStoreLike;
  taskStore?: TaskStoreLike;
  logger: import("./types.js").Logger;
  run: (
    request: import("./types.js").AgentRequest,
    signal: AbortSignal,
    hooks: {
      onStart: () => void;
      onStepStart: (step: number) => void;
      onApprovalStateChange: (state: "waiting" | "resolved") => void;
      onToolCall: (info: {
        callId: string;
        name: string;
        ok: boolean;
        durationMs: number;
        arguments: unknown;
        result: unknown;
      }) => void;
    },
  ) => Promise<import("./types.js").AgentResult>;
}

export interface RuntimeRunInput {
  taskId: string;
  sessionId: string;
  input: string;
  cwd: string;
  model: string;
  maxSteps: number;
  timeoutMs: number;
  readOnly: boolean;
  history?: import("./types.js").ChatMessage[];
}

/** 编排 session / task / loop：写入 user 消息、维护 task 状态、持久化结果。 */
export class AgentRuntime {
  private readonly sessionStore: SessionStoreLike;
  private readonly taskStore: TaskStoreLike;
  private readonly logger: import("./types.js").Logger;
  private readonly runFn: AgentRuntimeOptions["run"];

  constructor(options: AgentRuntimeOptions) {
    this.logger = options.logger;
    this.runFn = options.run;
    if (!options.sessionStore) {
      this.logger.warn("runtime.session_store.missing", { fallback: "in-memory" });
    }
    if (!options.taskStore) {
      this.logger.warn("runtime.task_store.missing", { fallback: "in-memory" });
    }
    this.sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.taskStore = options.taskStore ?? new InMemoryTaskStore();
  }

  getStore(): { sessionStore: SessionStoreLike; taskStore: TaskStoreLike } {
    return { sessionStore: this.sessionStore, taskStore: this.taskStore };
  }

  async run(input: RuntimeRunInput, signal: AbortSignal = new AbortController().signal): Promise<import("./types.js").AgentResult> {
    const request: import("./types.js").AgentRequest = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      input: input.input,
      cwd: input.cwd,
      model: input.model,
      maxSteps: input.maxSteps,
      timeoutMs: input.timeoutMs,
      readOnly: input.readOnly,
      history: input.history,
    };

    await this.sessionStore.ensureSession(request.sessionId, request.cwd);
    const history =
      input.history ??
      (await this.sessionStore.getHistory(request.sessionId)).filter((m) => m.role !== "system");
    request.history = history;

    await this.taskStore.createTask({
      taskId: request.taskId,
      sessionId: request.sessionId,
      input: request.input,
      model: request.model,
    });

    const userMsg: import("./types.js").ChatMessage = { role: "user", content: request.input };
    await this.sessionStore.appendMessage(request.sessionId, userMsg);

    await this.taskStore.updateStatus(request.taskId, "running");
    this.logger.info("task.created", { taskId: request.taskId, sessionId: request.sessionId });
    const approvals: Array<{ state: "waiting" | "resolved" }> = [];
    let result: import("./types.js").AgentResult;
    try {
      result = await this.runFn(request, signal, {
        onStart: () => {
          // task 已置为 running
        },
        onStepStart: () => {
          // 审批结束后从 waiting_approval 回到 running
          if (approvals.length > 0 && approvals[approvals.length - 1]?.state === "resolved") {
            void this.taskStore.updateStatus(request.taskId, "running");
            approvals.push({ state: "resolved" });
          }
        },
        onToolCall: (info) => {
          void this.taskStore.recordToolCall?.(request.taskId, {
            callId: info.callId,
            name: info.name,
            ok: info.ok,
            durationMs: info.durationMs,
            // 存储层按 *_json 字段落库；这里序列化一次，避免存成 [object Object]。
            argumentsJson: safeJson(info.arguments),
            resultJson: safeJson(info.result),
          });
        },
        onApprovalStateChange: (state) => {
          approvals.push({ state });
          if (state === "waiting") {
            void this.taskStore.updateStatus(request.taskId, "waiting_approval");
          } else {
            void this.taskStore.updateStatus(request.taskId, "running");
          }
        },
      });
    } catch (err) {
      // loop 约定不抛出；防御性兜底，保证 task 行落库。
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("runtime.loop.crashed", { taskId: request.taskId, message });
      // 内部崩溃不是工具失败：终止原因必须如实反映"框架内部错误"，
      // 否则运维会按"工具不可用"方向排查，方向错误。
      await this.taskStore.updateStatus(request.taskId, "failed", {
        terminationReason: "provider_failed",
        errorCode: ErrorCode.INTERNAL,
      });
      throw new AgentxError(ErrorCode.INTERNAL, `agent loop crashed: ${message}`, { cause: err });
    }

    // result.messages 的首条就是本次的 user 输入（已在上面写入过一次），
    // 从第 2 条开始才是本轮新增的 assistant / tool 消息，必须去重后再落库。
    const newMessages = result.messages.filter(
      (msg, idx) => !(idx === 0 && msg.role === "user" && msg.content === request.input),
    );
    for (const msg of newMessages) {
      await this.sessionStore.appendMessage(request.sessionId, msg);
    }
    await this.taskStore.updateStatus(request.taskId, result.status, {
      terminationReason: result.terminationReason,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
    this.logger.info("task.end", {
      taskId: request.taskId,
      status: result.status,
      terminationReason: result.terminationReason,
      steps: result.steps,
      durationMs: result.durationMs,
      tokenUsage: redactObject(result.usage),
    });
    return result;
  }
}
