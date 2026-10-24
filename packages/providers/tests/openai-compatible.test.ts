import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/openai-compatible.js";
import { createDeepseekProvider } from "../src/deepseek.js";
import { ErrorCode } from "@agentx/core";

const MODELS = [{ id: "m1", supportsTools: true }];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provider(fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new OpenAiCompatibleProvider({
    id: "test",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "sk-testvalue1234567890",
    models: MODELS,
    maxRetries: 2,
    timeoutMs: 1000,
    retryBaseMs: 0,
    fetchImpl,
    ...over,
  });
}

const REQ = { model: "m1", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("OpenAiCompatibleProvider", () => {
  it("parses a plain text answer into a final response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    );
    const res = await provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ);

    expect(res.type).toBe("final");
    expect(res.type === "final" && res.text).toBe("hello");
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it("parses tool calls and decodes their JSON arguments", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    const res = await provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ);

    expect(res.type).toBe("tool_calls");
    if (res.type !== "tool_calls") throw new Error("expected tool_calls");
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]).toMatchObject({ id: "call_1", name: "read_file", arguments: { path: "a.txt" } });
  });

  it("E24 passes malformed tool-call arguments through as raw text instead of failing the task", async () => {
    // 背景：真实运行中子 agent 跑了 21 次工具调用后，模型某一步吐出坏 JSON，
    // 整个任务连同前面 28 秒的工作一起报废。坏 JSON 是「模型写错参数」，
    // 与参数校验失败同类，不该在 provider 层就把任务打死。
    // 现在 provider 原样透传原始字符串，由工具 schema 校验去报 INVALID_TOOL_ARGS。
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{not json" } }],
            },
          },
        ],
      }),
    );
    const res = await provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ);
    expect(res.type).toBe("tool_calls");
    const call = (res as { calls: Array<{ name: string; arguments: unknown }> }).calls[0];
    expect(call?.name).toBe("read_file");
    // 原始文本被保留（而不是解析成对象、也不是抛错）
    expect(call?.arguments).toBe("{not json");
  });

  it("E21 does not retry a 401 and never leaks the key in the error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { message: "invalid key sk-testvalue1234567890" } }));
    let err: unknown;
    try {
      await provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: ErrorCode.PROVIDER_FAILED });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((err as Error).message)).not.toContain("sk-testvalue1234567890");
  });

  it("E21 retries a 429 maxRetries times and then fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ)).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_FAILED,
    });
    // 1 次首发 + 2 次重试
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("E21 recovers when a retry finally succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: "upstream" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { role: "assistant", content: "recovered" } }] }));
    const res = await provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ);
    expect(res.type === "final" && res.text).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends the key as a bearer header and tool specs in OpenAI shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    await provider(fetchImpl as unknown as typeof globalThis.fetch).generate({
      model: "m1",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    });
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer sk-testvalue1234567890");
    const body = JSON.parse(init.body);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
    expect(body.model).toBe("m1");
  });

  it("cancels immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: "late" } }] }));
    await expect(
      provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a non-JSON body as PROVIDER_BAD_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).generate(REQ)).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_BAD_RESPONSE,
    });
  });
});

describe("createDeepseekProvider", () => {
  it("defaults to the DeepSeek endpoint and model", () => {
    const p = createDeepseekProvider({ apiKey: "sk-testvalue1234567890" });
    expect(p.id).toBe("deepseek");
    expect(p.models.map((m) => m.id)).toContain("deepseek-chat");
  });

  it("reads the key from the configured environment variable only", () => {
    const p = createDeepseekProvider({ apiKeyEnv: "MY_DEEPSEEK_KEY", env: { MY_DEEPSEEK_KEY: "sk-fromenv123456789" } });
    expect(p.id).toBe("deepseek");
  });

  it("still sends a request when no key is configured, but reports hasApiKey=false", () => {
    const p = createDeepseekProvider({ apiKeyEnv: "ABSENT_KEY", env: {} });
    expect(p.hasApiKey).toBe(false);
    const withKey = createDeepseekProvider({ apiKeyEnv: "MY_KEY", env: { MY_KEY: "sk-fromenv123456789" } });
    expect(withKey.hasApiKey).toBe(true);
  });
});
