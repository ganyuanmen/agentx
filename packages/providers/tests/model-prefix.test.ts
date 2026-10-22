import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider, stripProviderPrefix } from "../src/openai-compatible.js";

describe("stripProviderPrefix", () => {
  it("removes a provider prefix", () => {
    // agentx 内部用 provider:model 引用；OpenAI 兼容 API 只接受裸模型名。
    // 整个发出去 DeepSeek 会回 HTTP 400，且不提示是名字的问题。
    expect(stripProviderPrefix("deepseek:deepseek-chat")).toBe("deepseek-chat");
    expect(stripProviderPrefix("local:qwen3-27b")).toBe("qwen3-27b");
  });

  it("leaves bare model names untouched", () => {
    expect(stripProviderPrefix("deepseek-chat")).toBe("deepseek-chat");
    expect(stripProviderPrefix("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("strips only the first colon so ids containing colons survive", () => {
    expect(stripProviderPrefix("p:model:variant")).toBe("model:variant");
  });

  it("does not strip when the prefix contains whitespace", () => {
    // "my model:1" 更像是模型名本身，而不是 provider 前缀
    expect(stripProviderPrefix("my model:1")).toBe("my model:1");
  });

  it("does not mangle leading or trailing colons", () => {
    expect(stripProviderPrefix(":model")).toBe(":model");
    expect(stripProviderPrefix("provider:")).toBe("provider:");
  });
});

describe("request body uses the bare model name", () => {
  it("sends the model without the provider prefix", async () => {
    let sentBody: { model?: string } | undefined;
    const provider = new OpenAiCompatibleProvider({
      id: "deepseek",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
      models: [{ id: "deepseek-chat", supportsTools: true }],
      maxRetries: 0,
      timeoutMs: 1000,
      retryBaseMs: 0,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await provider.generate({
      model: "deepseek:deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    expect(sentBody?.model).toBe("deepseek-chat");
  });
});
