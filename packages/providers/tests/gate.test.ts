import { describe, expect, it } from "vitest";
import { ErrorCode, type ChatMessage, type ModelRequest } from "@agentx/core";
import {
  GateProvider,
  NeedMoreInfoError,
  buildToolProtocolPrompt,
  encodeMessages,
  parseToolReply,
  type FetchLike,
} from "../src/index.js";

function gateReply(payload: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function ok(content: string) {
  return { success: true, data: { content, source: "llm", audit: { request: "pass", response: "pass" } } };
}

const tools: ModelRequest["tools"] = [
  { name: "read_file", description: "读文件", parameters: { type: "object" } },
];

function req(messages: ChatMessage[], withTools = false): ModelRequest {
  return { model: "gate:gate-chat", messages, tools: withTools ? tools : [] };
}

describe("encodeMessages", () => {
  it("assistant.toolCalls 发结构化 tool_calls（而不是压成文本）", () => {
    const out = encodeMessages([
      { role: "user", content: "读一下 package.json" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "package.json" } }] },
      { role: "tool", content: "{}", toolCallId: "c1" },
    ]);
    // 用户消息保持独立（审核依赖 role 边界，不能被合进 assistant 内容）。
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toBe("读一下 package.json");
    // 云端要求 role="tool" 必须回应前面带 tool_calls 的 assistant，所以这里必须发结构化字段。
    const assistant = out.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } },
    ]);
    // gate 的 validate 拒绝 null/空 content，占位文本必须非空。
    expect(typeof assistant.content).toBe("string");
    expect((assistant.content as string).trim().length).toBeGreaterThan(0);
  });

  it("tool 结果带工具标记", () => {
    const out = encodeMessages([
      { role: "user", content: "q" },
      { role: "tool", content: "{\"a\":1}", toolCallId: "c1" },
      { role: "user", content: "继续" },
    ]);
    expect(out[1]!.role).toBe("tool");
    expect(out[1]!.tool_call_id).toBe("c1");
  });

  it("tool 消息必须带 tool_call_id（缺了云端回 422，实测）", () => {
    const out = encodeMessages([
      { role: "user", content: "读文件" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_x", name: "read_file", arguments: { path: "a" } }] },
      { role: "tool", content: "文件内容", toolCallId: "call_x" },
    ]);
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_x");
    expect(toolMsg!.content).toBe("文件内容");
  });

  it("toolCallId 缺失时用上一条 assistant 的调用 id 兜底", () => {
    const out = encodeMessages([
      { role: "user", content: "读文件" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_fallback", name: "read_file", arguments: {} }] },
      { role: "tool", content: "结果" },
    ]);
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg!.tool_call_id).toBe("call_fallback");
  });

  it("拿不到任何 call id 时降级为 user，不发裸 tool 消息", () => {
    const out = encodeMessages([
      { role: "user", content: "q" },
      { role: "tool", content: "孤立结果" },
    ]);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out.some((m) => (m.content ?? "").includes("孤立结果"))).toBe(true);
  });

  it("工具结尾的收尾 query 必须唯一（否则共享 intent_hash 命中同一缓存、污染知识库）", () => {
    const a = encodeMessages([
      { role: "user", content: "q" },
      { role: "tool", content: "第一个文件的内容 A", toolCallId: "c1" },
    ]);
    const b = encodeMessages([
      { role: "user", content: "q" },
      { role: "tool", content: "第二个文件的内容 B", toolCallId: "c1" },
    ]);
    const tailA = a[a.length - 1]!.content as string;
    const tailB = b[b.length - 1]!.content as string;
    expect(tailA).not.toBe(tailB);
  });

  it("工具结果位于尾部时不丢消息、不抹掉用户原话", () => {
    const out = encodeMessages([
      { role: "user", content: "读一下" },
      { role: "tool", content: "文件内容", toolCallId: "c1" },
    ]);
    expect(out[0]!.content).toBe("读一下");
    // 工具内容保留在 tool 消息里（带 tool_call_id），而不是被塞进 user 消息
    expect(out.some((m) => m.role === "tool" && m.content === "文件内容" && m.tool_call_id === "c1")).toBe(true);
    expect(out[out.length - 1]!.role).toBe("user");
  });

  it("最后一条不是 user 时仍以 user 结尾（gate 硬要求）", () => {
    const out = encodeMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "我在想" },
    ]);
    expect(out[out.length - 1]!.role).toBe("user");
  });

  it("空内容不留空串（gate 拒收空消息）", () => {
    const out = encodeMessages([{ role: "user", content: "   " }]);
    expect((out[0]!.content ?? "").trim()).not.toBe("");
  });
});

describe("parseToolReply", () => {
  it("解析标准 tool_call JSON", () => {
    const parsed = parseToolReply(
      '{"tool_call":{"name":"read_file","arguments":{"path":"a.ts"}}}',
      ["read_file"],
      1,
    );
    expect(parsed?.call.name).toBe("read_file");
    expect(parsed?.call.arguments).toEqual({ path: "a.ts" });
  });

  it("容忍 ```json 围栏", () => {
    const parsed = parseToolReply(
      '```json\n{"tool_call":{"name":"read_file","arguments":{}}}\n```',
      ["read_file"],
      1,
    );
    expect(parsed?.call.name).toBe("read_file");
  });

  it("JSON 前带自然语言仍能解析（实测漏解析场景）", () => {
    const parsed = parseToolReply(
      '我先读取这两个文件。\n\n{"tool_call":{"name":"read_file","arguments":{"path":"packages/x.ts"}}}',
      ["read_file"],
      1,
    );
    expect(parsed?.call.name).toBe("read_file");
    expect(parsed?.call.arguments).toEqual({ path: "packages/x.ts" });
    // 前置说明作为 assistant 文本保留
    expect(parsed?.text).toContain("我先读取");
  });

  it("围栏且前后都有自然语言仍能解析", () => {
    const parsed = parseToolReply(
      '好的，我来看看：\n```json\n{"tool_call":{"name":"read_file","arguments":{"path":"a"}}}\n```',
      ["read_file"],
      1,
    );
    expect(parsed?.call.name).toBe("read_file");
  });

  it("arguments 内含花括号不截断", () => {
    const parsed = parseToolReply(
      '执行\n{"tool_call":{"name":"read_file","arguments":{"path":"a","opts":{"deep":true}}}}',
      ["read_file"],
      1,
    );
    expect(parsed?.call.arguments).toEqual({ path: "a", opts: { deep: true } });
  });

  it("普通回答返回 undefined（当 final 处理）", () => {
    expect(parseToolReply("文件内容是……", ["read_file"], 1)).toBeUndefined();
  });

  it("DSML 格式工具调用（实测 DeepSeek 私有标记）", () => {
    const raw =
      '我读取第二个文件。\n' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="read_file">\n' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path" string="true">packages/providers/src/index.ts</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n' +
      '</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n' +
      '</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
    const parsed = parseToolReply(raw, ["read_file"], 1);
    expect(parsed?.call.name).toBe("read_file");
    expect(parsed?.call.arguments).toEqual({ path: "packages/providers/src/index.ts" });
  });

  it("DSML 未知工具名不猜测", () => {
    const raw = '<invoke name="rm_rf"><parameter name="p">/x</parameter></invoke>';
    expect(parseToolReply(raw, ["read_file"], 1)).toBeUndefined();
  });

  it("DSML 嵌套 arguments 必须展平（实测导致 path: Required）", () => {
    const raw =
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C>  <\uFF5C\uFF5CDSML\uFF5C\uFF5C calls> ' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="read_file"> ' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="arguments" string="false">{"path": "package.json"}</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter> ' +
      '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="name" string="false">read_file</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter> ' +
      '</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>';
    const parsed = parseToolReply(raw, ["read_file"], 1);
    expect(parsed?.call.name).toBe("read_file");
    expect(parsed?.call.arguments).toEqual({ path: "package.json" });
  });

  it("未知工具名不猜测", () => {
    expect(parseToolReply('{"tool_call":{"name":"rm_rf","arguments":{}}}', ["read_file"], 1)).toBeUndefined();
  });

  it("非法 JSON 不抛错", () => {
    expect(parseToolReply("{not json", ["read_file"], 1)).toBeUndefined();
  });
});

describe("buildToolProtocolPrompt", () => {
  it("列出所有工具名", () => {
    const p = buildToolProtocolPrompt(tools);
    expect(p).toContain("read_file");
    expect(p).toContain("tool_call");
  });
});

describe("GateProvider.generate", () => {
  it("普通回答 -> final", async () => {
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      fetchImpl: gateReply(ok("你好")),
    });
    const res = await p.generate(req([{ role: "user", content: "hi" }]));
    expect(res.type).toBe("final");
    expect(res.type === "final" && res.text).toBe("你好");
  });

  it("工具 JSON 回答 -> tool_calls（B2：每轮都过 gate 仍能驱动工具循环）", async () => {
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      fetchImpl: gateReply(ok('{"tool_call":{"name":"read_file","arguments":{"path":"a"}}}')),
    });
    const res = await p.generate(req([{ role: "user", content: "read" }], true));
    expect(res.type).toBe("tool_calls");
    expect(res.type === "tool_calls" && res.calls[0]!.name).toBe("read_file");
  });

  it("POL_REJECTED -> POLICY_DENIED 且不可重试", async () => {
    let calls = 0;
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ success: false, error: { code: "POL_REJECTED", message: "违反 PoL" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(p.generate(req([{ role: "user", content: "x" }]))).rejects.toThrow(/POL_REJECTED|gate rejected/);
    expect(calls).toBe(1);
  });

  // 门禁结论 5（PM_SPEC_SIX_STATE §6.3）：HTTP 200 + success:false + POL_NEED_MORE_INFO。
  function needMoreInfoBody(detail: unknown, message = "为完成 PoL 治理审核，需要你补充以下信息：...") {
    return {
      success: false,
      request_id: "req_more_info",
      error: { code: "POL_NEED_MORE_INFO", message, detail },
    };
  }

  it("POL_NEED_MORE_INFO -> NEED_MORE_INFO 且不可重试、questions 透传", async () => {
    const questions = ["你要处理的是哪个文件？", "期望的输出格式是什么？"];
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      maxRetries: 2,
      fetchImpl: gateReply(needMoreInfoBody({ result_code: 5, questions })),
    });
    const err = await p.generate(req([{ role: "user", content: "帮我改一下" }])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NeedMoreInfoError);
    expect((err as NeedMoreInfoError).code).toBe(ErrorCode.NEED_MORE_INFO);
    // 追问永远不可重试：重试只会拿到同一个追问。
    expect((err as NeedMoreInfoError).retryable).toBe(false);
    expect((err as NeedMoreInfoError).detail).toMatchObject({
      gateCode: "POL_NEED_MORE_INFO",
      requestId: "req_more_info",
      resultCode: 5,
    });
    // questions 必须原样透传（供 CLI 打印）。
    expect(((err as NeedMoreInfoError).detail as { questions: string[] }).questions).toEqual(questions);
  });

  it("questions 非数组时降级为 []", async () => {
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      fetchImpl: gateReply(needMoreInfoBody({ result_code: 5, questions: "只要一个文件吗？" })),
    });
    const err = await p.generate(req([{ role: "user", content: "x" }])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NeedMoreInfoError);
    expect(((err as NeedMoreInfoError).detail as { questions: string[] }).questions).toEqual([]);
  });

  it("questions 里混入非字符串/空串时被过滤", async () => {
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      fetchImpl: gateReply(needMoreInfoBody({ result_code: 5, questions: ["a", "", 3, null, "b"] })),
    });
    const err = await p.generate(req([{ role: "user", content: "x" }])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(((err as NeedMoreInfoError).detail as { questions: string[] }).questions).toEqual(["a", "b"]);
  });

  it("maxRetries>0 时 NEED_MORE_INFO 不会被重试", async () => {
    let calls = 0;
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      maxRetries: 3,
      retryBaseMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(needMoreInfoBody({ result_code: 5, questions: ["q1"] })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(p.generate(req([{ role: "user", content: "x" }]))).rejects.toBeInstanceOf(NeedMoreInfoError);
    expect(calls).toBe(1);
  });

  it("AUDIT_UNAVAILABLE 不放行（fail-closed）", async () => {
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      maxRetries: 0,
      fetchImpl: gateReply({ success: false, error: { code: "AUDIT_UNAVAILABLE", message: "审核不可用" } }, 503),
    });
    await expect(p.generate(req([{ role: "user", content: "x" }]))).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_FAILED,
    });
  });

  it("429 可重试且最终给出 PROVIDER_FAILED", async () => {
    let calls = 0;
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000",
      models: [{ id: "gate-chat", supportsTools: true }],
      maxRetries: 1,
      retryBaseMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 429 });
      },
    });
    await expect(p.generate(req([{ role: "user", content: "x" }]))).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_FAILED,
    });
    expect(calls).toBe(2);
  });

  it("请求打到 /api/v1/chat 且最后一条是 user", async () => {
    let seenUrl = "";
    let seenBody: any;
    const p = new GateProvider({
      id: "gate",
      baseUrl: "http://127.0.0.1:3000/",
      models: [{ id: "gate-chat", supportsTools: true }],
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seenUrl = url;
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(ok("ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as FetchLike,
    });
    await p.generate(
      req(
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "thinking" },
        ],
        true,
      ),
    );
    expect(seenUrl).toBe("http://127.0.0.1:3000/api/v1/chat");
    const msgs = seenBody.messages;
    expect(msgs[msgs.length - 1].role).toBe("user");
    expect(msgs[0].content).toContain("工具调用协议");
  });
});
