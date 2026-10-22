import {
  AgentxError,
  ErrorCode,
  MockProvider,
  type MockScript,
  type ModelProvider,
  type ProviderConfig,
} from "@agentx/core";
import { createDeepseekProvider } from "./deepseek.js";
import { OpenAiCompatibleProvider, type FetchLike } from "./openai-compatible.js";

export interface CreateProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  retryBaseMs?: number;
  /** mock provider 的脚本（测试注入）。 */
  mockScript?: MockScript;
}

function buildMock(script?: MockScript): MockProvider {
  return new MockProvider({ id: "mock", script: script ?? [] });
}

/** 按 provider 配置构造实现；未知 type 抛 CONFIG_INVALID。 */
export function createProvider(def: ProviderConfig, options: CreateProviderOptions = {}): ModelProvider {
  const env = options.env ?? process.env;
  switch (def.type) {
    case "mock":
      return buildMock(options.mockScript);
    case "deepseek":
      return createDeepseekProvider({
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        apiKeyEnv: def.apiKeyEnv,
        models: def.models,
        maxRetries: def.maxRetries,
        timeoutMs: def.timeoutMs,
        env,
        fetchImpl: options.fetchImpl,
        retryBaseMs: options.retryBaseMs,
      });
    case "openai-compatible": {
      if (!def.baseUrl) {
        throw new AgentxError(ErrorCode.CONFIG_INVALID, "providers.*.baseUrl: required for openai-compatible");
      }
      return new OpenAiCompatibleProvider({
        id: "openai-compatible",
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        apiKeyEnv: def.apiKeyEnv,
        models: def.models.map((id) => ({ id, supportsTools: true })),
        maxRetries: def.maxRetries,
        timeoutMs: def.timeoutMs,
        env,
        fetchImpl: options.fetchImpl,
        retryBaseMs: options.retryBaseMs,
      });
    }
    default: {
      const exhaustive: never = def.type;
      throw new AgentxError(ErrorCode.CONFIG_INVALID, `providers.*.type: unsupported type "${String(exhaustive)}"`);
    }
  }
}

/**
 * 按配置构造全部 providers，并用配置键作为 provider id 注册。
 * openai-compatible / deepseek 的 id 在这里被覆盖为配置键（如 "deepseek"、"local"）。
 */
export function createProviders(
  providers: Record<string, ProviderConfig>,
  options: CreateProviderOptions = {},
): ModelProvider[] {
  const out: ModelProvider[] = [];
  for (const [id, def] of Object.entries(providers)) {
    const base = createProvider(def, options);
    if (base.id === id) {
      out.push(base);
      continue;
    }
    Object.defineProperty(base, "id", { value: id, enumerable: true });
    out.push(base);
  }
  return out;
}
