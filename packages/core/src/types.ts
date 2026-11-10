import type { ZodType } from "zod";
import type { ErrorCode } from "./errors.js";

// ---------- 消息 / 模型协议 ----------
export type Role = "system" | "user" | "assistant" | "tool";
export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string; // role="tool" 时必填
  toolCalls?: ToolCall[]; // role="assistant" 时为模型请求的工具调用
  /**
   * 该消息对应的任务被治理拒绝（POLICY_DENIED）。
   *
   * 被拒的输入必须留在会话里（用户能看到自己问过什么、审计能对上号），但**不能**
   * 再进入后续轮次的模型上下文：否则模型下一轮会重述被拒内容并解释为什么拒绝，
   * 用户问的却是另一件事。gate 侧还会把它重新送审，白白消耗审核调用。
   */
  refused?: boolean;
  /**
   * 该轮门禁要求用户补充信息（结论 5，NEED_MORE_INFO）—— **不是**被拒绝。
   *
   * 带此标记的轮次**必须保留在上下文里**（不能被 dropRefusedTurns/refused 剔除），
   * 否则用户回答追问后模型接不上：它看不到自己问过什么，回答会被当成新话题的开场。
   * 与 `refused` 互斥语义：refused 表示内容被裁决拦截、不得再入上下文；
   * needMoreInfo 表示这一轮需要用户继续输入，上下文必须续接。
   */
  needMoreInfo?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[]; // 空数组表示不提供工具
  temperature?: number;
  maxTokens?: number;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema
}

export type ModelResponse =
  | { type: "final"; text: string; usage?: ModelUsage; raw?: unknown }
  | { type: "tool_calls"; calls: ToolCall[]; text?: string; usage?: ModelUsage; raw?: unknown };

export interface ModelProvider {
  readonly id: string;
  readonly models: ModelInfo[];
  generate(req: ModelRequest, opts?: { signal?: AbortSignal }): Promise<ModelResponse>;
}
export interface ModelInfo {
  id: string;
  contextLimit?: number;
  supportsTools: boolean;
}

// ---------- 任务 ----------
export type TaskStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export type TerminationReason =
  | "completed"
  | "max_steps"
  | "timeout"
  | "cancelled"
  | "provider_failed"
  | "tool_failed"
  | "budget_exceeded"
  | "policy_denied";
export interface AgentRequest {
  taskId: string;
  sessionId: string;
  input: string;
  cwd: string;
  model: string;
  maxSteps: number;
  timeoutMs: number;
  readOnly: boolean;
  history?: ChatMessage[];
}
export interface AgentResult {
  taskId: string;
  sessionId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  terminationReason: TerminationReason;
  finalText: string;
  steps: number;
  usage: ModelUsage; // 累加值，无 usage 的步按 0 计
  messages: ChatMessage[]; // 本次任务产生的全部新消息（不含 history 前缀）
  errorCode?: ErrorCode;
  errorSummary?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// ---------- 工具 ----------
export type RiskLevel = "low" | "medium" | "high";

/** 结构化日志接口（与 pino 的调用形式兼容）。 */
export interface Logger {
  debug(m: string, o?: unknown): void;
  info(m: string, o?: unknown): void;
  warn(m: string, o?: unknown): void;
  error(m: string, o?: unknown): void;
  /** 等待所有异步日志落盘；进程退出前必须调用，否则末尾记录可能丢失。 */
  flush?(): void;
}

export interface ToolContext {
  taskId: string;
  cwd: string;
  signal: AbortSignal;
  readOnly: boolean;
  approved: boolean;
  logger: Logger;
  env: Record<string, string>; // 白名单过滤后的环境变量
}
export interface ToolResult {
  ok: boolean;
  content: string; // 回填给模型的文本
  error?: string;
  metadata?: {
    bytes?: number;
    truncated?: boolean;
    exitCode?: number;
    durationMs?: number;
    [k: string]: unknown;
  };
}
export interface AgentTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  riskLevel: RiskLevel;
  readOnly: boolean; // 该工具本身是否无副作用
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
