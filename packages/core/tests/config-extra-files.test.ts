import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { loadConfig } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "agentx-cfg-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

describe("extraFiles: agent-level config (SPEC-008)", () => {
  it("overrides the global config file", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12, defaultModel: "deepseek:deepseek-chat" });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { maxSteps: 3 });

    const { config } = loadConfig({ home, env: {}, extraFiles: [agentCfg] });
    expect(config.maxSteps).toBe(3);
    // 未覆盖的字段仍继承全局值
    expect(config.defaultModel).toBe("deepseek:deepseek-chat");
  });

  it("is overridden by command-line overrides", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { maxSteps: 3 });

    const { config } = loadConfig({
      home,
      env: {},
      extraFiles: [agentCfg],
      overrides: { maxSteps: 7 },
    });
    // CLI 是「这一次运行」的显式意图，优先级最高
    expect(config.maxSteps).toBe(7);
  });

  it("is overridden by environment variables", () => {
    writeJson(path.join(home, "config.json"), { defaultModel: "deepseek:deepseek-chat", maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { defaultModel: "echo:echo-1", maxSteps: 3 });

    // AGENTX_MODEL 是受支持的环境覆盖项（maxSteps 没有对应环境变量）。
    const { config } = loadConfig({ home, env: { AGENTX_MODEL: "cli:model-1" }, extraFiles: [agentCfg] });
    // 环境变量同理，压过 agent 配置文件
    expect(config.defaultModel).toBe("cli:model-1");
    // agent config 里没有被环境变量覆盖的字段仍然生效
    expect(config.maxSteps).toBe(3);
  });

  it("deep-merges nested objects instead of replacing them", () => {
    writeJson(path.join(home, "config.json"), {
      policy: { approval: "high" },
      tools: { allow: ["read_file", "list_files"] },
    });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { tools: { allow: ["read_file"] } });

    const { config } = loadConfig({ home, env: {}, extraFiles: [agentCfg] });
    expect(config.tools.allow).toEqual(["read_file"]);
    // 数组是整体替换而不是拼接——拼接会让「收紧工具」的意图失效
    expect(config.policy.approval).toBe("high");
  });

  it("reports the agent config in sources so users can see it took effect", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { maxSteps: 3 });

    const { sources } = loadConfig({ home, env: {}, extraFiles: [agentCfg] });
    expect(sources).toContain(agentCfg);
  });

  it("silently skips a missing extra file", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const missing = path.join(home, "agents", "nope", "config.json");
    const { config, sources } = loadConfig({ home, env: {}, extraFiles: [missing] });
    expect(config.maxSteps).toBe(12);
    expect(sources).not.toContain(missing);
  });

  it("names the offending file when the agent config is not valid JSON", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    mkdirSync(path.dirname(agentCfg), { recursive: true });
    writeFileSync(agentCfg, "{ not json", "utf8");

    // 多条配置合并时，错误必须指出是哪一份坏了
    expect(() => loadConfig({ home, env: {}, extraFiles: [agentCfg] })).toThrow(/config\.json/);
    expect(() => loadConfig({ home, env: {}, extraFiles: [agentCfg] })).toThrow(/not valid JSON/);
  });

  it("rejects a non-object agent config", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    mkdirSync(path.dirname(agentCfg), { recursive: true });
    writeFileSync(agentCfg, "[1,2,3]", "utf8");
    expect(() => loadConfig({ home, env: {}, extraFiles: [agentCfg] })).toThrow(/JSON object/);
  });

  it("still rejects unknown keys coming from the agent config", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 12 });
    const agentCfg = path.join(home, "agents", "coder", "config.json");
    writeJson(agentCfg, { maxStepz: 3 });
    // strict schema：拼错的字段不能被静默忽略
    expect(() => loadConfig({ home, env: {}, extraFiles: [agentCfg] })).toThrow(/maxStepz|CONFIG_INVALID/i);
  });

  it("regression: with no extraFiles the behaviour is unchanged", () => {
    writeJson(path.join(home, "config.json"), { maxSteps: 5 });
    const { config } = loadConfig({ home, env: {} });
    expect(config.maxSteps).toBe(5);
  });
});
