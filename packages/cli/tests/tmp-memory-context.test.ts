import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentRuntime, MockProvider, createLogger, type AgentRequest } from "@agentx/core";
import { MarkdownMemory } from "@agentx/store";
import { createDefaultTools } from "@agentx/tools";
import {
  createDefaultExecutor,
  createPermissivePolicy,
  createLoopRunner,
  memoryAddHook,
  memorySearchHook,
} from "../src/wiring.js";

describe("memory -> context 真实链路", () => {
  it("dumps exactly what the model receives after memory_search", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentx-memctx-"));
    const memory = new MarkdownMemory(dir);
    memory.add({
      text: "项目 /root/pol-agent 使用 pnpm 作为包管理器（不要用 npm 或 yarn）。",
      source: "user instruction",
      tags: ["preference", "pnpm"],
    });
    memory.add({
      text: "用户偏好极简推进指令，连续多轮只回复继续即期望自主推进。",
      source: "user profile",
      tags: ["preference"],
    });

    const search = memorySearchHook(memory)!;
    const add = memoryAddHook(memory)!;

    console.log("=== HOOK RETURN (搜索 pnpm) ===");
    console.log(JSON.stringify(await search("pnpm", 5), null, 2));
    console.log("=== HOOK RETURN (无命中) ===");
    console.log(JSON.stringify(await search("zzz-no-such-token", 5), null, 2));

    const tools = createDefaultTools({ memorySearch: search, memoryAdd: add });

    const provider = new MockProvider({
      script: [
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "memory_search", arguments: { query: "pnpm 包管理器", limit: 5 } }],
        },
        {
          type: "tool_calls",
          calls: [{ id: "c2", name: "memory_search", arguments: { query: "zzz-no-such-token" } }],
        },
        { type: "text", text: "done" },
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
    const runtime = new AgentRuntime({ logger, run });

    const request: AgentRequest = {
      taskId: "t1",
      sessionId: "s1",
      input: "这个项目用什么包管理器？",
      cwd: process.cwd(),
      model: "mock:mock-1",
      maxSteps: 5,
      timeoutMs: 10000,
      readOnly: false,
    } as never;

    const result = await run(request, new AbortController().signal, {
      onStart: () => {},
      onStepStart: () => {},
      onApprovalStateChange: () => {},
    });
    console.log("=== RESULT text ===", JSON.stringify((result as { text?: string }).text));

    for (const [i, call] of provider.calls.entries()) {
      console.log(`\n===== model request #${i + 1} : ${call.messages.length} 条 message =====`);
      for (const m of call.messages) {
        const c = String(m.content ?? "");
        const tag = `role=${m.role}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ""}`;
        console.log(`--- ${tag} (${c.length} chars)`);
        console.log(c.length > 1200 ? c.slice(0, 1200) + "…<TRUNCATED>" : c);
      }
    }
    expect(provider.calls.length).toBeGreaterThan(1);
  }, 30000);
});
