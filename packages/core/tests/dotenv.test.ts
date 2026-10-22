import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig, loadDotEnv, parseDotEnv } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "agentx-dotenv-"));
});

describe("parseDotEnv", () => {
  it("parses plain, exported, quoted and commented lines", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "DEEPSEEK_API_KEY=sk-abc123",
        "export LOCAL_API_KEY='sk-local'",
        'QUOTED="value with spaces"',
        "INVALID LINE WITHOUT EQUALS",
        "1BADNAME=x",
      ].join("\n"),
    );

    expect(parsed.DEEPSEEK_API_KEY).toBe("sk-abc123");
    expect(parsed.LOCAL_API_KEY).toBe("sk-local");
    expect(parsed.QUOTED).toBe("value with spaces");
    expect(parsed["INVALID LINE WITHOUT EQUALS"]).toBeUndefined();
    expect(parsed["1BADNAME"]).toBeUndefined();
  });

  it("does not expand or execute anything in values", () => {
    const parsed = parseDotEnv("A=$(whoami)\nB=`id`\nC=$HOME/x");
    expect(parsed.A).toBe("$(whoami)");
    expect(parsed.B).toBe("`id`");
    expect(parsed.C).toBe("$HOME/x");
  });
});

describe("loadDotEnv", () => {
  it("reads <home>/.env when present", () => {
    const p = path.join(home, ".env");
    writeFileSync(p, "DEEPSEEK_API_KEY=sk-fromdotenv\n");
    chmodSync(p, 0o600);
    const res = loadDotEnv(home, {});
    expect(res.env.DEEPSEEK_API_KEY).toBe("sk-fromdotenv");
    expect(res.path).toBe(p);
    expect(res.warnings).toEqual([]);
  });

  it("lets real process environment win over .env", () => {
    writeFileSync(path.join(home, ".env"), "DEEPSEEK_API_KEY=from-dotenv\n");
    const res = loadDotEnv(home, { DEEPSEEK_API_KEY: "from-process" });
    // 真实环境变量优先级更高，便于临时覆盖而不改文件
    expect(res.env.DEEPSEEK_API_KEY).toBe("from-process");
  });

  it("returns the base env unchanged when no .env exists", () => {
    const res = loadDotEnv(home, { PATH: "/bin" });
    expect(res.path).toBeUndefined();
    expect(res.env.PATH).toBe("/bin");
    expect(res.warnings).toEqual([]);
  });

  it("warns when .env is readable by other users", () => {
    const p = path.join(home, ".env");
    writeFileSync(p, "DEEPSEEK_API_KEY=x\n");
    chmodSync(p, 0o644);
    const res = loadDotEnv(home, {});
    expect(res.warnings.join(" ")).toMatch(/readable by other users|chmod 600/i);
  });

  it("does not warn when .env is 0600", () => {
    const p = path.join(home, ".env");
    writeFileSync(p, "DEEPSEEK_API_KEY=x\n");
    chmodSync(p, 0o600);
    expect(loadDotEnv(home, {}).warnings).toEqual([]);
  });
});

describe("loadConfig with .env", () => {
  it("resolves a provider key from .env without touching the shell environment", () => {
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        defaultModel: "deepseek-chat",
        providers: {
          deepseek: { type: "deepseek", models: ["deepseek-chat"], apiKeyEnv: "DEEPSEEK_API_KEY" },
        },
      }),
    );
    writeFileSync(path.join(home, ".env"), "DEEPSEEK_API_KEY=sk-fromdotenv123\n");

    // 传入的 env 里没有 key，只有 .env 里有
    const loaded = loadConfig({ home, env: {} });

    expect(loaded.env?.DEEPSEEK_API_KEY).toBe("sk-fromdotenv123");
    expect(loaded.sources).toContain(path.join(home, ".env"));
    // 密钥不得出现在降级后的 config 对象里
    expect(JSON.stringify(loaded.config)).not.toContain("sk-fromdotenv123");
  });

  it("still lets a real environment variable override the .env value", () => {
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        defaultModel: "deepseek-chat",
        providers: {
          deepseek: { type: "deepseek", models: ["deepseek-chat"], apiKeyEnv: "DEEPSEEK_API_KEY" },
        },
      }),
    );
    writeFileSync(path.join(home, ".env"), "DEEPSEEK_API_KEY=from-dotenv\n");
    const loaded = loadConfig({ home, env: { DEEPSEEK_API_KEY: "from-process" } });
    expect(loaded.env?.DEEPSEEK_API_KEY).toBe("from-process");
    rmSync(home, { recursive: true, force: true });
  });
});
