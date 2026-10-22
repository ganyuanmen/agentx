import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ErrorCode, type ChatMessage } from "@agentx/core";
import { openDatabase, migrate, SqliteSessionStore, SqliteTaskStore } from "../src/index.js";

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agentx-store-"));
  dbFile = path.join(dir, "data", "agentx.sqlite");
});

function fresh() {
  const db = openDatabase(dbFile);
  migrate(db);
  return db;
}

describe("schema migration", () => {
  it("creates the database and is idempotent across re-opens", () => {
    const db1 = fresh();
    const v1 = db1.prepare("PRAGMA user_version").get() as { user_version: number };
    db1.close();

    const db2 = fresh();
    const v2 = db2.prepare("PRAGMA user_version").get() as { user_version: number };
    db2.close();

    expect(existsSync(dbFile)).toBe(true);
    expect(v1.user_version).toBeGreaterThan(0);
    expect(v2.user_version).toBe(v1.user_version);
  });

  it("survives a process restart: data written before close is readable after", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("ses_persist", "/w");
    store.appendMessage("ses_persist", { role: "user", content: "remember me" });

    const db2 = openDatabase(dbFile);
    migrate(db2);
    const store2 = new SqliteSessionStore(fresh());
    const history = store2.getHistory("ses_persist");
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe("remember me");
  });
});

describe("SqliteSessionStore", () => {
  it("E13 appends and returns messages in order with tool calls intact", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("s1", "/w");
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }],
    };
    store.appendMessage("s1", { role: "user", content: "read a" });
    store.appendMessage("s1", assistant);
    store.appendMessage("s1", { role: "tool", content: '{"ok":true}', toolCallId: "c1" });

    const history = store.getHistory("s1");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(history[1]?.toolCalls?.[0]).toMatchObject({ id: "c1", name: "read_file", arguments: { path: "a.txt" } });
    expect(history[2]?.toolCallId).toBe("c1");
  });

  it("E14 lists sessions with message counts and reports a missing session clearly", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("s1", "/w");
    store.appendMessage("s1", { role: "user", content: "first message here" });
    store.appendMessage("s1", { role: "assistant", content: "ok" });

    const list = store.listSessions({ limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("s1");
    expect(list[0]?.messageCount).toBe(2);
    expect(list[0]?.title).toContain("first message");

    expect(() => store.getSession("nope")).toThrowError(/nope/);
    try {
      store.getSession("nope");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCode.SESSION_NOT_FOUND);
    }
  });

  it("resolves a truncated session id from `sessions list` to the full id", () => {
    const store = new SqliteSessionStore(fresh());
    const fullId = "ses_e1ddc3ff-3e50-442d-a502-1e1c3e7b8db4";
    store.ensureSession(fullId, "/w");
    store.appendMessage(fullId, { role: "user", content: "hello" });

    // list 只显示前 8 位，用户会直接把这个短 ID 传给 show
    const short = fullId.slice(0, 8);
    const detail = store.getSession(short);
    expect(detail.id).toBe(fullId);
    expect(detail.messages).toHaveLength(1);
  });

  it("rejects an ambiguous truncated prefix instead of guessing", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("ses_dup1-aaa", "/w");
    store.ensureSession("ses_dup1-bbb", "/w");
    expect(() => store.getSession("ses_dup1")).toThrowError(/ambiguous/i);
  });

  it("deleteSession also accepts a truncated id", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("ses_deadbeef-1111", "/w");
    expect(store.deleteSession("ses_dead")).toBe(true);
    expect(store.listSessions({ limit: 10 })).toHaveLength(0);
  });

  it("deleteSession also removes its messages", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("s1", "/w");
    store.appendMessage("s1", { role: "user", content: "x" });
    store.deleteSession("s1");
    expect(store.listSessions({ limit: 10 })).toHaveLength(0);
    expect(store.getHistory("s1")).toHaveLength(0);
  });

  it("E25 stores a long history that can be truncated later without orphan tools", () => {
    const store = new SqliteSessionStore(fresh());
    store.ensureSession("s1", "/w");
    for (let i = 0; i < 40; i++) store.appendMessage("s1", { role: "user", content: `m${i}` });
    expect(store.getHistory("s1")).toHaveLength(40);
  });
});

describe("SqliteTaskStore state machine", () => {
  const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };

  it("records a task through running to succeeded", () => {
    const tasks = new SqliteTaskStore(fresh());
    tasks.createTask({ taskId: "t1", sessionId: "s1", input: "do it", model: "m" });
    tasks.updateStatus("t1", "running");
    tasks.finish("t1", { status: "succeeded", terminationReason: "completed", steps: 2, usage });

    const t = tasks.getTask("t1");
    expect(t?.status).toBe("succeeded");
    expect(t?.terminationReason).toBe("completed");
    expect(t?.steps).toBe(2);
    expect(t?.usage?.totalTokens).toBe(7);
  });

  it("rejects an illegal transition with ILLEGAL_STATE_TRANSITION", () => {
    const tasks = new SqliteTaskStore(fresh());
    tasks.createTask({ taskId: "t2", sessionId: "s1", input: "x", model: "m" });
    tasks.updateStatus("t2", "running");
    tasks.updateStatus("t2", "succeeded");
    let err: unknown;
    try {
      tasks.updateStatus("t2", "running");
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });

  it("records tool calls with arguments and results", () => {
    const tasks = new SqliteTaskStore(fresh());
    tasks.createTask({ taskId: "t3", sessionId: "s1", input: "x", model: "m" });
    tasks.recordToolCall("t3", {
      callId: "c1",
      name: "read_file",
      argumentsJson: JSON.stringify({ path: "a.txt" }),
      resultJson: JSON.stringify({ ok: true, content: "data" }),
      ok: true,
      durationMs: 3,
    });
    const rows = tasks.listToolCalls("t3");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "read_file" });
    expect(rows[0]?.argumentsJson).toContain("a.txt");
  });

  it("keeps a failed task record with its error code (PM_SPEC §5.2)", () => {
    const tasks = new SqliteTaskStore(fresh());
    tasks.createTask({ taskId: "t4", sessionId: "s1", input: "x", model: "m" });
    tasks.updateStatus("t4", "running");
    tasks.finish("t4", {
      status: "failed",
      terminationReason: "tool_failed",
      errorCode: ErrorCode.UNKNOWN_TOOL,
      errorSummary: "unknown tool: nope",
      steps: 1,
      usage,
    });
    const t = tasks.getTask("t4");
    expect(t?.status).toBe("failed");
    expect(t?.errorCode).toBe(ErrorCode.UNKNOWN_TOOL);
    expect(t?.errorSummary).toContain("nope");
  });

  it("records the waiting_approval state so it is observable", () => {
    const tasks = new SqliteTaskStore(fresh());
    tasks.createTask({ taskId: "t5", sessionId: "s1", input: "x", model: "m" });
    tasks.updateStatus("t5", "running");
    tasks.updateStatus("t5", "waiting_approval");
    expect(tasks.getTask("t5")?.status).toBe("waiting_approval");
  });
});
