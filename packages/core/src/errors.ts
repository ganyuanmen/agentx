export const ErrorCode = {
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  INVALID_TOOL_ARGS: "INVALID_TOOL_ARGS",
  POLICY_DENIED: "POLICY_DENIED",
  READ_ONLY_VIOLATION: "READ_ONLY_VIOLATION",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  PATH_ESCAPE: "PATH_ESCAPE",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_FAILED: "TOOL_FAILED",
  TOOL_LIMIT_EXCEEDED: "TOOL_LIMIT_EXCEEDED",
  MAX_STEPS_EXCEEDED: "MAX_STEPS_EXCEEDED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  PROVIDER_BAD_RESPONSE: "PROVIDER_BAD_RESPONSE",
  CONFIG_INVALID: "CONFIG_INVALID",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AgentxErrorOptions {
  retryable?: boolean;
  detail?: unknown;
  cause?: unknown;
}

/** 框架内所有可分类错误的基类。 */
export class AgentxError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, options: AgentxErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export class TaskCancelledError extends AgentxError {
  constructor(message = "task cancelled by user", options: AgentxErrorOptions = {}) {
    super(ErrorCode.CANCELLED, message, options);
  }
}

export class TaskTimeoutError extends AgentxError {
  constructor(message = "task timed out", options: AgentxErrorOptions = {}) {
    super(ErrorCode.TIMEOUT, message, options);
  }
}

export class MaxStepsExceededError extends AgentxError {
  constructor(message = "max steps exceeded", options: AgentxErrorOptions = {}) {
    super(ErrorCode.MAX_STEPS_EXCEEDED, message, options);
  }
}

export class UnknownToolError extends AgentxError {
  readonly toolName: string;
  constructor(toolName: string, options: AgentxErrorOptions = {}) {
    super(ErrorCode.UNKNOWN_TOOL, `unknown tool: ${toolName}`, options);
    this.toolName = toolName;
  }
}

export class InvalidToolArgsError extends AgentxError {
  readonly toolName: string;
  constructor(toolName: string, message: string, options: AgentxErrorOptions = {}) {
    super(ErrorCode.INVALID_TOOL_ARGS, `invalid arguments for tool "${toolName}": ${message}`, options);
    this.toolName = toolName;
  }
}

export class PolicyDeniedError extends AgentxError {
  constructor(message = "tool call denied by policy", options: AgentxErrorOptions = {}) {
    super(ErrorCode.POLICY_DENIED, message, options);
  }
}

export class ReadOnlyViolationError extends AgentxError {
  constructor(message = "tool has side effects but task is read-only", options: AgentxErrorOptions = {}) {
    super(ErrorCode.READ_ONLY_VIOLATION, message, options);
  }
}

export class ApprovalRequiredError extends AgentxError {
  constructor(message = "approval required but no interactive terminal", options: AgentxErrorOptions = {}) {
    super(ErrorCode.APPROVAL_REQUIRED, message, options);
  }
}

export class BudgetExceededError extends AgentxError {
  constructor(message = "token budget exceeded", options: AgentxErrorOptions = {}) {
    super(ErrorCode.BUDGET_EXCEEDED, message, options);
  }
}

export class ToolTimeoutError extends AgentxError {
  constructor(message = "tool execution timed out", options: AgentxErrorOptions = {}) {
    super(ErrorCode.TOOL_TIMEOUT, message, options);
  }
}

export class ToolFailedError extends AgentxError {
  constructor(message = "tool execution failed", options: AgentxErrorOptions = {}) {
    super(ErrorCode.TOOL_FAILED, message, options);
  }
}

export class ToolLimitExceededError extends AgentxError {
  constructor(message = "tool call limit exceeded", options: AgentxErrorOptions = {}) {
    super(ErrorCode.TOOL_LIMIT_EXCEEDED, message, options);
  }
}

export class ProviderFailedError extends AgentxError {
  constructor(message = "provider call failed", options: AgentxErrorOptions = {}) {
    super(ErrorCode.PROVIDER_FAILED, message, options);
  }
}

export class ProviderBadResponseError extends AgentxError {
  constructor(message = "provider returned a malformed response", options: AgentxErrorOptions = {}) {
    super(ErrorCode.PROVIDER_BAD_RESPONSE, message, options);
  }
}

export class ConfigInvalidError extends AgentxError {
  constructor(message: string, options: AgentxErrorOptions = {}) {
    super(ErrorCode.CONFIG_INVALID, message, options);
  }
}

export class IllegalStateTransitionError extends AgentxError {
  constructor(from: string, to: string) {
    super(ErrorCode.ILLEGAL_STATE_TRANSITION, `illegal task state transition: ${from} -> ${to}`);
  }
}

/** 把任意 unknown 异常转换为 AgentxError；非 AgentxError 包装为 INTERNAL。 */
export function toAgentxError(err: unknown): AgentxError {
  if (err instanceof AgentxError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentxError(ErrorCode.INTERNAL, message || "internal error", { cause: err });
}
