import { describe, expect, it } from "vitest";
import { truncateHistory, serializeToolResult, assistantMessage, userMessage, toolResultMessage, dropUnpairedToolCalls } from "../src/messages.js";
import { ContextBuilder } from "../src/context.js";
import type { ChatMessage } from "../src/types.js";

function user(text: string): ChatMessage {
  return userMessage(text);
}

describe("truncateHistory", () => {
  it("E25 keeps the most recent N messages", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => user(`m${i}`));
    const out = truncateHistory(msgs, 3);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual(["m7", "m8", "m9"]);
  });

  it("E25 never leaves an orphan tool message at the head of the window", () => {
    const pair: ChatMessage[] = [
      assistantMessage("", [{ id: "c1", name: "read_file", arguments: { path: "a" } }]),
      toolResultMessage("c1", { ok: true, content: "file body" }),
    ];
    const msgs: ChatMessage[] = [user("old-1"), user("old-2"), ...pair, user("new")];
    const out = truncateHistory(msgs, 2);

    // tool 消息前必须仍有对应的 assistant(toolCalls)，否则模型协议被破坏
    const firstToolIdx = out.findIndex((m) => m.role === "tool");
    if (firstToolIdx >= 0) {
      const before = out.slice(0, firstToolIdx);
      expect(before.some((m) => m.role === "assistant" && m.toolCalls?.length)).toBe(true);
    }
    expect(out.at(-1)?.content).toBe("new");
  });

  it("returns an empty list for non-positive limits and copies under the limit", () => {
    expect(truncateHistory([user("a")], 0)).toEqual([]);
    expect(truncateHistory([user("a")], -1)).toEqual([]);
    const one = [user("a")];
    expect(truncateHistory(one, 5)).toHaveLength(1);
    expect(truncateHistory(one, 5)).not.toBe(one);
  });
});

describe("ContextBuilder history sanitising (integration)", () => {
  it("never sends an unpaired tool_calls turn to the model", () => {
    const builder = new ContextBuilder({
      tools: [],
      cwd: "/w",
      readOnly: false,
      historyLimit: 30,
    });

    // 复刻真实故障：审批被拒后，assistant 的 tool_calls 留在历史里但没有结果
    const request = {
      taskId: "t",
      sessionId: "s",
      input: "下个问题",
      cwd: "/w",
      model: "m",
      maxSteps: 3,
      timeoutMs: 1000,
      readOnly: false,
      history: [
        user("记住这个数字：42"),
        assistantMessage("", [{ id: "call_A", name: "exec", arguments: { command: "node" } }]),
        user("我刚才让你记住的数字是多少？"),
      ],
    };

    const built = builder.build(request);
    const withToolCalls = built.messages.filter((m) => m.toolCalls && m.toolCalls.length > 0);
    expect(withToolCalls).toHaveLength(0);

    // 每个 tool 消息都必须能追溯到紧邻的 assistant tool_calls
    for (let i = 0; i < built.messages.length; i++) {
      if (built.messages[i]?.role === "tool") {
        const prev = built.messages[i - 1];
        const ok = prev?.role === "tool" || (prev?.role === "assistant" && (prev.toolCalls?.length ?? 0) > 0);
        expect(ok).toBe(true);
      }
    }
  });
});

describe("dropUnpairedToolCalls", () => {
  it("removes an assistant tool_calls turn whose tool results never arrived", () => {
    // 真实场景：exec 需要审批但非交互环境被拒 -> tool_calls 落库、结果没落库
    const history: ChatMessage[] = [
      user("记住这个数字：42"),
      assistantMessage("", [{ id: "call_A", name: "exec", arguments: { command: "node" } }]),
      user("下一个问题"),
    ];

    const cleaned = dropUnpairedToolCalls(history);
    expect(cleaned.map((m) => m.role)).toEqual(["user", "user"]);
    expect(cleaned.some((m) => m.toolCalls?.length)).toBe(false);
  });

  it("keeps a fully paired tool_calls turn untouched", () => {
    const history: ChatMessage[] = [
      user("read a"),
      assistantMessage("", [{ id: "c1", name: "read_file", arguments: { path: "a" } }]),
      toolResultMessage("c1", { ok: true, content: "data" }),
      user("next"),
    ];

    const cleaned = dropUnpairedToolCalls(history);
    expect(cleaned).toHaveLength(4);
    expect(cleaned[1]?.toolCalls?.[0]?.id).toBe("c1");
  });

  it("removes a partially answered tool_calls turn (one of two results missing)", () => {
    const history: ChatMessage[] = [
      user("go"),
      assistantMessage("", [
        { id: "c1", name: "read_file", arguments: {} },
        { id: "c2", name: "exec", arguments: {} },
      ]),
      toolResultMessage("c1", { ok: true, content: "ok" }),
      user("next"),
    ];
    const cleaned = dropUnpairedToolCalls(history);
    expect(cleaned.some((m) => m.toolCalls?.length)).toBe(false);
    expect(cleaned.some((m) => m.role === "tool")).toBe(false);
    expect(cleaned.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("drops an orphan tool result that has no preceding assistant call", () => {
    const history: ChatMessage[] = [
      user("a"),
      toolResultMessage("ghost", { ok: true, content: "x" }),
      user("b"),
    ];
    expect(dropUnpairedToolCalls(history).map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("preserves assistant text when dropping its unpaired tool calls", () => {
    const history: ChatMessage[] = [
      user("a"),
      assistantMessage("thinking out loud", [{ id: "c1", name: "exec", arguments: {} }]),
      user("b"),
    ];
    const cleaned = dropUnpairedToolCalls(history);
    expect(cleaned[1]).toEqual({ role: "assistant", content: "thinking out loud" });
  });
});

describe("message factories", () => {
  it("tool messages carry the call id so results map back to the request", () => {
    const m = toolResultMessage("call-42", { ok: true, content: "hi" });
    expect(m.role).toBe("tool");
    expect(m.toolCallId).toBe("call-42");
  });

  it("serializes tool results as structured JSON, keeping ok/error/metadata", () => {
    const payload = JSON.parse(serializeToolResult({ ok: false, content: "", error: "boom", metadata: { bytes: 0 } }));
    expect(payload).toMatchObject({ ok: false, error: "boom", metadata: { bytes: 0 } });
  });

  it("omits toolCalls on plain assistant messages", () => {
    expect(assistantMessage("hello").toolCalls).toBeUndefined();
  });
});
