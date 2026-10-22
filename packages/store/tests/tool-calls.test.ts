import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  AgentRuntime,
  ContextBuilder,
  MockProvider,
  createLogger,
  ErrorCode,
  type AgentTool,
} from "@agentx/core";
import { openDatabase, migrate, SqliteSessionStore, SqliteTaskStore } from "../src/index.js";

const logger = createLogger({ level: "error", stderr: false });

function freshHome() {
  return mkdtempSync(path.join(tmpdir(), "agentx-toolcall-"));
}

/** 一个最小工具：回显参数，便于断言落到 tool_calls 表的内容。 */
const echoTool: AgentTool = {
  name: "echo_tool",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  riskLevel: "low",
  readOnly: true,
  execute: async (input) => ({ ok: true, content: `echo:${(input as { text: string }).text}` }),
};

describe("tool call persistence (PM_SPEC §12)", () => {
  it("records every executed tool call with name, status, duration and arguments", async () => {
    const home = freshHome();
    const db = openDatabase(path.join(home, "data", "agentx.sqlite"));
    migrate(db);

    const sessionStore = new SqliteSessionStore(db);
    const taskStore = new SqliteTaskStore(db);
    const provider = new MockProvider({
      script: [
        { type: "tool_calls", calls: [{ id: "c1", name: "echo_tool", arguments: { text: "hi" } }] },
        { type: "final", text: "done" },
      ],
    });

    const runtime = new AgentRuntime({
      sessionStore,
      taskStore,
      logger,
      run: async (request, signal, hooks) => {
        const { runAgent } = await import("@agentx/core");
        return runAgent(
          request,
          {
            provider,
            contextBuilder: new ContextBuilder({ tools: [], cwd: request.cwd, readOnly: false, historyLimit: 30 }),
            tools: { get: (n: string) => (n === "echo_tool" ? echoTool : undefined), list: () => [echoTool] },
            policy: { authorize: async () => ({ needApproval: false }) },
            executor: { execute: async (t, input) => t.execute(input, {} as never) },
            logger,
            onToolCall: hooks.onToolCall,
          },
          signal,
        );
      },
    });

    const result = await runtime.run({
      taskId: "task_tc",
      sessionId: "ses_tc",
      input: "use the tool",
      cwd: home,
      model: "mock-1",
      maxSteps: 3,
      timeoutMs: 5000,
      readOnly: false,
    });

    expect(result.status).toBe("succeeded");

    const rows = taskStore.listToolCalls("task_tc");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "echo_tool", status: "ok" });
    expect(rows[0]?.argumentsJson).toContain("hi");
    expect(rows[0]?.resultJson).toContain("echo:hi");
    expect(rows[0]?.durationMs).toBeTypeOf("number");
  });

  it("records failed tool calls with a non-ok status", async () => {
    const home = freshHome();
    const db = openDatabase(path.join(home, "data", "agentx.sqlite"));
    migrate(db);
    const taskStore = new SqliteTaskStore(db);
    taskStore.createTask({ taskId: "t_fail", sessionId: "s", input: "x", model: "m" });
    taskStore.recordToolCall("t_fail", { callId: "c9", name: "exec", ok: false, durationMs: 7 });

    const rows = taskStore.listToolCalls("t_fail");
    expect(rows[0]?.status).not.toBe("ok");
  });

  it("marks an internal crash as a framework failure, not a tool failure", async () => {
    const home = freshHome();
    const db = openDatabase(path.join(home, "data", "agentx.sqlite"));
    migrate(db);
    const taskStore = new SqliteTaskStore(db);

    const runtime = new AgentRuntime({
      sessionStore: new SqliteSessionStore(db),
      taskStore,
      logger,
      run: async () => {
        throw new Error("unexpected internal explosion");
      },
    });

    await expect(
      runtime.run({
        taskId: "task_crash",
        sessionId: "ses_crash",
        input: "x",
        cwd: home,
        model: "mock-1",
        maxSteps: 1,
        timeoutMs: 1000,
        readOnly: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL });

    const task = taskStore.getTask("task_crash");
    expect(task?.status).toBe("failed");
    expect(task?.terminationReason).not.toBe("tool_failed");
    expect(task?.errorCode).toBe(ErrorCode.INTERNAL);
  });
});
