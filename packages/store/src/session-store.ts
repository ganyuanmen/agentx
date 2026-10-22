import {
  AgentxError,
  ErrorCode,
  IllegalStateTransitionError,
  type ChatMessage,
  type SessionStoreLike,
  type TaskStoreLike,
  type ToolCall,
} from "@agentx/core";
import { migrate, openDatabase, type SqliteDatabase } from "./db.js";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
}

export interface TaskRow {
  taskId: string;
  sessionId: string;
  status: string;
  model: string;
  input: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  terminationReason: string | undefined;
  errorCode: string | undefined;
  errorSummary: string | undefined;
  steps: number | undefined;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
}

export interface ToolCallRow {
  id: number;
  taskId: string;
  callId: string | undefined;
  name: string;
  argumentsJson: string | undefined;
  resultJson: string | undefined;
  status: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationMs: number | undefined;
}

/** 打开并迁移数据库（幂等）。 */
export function openStore(file: string): SqliteDatabase {
  const db = openDatabase(file);
  migrate(db);
  return db;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : v === null || v === undefined ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "") return Number(v);
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 由首条 user 消息生成标题：前 60 字符，压缩空白。 */
export function deriveTitle(input: string): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "Untitled";
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

/**
 * SQLite 会话存储：满足 core 的 SessionStoreLike（ensureSession/appendMessage/getHistory），
 * 另提供会话列表/详情/删除/重命名。
 */
export class SqliteSessionStore implements SessionStoreLike {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** 已打开的数据库句柄（供同一进程内组合 TaskStore 使用）。 */
  get database(): SqliteDatabase {
    return this.db;
  }

  ensureSession(sessionId: string, cwd = ""): void {
    const existing = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
    if (existing) return;
    const ts = nowIso();
    this.db
      .prepare("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, "Untitled", cwd, ts, ts);
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    this.ensureSession(sessionId);
    const toolCalls = message.toolCalls;
    this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls_json, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId,
        message.role,
        message.content ?? "",
        message.toolCallId ?? null,
        toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        message.role === "tool" ? (message as ChatMessage & { name?: string }).name ?? null : null,
        nowIso(),
      );
    // 首条 user 消息落库后补标题（未命名会话）。
    if (message.role === "user") {
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND (title IS NULL OR title = 'Untitled')")
        .run(deriveTitle(message.content ?? ""), nowIso(), sessionId);
    } else {
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
    }
  }

  getHistory(sessionId: string): ChatMessage[] {
    return this.getMessages(sessionId);
  }

  /** 按 id 升序返回全部消息，并反序列化 toolCalls。 */
  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT role, content, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? ORDER BY id ASC",
      )
      .all(sessionId);
    return rows.map((row) => {
      const msg: ChatMessage = {
        role: str(row["role"]) as ChatMessage["role"],
        content: str(row["content"]) ?? "",
      };
      const toolCallId = str(row["tool_call_id"]);
      if (toolCallId !== undefined) msg.toolCallId = toolCallId;
      const rawCalls = str(row["tool_calls_json"]);
      if (rawCalls) {
        try {
          const parsed: unknown = JSON.parse(rawCalls);
          if (Array.isArray(parsed)) msg.toolCalls = parsed as ToolCall[];
        } catch {
          // 损坏的 tool_calls_json 视为无工具调用，避免整条历史不可用。
        }
      }
      return msg;
    });
  }

  listSessions(opts: { limit?: number } = {}): SessionSummary[] {
    const limit = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : -1;
    const rows = this.db
      .prepare(
        `SELECT s.id AS id, COALESCE(s.title, 'Untitled') AS title, s.created_at AS created_at,
                s.updated_at AS updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s
         ORDER BY s.updated_at DESC, s.id ASC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map((row) => ({
      id: str(row["id"]) ?? "",
      title: str(row["title"]) ?? "Untitled",
      createdAt: str(row["created_at"]) ?? "",
      updatedAt: str(row["updated_at"]) ?? "",
      messageCount: num(row["message_count"]) ?? 0,
    }));
  }

  /**
   * 把可能是截断形式的会话 ID 解析成完整 ID。
   *
   * `sessions list` 为了可读性只显示前 8 位，用户会直接把这个短 ID 传给 show/delete。
   * 因此这里在精确匹配失败时按唯一前缀匹配；命中多个则报错（避免误操作到别的会话）。
   */
  resolveSessionId(sessionId: string): string {
    const exact = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as
      | { id?: unknown }
      | undefined;
    if (exact) return String(exact.id);
    const matches = this.db
      .prepare("SELECT id FROM sessions WHERE id LIKE ? || '%' LIMIT 5")
      .all(sessionId) as Array<{ id?: unknown }>;
    if (matches.length === 1) return String(matches[0]?.id);
    if (matches.length > 1) {
      throw new AgentxError(
        ErrorCode.SESSION_NOT_FOUND,
        `session id "${sessionId}" is ambiguous: ${matches.map((m) => String(m.id)).join(", ")}`,
      );
    }
    throw new AgentxError(ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
  }

  getSession(sessionId: string): SessionDetail {
    const fullId = this.resolveSessionId(sessionId);
    const row = this.db
      .prepare(
        `SELECT s.id AS id, COALESCE(s.title, 'Untitled') AS title, s.created_at AS created_at,
                s.updated_at AS updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.id = ?`,
      )
      .get(fullId);
    if (!row) throw new AgentxError(ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
    return {
      id: str(row["id"]) ?? fullId,
      title: str(row["title"]) ?? "Untitled",
      createdAt: str(row["created_at"]) ?? "",
      updatedAt: str(row["updated_at"]) ?? "",
      messageCount: num(row["message_count"]) ?? 0,
      messages: this.getMessages(fullId),
    };
  }

  hasSession(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(sessionId) !== undefined;
  }

  /** 返回是否删除成功（外键 ON DELETE CASCADE 会连带删除消息）。 */
  deleteSession(sessionId: string): boolean {
    // 支持 list 里显示的截断 ID；不存在时返回 false（由调用方决定报错方式）。
    const exact = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    if (Number(exact.changes) > 0) return true;
    // 前缀歧义必须向上抛（而非静默返回 false），否则用户会误以为"会话不存在"。
    let fullId: string;
    try {
      fullId = this.resolveSessionId(sessionId);
    } catch (err) {
      if (String((err as Error).message).includes("ambiguous")) throw err;
      return false;
    }
    const res = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(fullId);
    return Number(res.changes) > 0;
  }

  renameSession(sessionId: string, title: string): void {
    const res = this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, nowIso(), this.resolveSessionId(sessionId));
    if (Number(res.changes) === 0) {
      throw new AgentxError(ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
    }
  }

  close(): void {
    this.db.close();
  }
}

/** 状态机允许的转换（PM_SPEC §6）。 */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["running"],
  running: ["waiting_approval", "succeeded", "failed", "cancelled", "timed_out"],
  waiting_approval: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isAllowedTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export interface FinishTaskInput {
  status: string;
  terminationReason?: string;
  errorCode?: string;
  errorSummary?: string;
  steps?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishedAt?: string;
}

export interface RecordToolCallInput {
  callId: string;
  name: string;
  ok: boolean;
  durationMs?: number;
  argumentsJson?: string;
  resultJson?: string;
  errorCode?: string;
}

/** SQLite 任务存储：状态机校验 + 结果落库 + 工具调用记录。 */
export class SqliteTaskStore implements TaskStoreLike {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  createTask(task: { taskId: string; sessionId: string; input: string; model: string }): void {
    const ts = nowIso();
    // session 行不存在时补建，避免 task 指向不存在的会话（runtime 正常会先 ensureSession）。
    this.db
      .prepare("INSERT OR IGNORE INTO sessions (id, title, cwd, created_at, updated_at) VALUES (?, 'Untitled', '', ?, ?)")
      .run(task.sessionId, ts, ts);
    this.db
      .prepare(
        "INSERT INTO tasks (id, session_id, status, model, input, started_at) VALUES (?, ?, 'created', ?, ?, ?)",
      )
      .run(task.taskId, task.sessionId, task.model, task.input, ts);
  }

  updateStatus(
    taskId: string,
    status: string,
    extra?: { terminationReason?: string; errorCode?: string; errorSummary?: string },
  ): void {
    const row = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new AgentxError(ErrorCode.INTERNAL, `task not found: ${taskId}`);
    const from = str(row["status"]) ?? "created";
    if (!isAllowedTransition(from, status)) throw new IllegalStateTransitionError(from, status);
    const finished = ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
    this.db
      .prepare(
        `UPDATE tasks SET status = ?,
           termination_reason = COALESCE(?, termination_reason),
           error_code = COALESCE(?, error_code),
           error_summary = COALESCE(?, error_summary),
           finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
      )
      .run(
        status,
        extra?.terminationReason ?? null,
        extra?.errorCode ?? null,
        extra?.errorSummary ?? null,
        finished ? nowIso() : null,
        taskId,
      );
  }

  /** 写完整结果（steps / usage / 终止原因 / 错误摘要）。 */
  finish(taskId: string, input: FinishTaskInput): void {
    const row = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new AgentxError(ErrorCode.INTERNAL, `task not found: ${taskId}`);
    const from = str(row["status"]) ?? "created";
    if (!isAllowedTransition(from, input.status)) throw new IllegalStateTransitionError(from, input.status);
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, termination_reason = ?, error_code = ?, error_summary = ?,
           steps = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.terminationReason ?? null,
        input.errorCode ?? null,
        input.errorSummary ?? null,
        input.steps ?? null,
        input.usage?.promptTokens ?? null,
        input.usage?.completionTokens ?? null,
        input.usage?.totalTokens ?? null,
        input.finishedAt ?? nowIso(),
        taskId,
      );
  }

  recordToolCall(taskId: string, call: RecordToolCallInput): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO tool_calls (task_id, call_id, tool_name, arguments_json, result_json, status,
           started_at, finished_at, duration_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        call.callId,
        call.name,
        call.argumentsJson ?? null,
        call.resultJson ?? null,
        call.ok ? "ok" : "error",
        ts,
        ts,
        call.durationMs ?? null,
        call.errorCode ?? null,
      );
  }

  getTask(taskId: string): TaskRow {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new AgentxError(ErrorCode.INTERNAL, `task not found: ${taskId}`);
    return toTaskRow(row);
  }

  listTasks(sessionId: string): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY started_at ASC")
      .all(sessionId);
    return rows.map(toTaskRow);
  }

  listToolCalls(taskId: string): ToolCallRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_calls WHERE task_id = ? ORDER BY id ASC")
      .all(taskId);
    return rows.map((row) => ({
      id: num(row["id"]) ?? 0,
      taskId: str(row["task_id"]) ?? taskId,
      callId: str(row["call_id"]),
      name: str(row["tool_name"]) ?? "",
      argumentsJson: str(row["arguments_json"]),
      resultJson: str(row["result_json"]),
      status: str(row["status"]),
      startedAt: str(row["started_at"]),
      finishedAt: str(row["finished_at"]),
      durationMs: num(row["duration_ms"]),
    }));
  }
}

function toTaskRow(row: Record<string, unknown>): TaskRow {
  const prompt = num(row["prompt_tokens"]);
  const completion = num(row["completion_tokens"]);
  const total = num(row["total_tokens"]);
  return {
    taskId: str(row["id"]) ?? "",
    sessionId: str(row["session_id"]) ?? "",
    status: str(row["status"]) ?? "created",
    model: str(row["model"]) ?? "",
    input: str(row["input"]) ?? "",
    startedAt: str(row["started_at"]),
    finishedAt: str(row["finished_at"]),
    terminationReason: str(row["termination_reason"]),
    errorCode: str(row["error_code"]),
    errorSummary: str(row["error_summary"]),
    steps: num(row["steps"]),
    usage:
      prompt === undefined && completion === undefined && total === undefined
        ? undefined
        : { promptTokens: prompt ?? 0, completionTokens: completion ?? 0, totalTokens: total ?? 0 },
  };
}

/** 便捷构造：打开 <dir>/agentx.sqlite 并返回两个 store。 */
export function createSqliteStores(file: string): {
  db: SqliteDatabase;
  sessions: SqliteSessionStore;
  tasks: SqliteTaskStore;
} {
  const db = openStore(file);
  return { db, sessions: new SqliteSessionStore(db), tasks: new SqliteTaskStore(db) };
}
