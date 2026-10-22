import type { ModelProvider } from "./types.js";

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  provider: ModelProvider;
}

/** 按 id 保存 provider。 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private defaultProvider?: string;

  register(provider: ModelProvider, opts: { default?: boolean } = {}): this {
    this.providers.set(provider.id, provider);
    if (opts.default || this.defaultProvider === undefined) {
      this.defaultProvider = provider.id;
    }
    return this;
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) throw new Error(`provider not registered: ${id}`);
    this.defaultProvider = id;
  }

  get defaultProviderId(): string | undefined {
    return this.defaultProvider;
  }

  /**
   * 解析模型引用：
   * - "providerId:modelId" -> 指定 provider 与模型；
   * - "modelId" -> 默认 provider；若默认 provider 不含该模型但其它 provider 恰好声明，则使用该 provider。
   * 未指定模型时使用默认 provider 的声明 id（"providerId:modelId"）。
   */
  resolveModel(ref?: string): ResolvedModel {
    const fallbackId = this.defaultProvider;
    if (!ref || ref.trim() === "") {
      if (!fallbackId) throw new Error("no provider registered");
      const provider = this.providers.get(fallbackId);
      if (!provider) throw new Error(`provider not registered: ${fallbackId}`);
      const modelId = provider.models[0]?.id ?? "";
      return { providerId: provider.id, modelId, provider };
    }
    const idx = ref.indexOf(":");
    if (idx > 0) {
      const providerId = ref.slice(0, idx);
      const modelId = ref.slice(idx + 1);
      const provider = this.providers.get(providerId);
      if (!provider) throw new Error(`provider not registered: ${providerId}`);
      return { providerId, modelId, provider };
    }
    if (!fallbackId) throw new Error("no provider registered");
    const provider = this.providers.get(fallbackId);
    if (!provider) throw new Error(`provider not registered: ${fallbackId}`);
    const declared = provider.models.some((m) => m.id === ref);
    if (!declared) {
      for (const candidate of Array.from(this.providers.values())) {
        if (candidate.models.some((m) => m.id === ref)) {
          return { providerId: candidate.id, modelId: ref, provider: candidate };
        }
      }
    }
    return { providerId: provider.id, modelId: ref, provider };
  }
}
