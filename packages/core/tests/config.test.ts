import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ensureHomeLayout, loadConfig, resolveHome, providerForModel, configSchema } from "../src/config.js";
import { AgentxError, ErrorCode } from "../src/errors.js";

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "agentx-cfg-"));
}

describe("loadConfig", () => {
  it("applies safe defaults when no config file exists", () => {
    const home = tmpHome();
    const { config, sources } = loadConfig({ home, env: {} });
    expect(sources).toEqual(["defaults"]);
    expect(config.defaultModel).toBe("deepseek-chat");
    expect(config.maxSteps).toBe(12);
    expect(config.timeoutMs).toBe(300000);
    expect(config.readOnly).toBe(false);
    expect(config.policy.approval).toBe("high");
    expect(config.tools.allow).toContain("read_file");
    expect(config.tools.exec.maxOutputBytes).toBe(100000);
    expect(config.context.historyMessages).toBe(30);
    rmSync(home, { recursive: true, force: true });
  });

  it("reports the offending field path when validation fails", () => {
    const home = tmpHome();
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ maxSteps: "many" }));
    let err: unknown;
    try {
      loadConfig({ home, env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentxError);
    expect((err as AgentxError).code).toBe(ErrorCode.CONFIG_INVALID);
    expect((err as AgentxError).message).toContain("maxSteps");
    expect((err as AgentxError).message).not.toContain("sk-");
    rmSync(home, { recursive: true, force: true });
  });

  it("overrides non-secret settings from environment variables", () => {
    const home = tmpHome();
    const { config } = loadConfig({
      home,
      env: { AGENTX_MODEL: "mock-1", AGENTX_READ_ONLY: "1", AGENTX_LOG_LEVEL: "debug" },
    });
    expect(config.defaultModel).toBe("mock-1");
    expect(config.readOnly).toBe(true);
    expect(config.logging.level).toBe("debug");
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves the home directory from AGENTX_HOME before falling back to ~/.agentx", () => {
    expect(resolveHome({ AGENTX_HOME: "/tmp/custom-home" })).toBe(path.resolve("/tmp/custom-home"));
    const fallback = resolveHome({});
    expect(fallback.endsWith(path.join(".agentx"))).toBe(true);
  });

  it("E16 keeps credentials out of the validated config shape", () => {
    const home = tmpHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        providers: { deepseek: { type: "deepseek", models: ["deepseek-chat"], apiKey: "sk-realsecret123456" } },
      }),
    );
    const { config } = loadConfig({ home, env: {} });
    // 配置文件里显式给出的 apiKey 会被加载（供 Provider 使用），
    // 但错误信息与日志必须脱敏——该保证由 logger.redactObject / configShow 断言覆盖。
    expect(config.providers.deepseek?.apiKey).toBe("sk-realsecret123456");
    expect(config.providers.deepseek?.models).toEqual(["deepseek-chat"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects an approval policy value outside the schema", () => {
    const res = configSchema.safeParse({ policy: { approval: "sometimes" } });
    expect(res.success).toBe(false);
  });
});

describe("ensureHomeLayout", () => {
  it("creates the runtime directories and keeps the data dir private", () => {
    const home = tmpHome();
    ensureHomeLayout(home);
    for (const sub of ["logs", "data", "memory", "skills"]) {
      expect(statSync(path.join(home, sub)).isDirectory()).toBe(true);
    }
    const mode = statSync(path.join(home, "data")).mode & 0o777;
    expect(mode).toBe(0o700);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("providerForModel", () => {
  it("resolves provider:model references and bare model names", () => {
    const home = tmpHome();
    const { config } = loadConfig({ home, env: {} });
    const explicit = providerForModel(config, "deepseek:deepseek-chat");
    expect(explicit.providerId).toBe("deepseek");
    expect(explicit.modelId).toBe("deepseek-chat");

    const bare = providerForModel(config, "mock-1");
    expect(bare.providerId).toBe("mock");
    rmSync(home, { recursive: true, force: true });
  });

  it("fails with CONFIG_INVALID for an unknown provider", () => {
    const home = tmpHome();
    const { config } = loadConfig({ home, env: {} });
    expect(() => providerForModel(config, "nope:model")).toThrowError(/nope/);
    rmSync(home, { recursive: true, force: true });
  });
});
