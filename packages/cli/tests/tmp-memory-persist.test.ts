import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentRuntime, MockProvider, createLogger, type AgentRequest } from "@agentx/core";
import { MarkdownMemory, SqliteSessionStore, openDatabase, migrate } from "@agentx/store";
import { createDefaultTools } from "@agentx/tools";
import {
  createDefaultExecutor,
  createPermissivePolicy,
  createLoopRunner,
  memoryAddHook,
  memorySearchHook,
} from "../src/wiring.js";

describe("memory_search 结果是否跨任务残留", () => {
  it("task2 的 prompt 里是否还带着 task1 的 memory 内容", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentx-memx-"));
    const memory = new MarkdownMemory(path.join(dir, "memory"));
    memory.add({
      text: "项目 /root/pol-agent 使用 pnpm 作为包管理器。",
      source: "user instruction",
      tags: ["preference"],
    });

    const db = openDatabase(path.join(dir, "db.sqlite"));
    migrate(db);
    const sessionStore = new SqliteSessionStore(db);

    const tools = createDefaultTools({
      memorySearch: memorySearchHook(memory)!,
      memoryAdd: memoryAddHook(memory)!,
    });

    // 任务1：搜一次记忆；任务2：完全不搜记忆
    const provider = new MockProvider({
      script: [
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "memory_search", arguments: { query: "pnpm" } }],
        },
        { type: "text", text: "使用 pnpm。" },
        { type: "text", text: "第二个问题随便答。" },
      ] as never,
    });

    const logger = createLogger({ level: "error", stderr: false });
    const run = createLoopRunner({
      provider,
      policy: createPermissivePolicy({ allow: tools.map((t) => t.name), approval: "none", readOnly: false }),
      executor: createDefaultExecutor(logger),
      logger,
      tools,
      historyLimit: 30,
      maxToolCalls: 10,
      maxTotalTokens: 0,
      interactive: false,
    });
    const runtime = new AgentRuntime({ logger, run, sessionStore });

    const base = {
      sessionId: "ses_x",
      cwd: process.cwd(),
      model: "mock:mock-1",
      maxSteps: 5,
      timeoutMs: 10000,
      readOnly: false,
    };
    await runtime.run({ ...base, taskId: "task1", input: "用什么包管理器？" } as AgentRequest);
    await runtime.run({ ...base, taskId: "task2", input: "第二个问题" } as AgentRequest);

    // 落库历史里是否真的存了 memory 内容
    const history = await sessionStore.getHistory("ses_x");
    console.log("=== session 落库消息数 ===", history.length);
    for (const m of history) {
      console.log(`--- role=${m.role} len=${String(m.content ?? "").length}`);
      console.log(String(m.content ?? "").slice(0, 300));
    }

    // task2 第一次模型调用收到的 messages
    const task2Call = provider.calls[2];
    console.log("\n=== task2 首个 model request 的 message 角色序列 ===");
    console.log(task2Call?.messages.map((m) => m.role).join(" -> "));
    const leaked = task2Call?.messages.some((m) => String(m.content ?? "").includes("pnpm 作为包管理器"));
    console.log("=== task2 prompt 是否包含记忆正文 ===", leaked);
    expect(leaked).toBe(true);
  }, 30000);
});
