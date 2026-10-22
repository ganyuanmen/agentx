import type { ProviderConfig } from "@agentx/core";
import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from "./openai-compatible.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface DeepseekOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models?: string[];
  maxRetries?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OpenAiCompatibleOptions["fetchImpl"];
  retryBaseMs?: number;
  onRetry?: OpenAiCompatibleOptions["onRetry"];
}

/** DeepSeek provider：复用 OpenAI 兼容适配器，id 与默认值不同。 */
export function createDeepseekProvider(options: DeepseekOptions = {}): OpenAiCompatibleProvider {
  const models = options.models && options.models.length > 0 ? options.models : [DEEPSEEK_DEFAULT_MODEL];
  return new OpenAiCompatibleProvider({
    id: "deepseek",
    baseUrl: options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv ?? "DEEPSEEK_API_KEY",
    models: models.map((id) => ({ id, supportsTools: true, contextLimit: 65536 })),
    maxRetries: options.maxRetries ?? 2,
    timeoutMs: options.timeoutMs ?? 120000,
    env: options.env,
    fetchImpl: options.fetchImpl,
    retryBaseMs: options.retryBaseMs,
    onRetry: options.onRetry,
  });
}

export type { ProviderConfig };
