import { AgentxError, ErrorCode } from "./errors.js";
import type { ModelInfo, ModelProvider, ModelRequest, ModelResponse } from "./types.js";

export interface MockScriptItem {
  sleepMs?: number;
  response: ModelResponse;
}

export type MockScript = ModelResponse[] | MockScriptItem[] | ((req: ModelRequest) => ModelResponse);

export interface MockProviderOptions {
  id?: string;
  script?: MockScript;
  models?: ModelInfo[];
}

function isScriptItem(v: unknown): v is MockScriptItem {
  return (
    typeof v === "object" &&
    v !== null &&
    "response" in v &&
    typeof (v as { response: unknown }).response === "object"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 脚本化 provider。script 为数组时按序弹出（支持 {sleepMs, response} 形式），
 * 为函数时每次调用生成响应。每次 generate 都把请求深拷贝进 this.calls。
 */
export class MockProvider implements ModelProvider {
  readonly id: string;
  readonly models: ModelInfo[];
  readonly calls: ModelRequest[] = [];
  private readonly script?: MockScript;
  private readonly queue: MockScriptItem[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "mock";
    this.models = options.models ?? [{ id: "mock-1", supportsTools: true }];
    this.script = options.script;
    if (Array.isArray(options.script)) {
      for (const item of options.script) {
        this.queue.push(isScriptItem(item) ? item : { response: item });
      }
    }
  }

  get remaining(): number {
    return this.queue.length;
  }

  async generate(req: ModelRequest, opts: { signal?: AbortSignal } = {}): Promise<ModelResponse> {
    this.calls.push(structuredClone(req));
    let response: ModelResponse;
    if (typeof this.script === "function") {
      response = this.script(req);
    } else {
      const item = this.queue.shift();
      if (!item) {
        throw new AgentxError(
          ErrorCode.PROVIDER_FAILED,
          `mock provider "${this.id}" script exhausted after ${this.calls.length} call(s)`,
        );
      }
      if (item.sleepMs && item.sleepMs > 0) {
        await sleep(item.sleepMs, opts.signal);
      }
      response = structuredClone(item.response);
    }
    return response;
  }
}
