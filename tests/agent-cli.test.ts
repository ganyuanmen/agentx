import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "packages", "cli", "bin", "agentx.js");

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<RunOut> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: ROOT, env: { ...process.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: number }).code === "number"
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "agentx-agent-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const soul = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: agent ${name}\n${extra}---\n\n# 你是 ${name.toUpperCase()}_SOUL\n\n只做分内的事。\n`;

function seedAgent(name: string, extra = ""): string {
  const dir = path.join(home, "agents", name);
  mkdirSync(path.join(dir, "skills", "s1"), { recursive: true });
  writeFileSync(path.join(dir, "SOUL.md"), soul(name, extra), "utf8");
  writeFileSync(
    path.join(dir, "skills", "s1", "SKILL.md"),
    `---\nname: s1\ndescription: skill one\n---\n\n# s1 body\n`,
    "utf8",
  );
  return dir;
}

describe("agentx agent init (AC1)", () => {
  it("creates SOUL.md and an example skill", async () => {
    const r = await run(["agent", "init", "demo"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("created");
    expect(existsSync(path.join(home, "agents", "demo", "SOUL.md"))).toBe(true);
    expect(existsSync(path.join(home, "agents", "demo", "skills", "example-skill", "SKILL.md"))).toBe(true);
    // 生成的内容必须能被自己的解析器接受
    const list = await run(["agent", "list"], { AGENTX_HOME: home });
    expect(list.stdout).toContain("demo");
    expect(list.stdout).not.toContain("INVALID");
  });

  it("refuses to overwrite without --force, exit code 2", async () => {
    await run(["agent", "init", "demo"], { AGENTX_HOME: home });
    const soulFile = path.join(home, "agents", "demo", "SOUL.md");
    writeFileSync(soulFile, "MY OWN SOUL", "utf8");
    const r = await run(["agent", "init", "demo"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(soulFile, "utf8")).toBe("MY OWN SOUL");
  });

  it("--force overwrites", async () => {
    await run(["agent", "init", "demo"], { AGENTX_HOME: home });
    const soulFile = path.join(home, "agents", "demo", "SOUL.md");
    writeFileSync(soulFile, "MY OWN SOUL", "utf8");
    const r = await run(["agent", "init", "demo", "--force"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(readFileSync(soulFile, "utf8")).not.toBe("MY OWN SOUL");
  });
});

describe("agentx agent list / show (AC2)", () => {
  it("lists valid agents with their skill count", async () => {
    seedAgent("alpha");
    seedAgent("beta");
    const r = await run(["agent", "list"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("beta");
    expect(r.stdout).toMatch(/alpha\s+1\s+agent alpha/);
  });

  it("marks broken definitions INVALID but still exits 0", async () => {
    seedAgent("ok");
    const brokenDir = path.join(home, "agents", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "SOUL.md"), "---\nname: broken\n---\n\nbody\n", "utf8");
    const r = await run(["agent", "list"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("INVALID");
    expect(r.stdout).toContain("broken");
  });

  it("show prints the soul body", async () => {
    seedAgent("alpha");
    const r = await run(["agent", "show", "alpha"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ALPHA_SOUL");
    expect(r.stdout).toContain("agent alpha");
  });

  it("show --json is machine readable", async () => {
    seedAgent("alpha");
    const r = await run(["agent", "show", "alpha", "--json"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.name).toBe("alpha");
    expect(parsed.soul).toContain("ALPHA_SOUL");
  });

  it("show reports the agent config file", async () => {
    seedAgent("cfg");
    writeFileSync(path.join(home, "agents", "cfg", "config.json"), "{}", "utf8");
    const r = await run(["agent", "show", "cfg"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("config:");
    expect(r.stdout).toContain("config.json");
  });

  it("show says so when there is no agent config", async () => {
    seedAgent("nocfg");
    const r = await run(["agent", "show", "nocfg"], { AGENTX_HOME: home });
    expect(r.stdout).toContain("inherits global config");
  });

  it("show --json exposes configFile/hasConfigFile", async () => {
    seedAgent("cfg");
    writeFileSync(path.join(home, "agents", "cfg", "config.json"), "{}", "utf8");
    const r = await run(["agent", "show", "cfg", "--json"], { AGENTX_HOME: home });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.hasConfigFile).toBe(true);
    expect(parsed.configFile).toContain("config.json");
  });

  it("list is empty-safe", async () => {
    const r = await run(["agent", "list"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no agents found");
  });
});

describe("agent not found / traversal (AC5, AC6)", () => {
  it("unknown agent exits 2 with a helpful message", async () => {
    seedAgent("alpha");
    const r = await run(["nosuch", "chat"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("agent not found: nosuch");
    expect(r.stderr).toContain("alpha"); // 列出可用名字
  });

  it("rejects path traversal names", async () => {
    for (const bad of ["../etc", "a/b"]) {
      const r = await run([bad, "chat"], { AGENTX_HOME: home });
      expect(r.code).toBe(2);
    }
  });

  it("reports the concrete reason for a broken definition", async () => {
    const dir = path.join(home, "agents", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SOUL.md"), "---\nname: broken\n---\n\nbody\n", "utf8");
    const r = await run(["broken", "chat"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("description");
  });

  it("missing SOUL.md is reported, not a silent fallback", async () => {
    mkdirSync(path.join(home, "agents", "empty"), { recursive: true });
    const r = await run(["empty", "chat"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("SOUL.md");
  });
});

describe("skill whitelist (AC7)", () => {
  it("E7: a whitelist naming an unknown skill fails before entering the REPL", async () => {
    // 静默不加载会让用户以为技能生效了，在一个「没有该技能」的 agent 上排查半天
    const dir = path.join(home, "agents", "picky");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SOUL.md"), soul("picky", "skills: [no-such-skill]\n"), "utf8");
    const r = await run(["picky", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no-such-skill");
    expect(r.stderr).toContain("available:");
  });

  it("E7b: chat also refuses before the REPL, not just run", async () => {
    // 两层都有检查：executeChat 在进 REPL 前返回 2，runTurn 里抛 SetupFailure 兜底。
    // 只测 run 会漏掉 chat 那条路径（变异验证时确认过）。
    const dir = path.join(home, "agents", "picky");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SOUL.md"), soul("picky", "skills: [no-such-skill]\n"), "utf8");
    const r = await run(["picky", "chat"], { AGENTX_HOME: home }, "");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no-such-skill");
    // 不得进入 REPL（否则会看到 session 尾行或 new session 提示）
    expect(r.stdout).not.toContain("session ");
  });

  it("a whitelist naming a real skill starts fine", async () => {
    seedAgent("picky", "skills: [s1]\n");
    const r = await run(["picky", "run", "hi"], { AGENTX_HOME: home, AGENTX_MOCK_SCRIPT: mockScript() });
    // 能走到模型调用（这里没有 key，所以预期是 provider 失败而不是白名单失败）
    expect(r.stderr).not.toContain("unknown skill");
  });
});

describe("agent config.json (SPEC-008)", () => {
  it("init writes a config.json next to SOUL.md", async () => {
    await run(["agent", "init", "cfg"], { AGENTX_HOME: home });
    const cfgPath = path.join(home, "agents", "cfg", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    expect(() => JSON.parse(readFileSync(cfgPath, "utf8"))).not.toThrow();
  });

  it("the agent config overrides the global config", async () => {
    seedAgent("cfg");
    // 全局指向一个未注册的 provider，agent config 指向另一个未注册的；
    // 准备阶段报错里会点出实际尝试的那个，能直接观察优先级。
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "globalghost:g-1", policy: { approval: "none" } }),
      "utf8",
    );
    writeFileSync(
      path.join(home, "agents", "cfg", "config.json"),
      JSON.stringify({ defaultModel: "agentghost:a-1" }),
      "utf8",
    );
    const r = await run(["cfg", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("agentghost:a-1");
    expect(r.stderr).not.toContain("globalghost:g-1");
  });

  it("--model on the command line beats the agent config", async () => {
    seedAgent("cfg");
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "globalghost:g-1", policy: { approval: "none" } }),
      "utf8",
    );
    writeFileSync(path.join(home, "agents", "cfg", "config.json"), JSON.stringify({ defaultModel: "agentghost:a-1" }), "utf8");
    const r = await run(["cfg", "run", "hi", "--model", "clighost:c-1"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("clighost:c-1");
    expect(r.stderr).not.toContain("agentghost:a-1");
  });

  it("a malformed agent config fails loudly and names the file", async () => {
    seedAgent("cfg");
    writeFileSync(path.join(home, "agents", "cfg", "config.json"), "{ broken", "utf8");
    const r = await run(["cfg", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("config.json");
  });

  it("an unknown key in the agent config is rejected, not ignored", async () => {
    seedAgent("cfg");
    writeFileSync(path.join(home, "agents", "cfg", "config.json"), '{"maxStepz":3}', "utf8");
    const r = await run(["cfg", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/maxStepz|CONFIG_INVALID/i);
  });

  it("an agent without config.json still works (inherits global)", async () => {
    seedAgent("plain");
    // 用未注册的 provider：准备阶段就会报 unknown model，并打上模型名，
    // 这比「provider 存在但网络不通」更容易观察到实际用的是哪个 model。
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "ghost:ghost-1", policy: { approval: "none" } }),
      "utf8",
    );
    const r = await run(["plain", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ghost:ghost-1");
  });
});

describe("agent model override (AC8)", () => {
  it("uses the SOUL model when --model is absent", async () => {
    // 用一个不存在的模型名，报错信息里会显示实际尝试的模型
    seedAgent("withModel", "model: nosuch:model-9\n");
    const r = await run(["withModel", "run", "hi"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nosuch:model-9");
  });

  it("command-line --model wins over the SOUL model", async () => {
    seedAgent("withModel", "model: nosuch:model-9\n");
    const r = await run(["withModel", "run", "hi", "--model", "alsobad:other-1"], { AGENTX_HOME: home });
    expect(r.code).toBe(2);
    // 命令行指定的模型才是实际尝试的那个
    expect(r.stderr).toContain("alsobad:other-1");
    expect(r.stderr).not.toContain("nosuch:model-9");
  });
});

function mockScript(): string {
  const p = path.join(home, `m-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    p,
    JSON.stringify([{ response: { type: "final", text: "ok", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }]),
    "utf8",
  );
  return p;
}

describe("existing commands are untouched", () => {
  it("version and sessions still work", async () => {
    const v = await run(["--version"], { AGENTX_HOME: home });
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const s = await run(["sessions", "list"], { AGENTX_HOME: home });
    expect(s.code).toBe(0);
  });

  it("canonical form agentx agent chat <name> also works", async () => {
    seedAgent("alpha");
    const r = await run(["agent", "chat", "alpha", "--help"], { AGENTX_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--model");
  });
});
