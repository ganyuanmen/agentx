import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  DEFAULT_SOUL_MAX_BYTES,
  findAgent,
  findInvalidAgent,
  isValidAgentName,
  parseAgentDir,
  scanAgents,
} from "../src/agent-loader.js";
import { scaffoldAgent, soulTemplate } from "../src/scaffold.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentx-agents-"));
});

afterEach(() => {
  try {
    chmodSync(root, 0o755);
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true });
});

/** 写一个 agent 目录；soul 为 undefined 时不写 SOUL.md。 */
function writeAgent(name: string, soul: string | undefined, opts: { skills?: string[] } = {}): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (soul !== undefined) writeFileSync(path.join(dir, "SOUL.md"), soul, "utf8");
  for (const skill of opts.skills ?? []) {
    const sdir = path.join(dir, "skills", skill);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(
      path.join(sdir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: test skill\n---\n\n# ${skill}\n`,
      "utf8",
    );
  }
  return dir;
}

const goodSoul = `---
name: demo
description: 演示 agent
---

# 你是 demo

负责演示。
`;

describe("isValidAgentName (E1 目录穿越)", () => {
  it("accepts ordinary names", () => {
    for (const n of ["demo", "code-reviewer", "a_b.c", "A1"]) {
      expect(isValidAgentName(n)).toBe(true);
    }
  });

  it("rejects path traversal and separators", () => {
    // 这是唯一关口：path.join(root, '../../etc') 会逃出 agents 目录
    for (const n of ["..", ".", "../etc", "a/b", "a\\b", "", "a\u0000b"]) {
      expect(isValidAgentName(n)).toBe(false);
    }
  });

  it("rejects hidden names and over-long names", () => {
    expect(isValidAgentName(".hidden")).toBe(false);
    expect(isValidAgentName("x".repeat(129))).toBe(false);
  });
});

describe("parseAgentDir — happy path", () => {
  it("parses name, description, soul body and paths", () => {
    const dir = writeAgent("demo", goodSoul, { skills: ["alpha"] });
    const def = parseAgentDir(dir, "demo");
    expect("code" in def).toBe(false);
    if ("code" in def) return;
    expect(def.name).toBe("demo");
    expect(def.description).toBe("演示 agent");
    expect(def.soul).toContain("你是 demo");
    expect(def.soul).not.toContain("---");
    expect(def.dir).toBe(dir);
    expect(def.soulFile).toBe(path.join(dir, "SOUL.md"));
    expect(def.skillsDir).toBe(path.join(dir, "skills"));
    expect(def.soulBytes).toBeGreaterThan(0);
  });

  it("reads optional model and skills whitelist", () => {
    const dir = writeAgent(
      "demo",
      `---
name: demo
description: d
model: deepseek:deepseek-chat
skills: [alpha, beta]
---

body
`,
    );
    const def = parseAgentDir(dir, "demo");
    if ("code" in def) throw new Error(def.message);
    expect(def.model).toBe("deepseek:deepseek-chat");
    expect(def.skillWhitelist).toEqual(["alpha", "beta"]);
  });

  it("supports a YAML list form for skills", () => {
    const dir = writeAgent(
      "demo",
      `---
name: demo
description: d
skills:
  - alpha
  - beta
---

body
`,
    );
    const def = parseAgentDir(dir, "demo");
    if ("code" in def) throw new Error(def.message);
    expect(def.skillWhitelist).toEqual(["alpha", "beta"]);
  });

  it("leaves model and whitelist undefined when absent", () => {
    const dir = writeAgent("demo", goodSoul);
    const def = parseAgentDir(dir, "demo");
    if ("code" in def) throw new Error(def.message);
    expect(def.model).toBeUndefined();
    expect(def.skillWhitelist).toBeUndefined();
  });
});

describe("parseAgentDir — invalid definitions (E2-E6)", () => {
  it("E2: missing SOUL.md", () => {
    const dir = writeAgent("demo", undefined);
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_SOUL_MISSING" });
  });

  it("E3: no frontmatter", () => {
    const dir = writeAgent("demo", "# 没有 frontmatter\n");
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_FRONTMATTER_INVALID" });
  });

  it("E3b: frontmatter without name", () => {
    const dir = writeAgent("demo", `---\ndescription: d\n---\n\nbody\n`);
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_FRONTMATTER_INVALID" });
  });

  it("E4: name does not match the directory", () => {
    // 不校验会让 `agentx agent a` 读到 b 的定义
    const dir = writeAgent("demo", `---\nname: other\ndescription: d\n---\n\nbody\n`);
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_NAME_MISMATCH" });
    if ("code" in r) expect(r.message).toContain("other");
  });

  it("E4b: missing description", () => {
    const dir = writeAgent("demo", `---\nname: demo\n---\n\nbody\n`);
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_DESCRIPTION_MISSING" });
  });

  it("E5: empty body", () => {
    const dir = writeAgent("demo", `---\nname: demo\ndescription: d\n---\n\n   \n`);
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_SOUL_EMPTY" });
  });

  it("E6: body over the size limit", () => {
    const dir = writeAgent("demo", goodSoul);
    const r = parseAgentDir(dir, "demo", 10);
    expect(r).toMatchObject({ code: "AGENT_SOUL_TOO_LARGE" });
  });

  it("E10: unreadable SOUL.md does not throw", () => {
    // 用目录冒充文件，readFileSync 会抛 EISDIR
    const dir = path.join(root, "demo");
    mkdirSync(path.join(dir, "SOUL.md"), { recursive: true });
    const r = parseAgentDir(dir, "demo");
    expect(r).toMatchObject({ code: "AGENT_UNREADABLE" });
  });
});

describe("scanAgents", () => {
  it("lists valid agents and reports invalid ones without throwing", () => {
    writeAgent("alpha", `---\nname: alpha\ndescription: A\n---\n\nA body\n`);
    writeAgent("broken", `---\nname: broken\n---\n\nbody\n`);
    writeAgent(
      "demo",
      `---\nname: demo\ndescription: D\n---\n\nD body\n`,
      { skills: ["s1", "s2"] },
    );
    const r = scanAgents({ dirs: [root] });
    expect(r.agents.map((a) => a.name).sort()).toEqual(["alpha", "demo"]);
    expect(r.invalid.map((a) => a.name)).toEqual(["broken"]);
    expect(findAgent(r, "demo")?.description).toBe("D");
    expect(findInvalidAgent(r, "broken")?.code).toBe("AGENT_DESCRIPTION_MISSING");
  });

  it("E8: earlier directories win on duplicate names", () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    // 显式构造两个同名 agent
    mkdirSync(path.join(first, "demo"), { recursive: true });
    writeFileSync(path.join(first, "demo", "SOUL.md"), `---\nname: demo\ndescription: from-first\n---\n\nbody\n`);
    mkdirSync(path.join(second, "demo"), { recursive: true });
    writeFileSync(path.join(second, "demo", "SOUL.md"), `---\nname: demo\ndescription: from-second\n---\n\nbody\n`);

    const r = scanAgents({ dirs: [first, second] });
    const demo = r.agents.filter((a) => a.name === "demo");
    expect(demo).toHaveLength(1);
    expect(demo[0]?.description).toBe("from-first");
  });

  it("skips missing directories without failing", () => {
    const r = scanAgents({ dirs: [path.join(root, "nope"), root] });
    expect(r.agents).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it("ignores non-directory entries and hidden dirs", () => {
    writeFileSync(path.join(root, "stray.txt"), "x");
    mkdirSync(path.join(root, ".hidden"));
    const r = scanAgents({ dirs: [root] });
    expect(r.agents).toEqual([]);
  });
});

describe("agent config.json", () => {
  it("reports hasConfigFile=false and the expected path when absent", () => {
    const dir = writeAgent("demo", goodSoul);
    const def = parseAgentDir(dir, "demo");
    if ("code" in def) throw new Error(def.message);
    expect(def.hasConfigFile).toBe(false);
    expect(def.configFile).toBe(path.join(dir, "config.json"));
  });

  it("detects a config.json next to SOUL.md", () => {
    const dir = writeAgent("demo", goodSoul);
    writeFileSync(path.join(dir, "config.json"), '{"maxSteps":3}', "utf8");
    const def = parseAgentDir(dir, "demo");
    if ("code" in def) throw new Error(def.message);
    expect(def.hasConfigFile).toBe(true);
  });

  it("does not validate config.json contents (that is loadConfig's job)", () => {
    // 解析阶段只负责「有没有」，内容合法性交给 Zod：两处校验会给出不一致的错误信息
    const dir = writeAgent("demo", goodSoul);
    writeFileSync(path.join(dir, "config.json"), "{ broken", "utf8");
    const def = parseAgentDir(dir, "demo");
    expect("code" in def).toBe(false);
  });
});

describe("scaffoldAgent (AC1)", () => {
  it("creates SOUL.md and a skills dir", () => {
    const r = scaffoldAgent({ agentsRoot: root, name: "demo" });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(root, "demo", "SOUL.md"))).toBe(true);
    expect(existsSync(path.join(root, "demo", "skills", "example-skill", "SKILL.md"))).toBe(true);
    // 生成的模板必须自己就能解析通过
    const def = parseAgentDir(path.join(root, "demo"), "demo");
    expect("code" in def).toBe(false);
  });

  it("creates config.json alongside SOUL.md", () => {
    const r = scaffoldAgent({ agentsRoot: root, name: "demo" });
    expect(r.ok).toBe(true);
    const cfgPath = path.join(root, "demo", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    // 必须是合法 JSON，否则 agent 一启动就炸
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed).toHaveProperty("defaultModel");
  });

  it("--force does not clobber a user-tuned config.json", () => {
    scaffoldAgent({ agentsRoot: root, name: "demo" });
    const cfgPath = path.join(root, "demo", "config.json");
    writeFileSync(cfgPath, '{"maxSteps":3}', "utf8");
    scaffoldAgent({ agentsRoot: root, name: "demo", force: true });
    // 配置文件是用户精调过的模型/策略，误覆盖代价比 SOUL 更大
    expect(readFileSync(cfgPath, "utf8")).toBe('{"maxSteps":3}');
  });

  it("refuses to overwrite an existing SOUL.md without --force", () => {
    scaffoldAgent({ agentsRoot: root, name: "demo" });
    writeFileSync(path.join(root, "demo", "SOUL.md"), "MY EDITS", "utf8");
    const r = scaffoldAgent({ agentsRoot: root, name: "demo" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("EEXIST");
    const still = parseAgentDir(path.join(root, "demo"), "demo");
    // 用户内容不能被脚手架覆盖（这里因为缺 frontmatter 而 INVALID，但内容是原始的）
    expect("code" in still).toBe(true);
  });

  it("--force overwrites SOUL.md but keeps the user's edited example skill", () => {
    scaffoldAgent({ agentsRoot: root, name: "demo" });
    const skillFile = path.join(root, "demo", "skills", "example-skill", "SKILL.md");
    writeFileSync(skillFile, "EDITED SKILL", "utf8");
    const r = scaffoldAgent({ agentsRoot: root, name: "demo", force: true });
    expect(r.ok).toBe(true);
    const def = parseAgentDir(path.join(root, "demo"), "demo");
    expect("code" in def).toBe(false);
    // 示例技能不覆盖用户改动
    expect(require("node:fs").readFileSync(skillFile, "utf8")).toBe("EDITED SKILL");
  });

  it("template declares the same name it was given", () => {
    expect(soulTemplate("my-agent")).toContain("name: my-agent");
  });

  it("respects the default size limit constant", () => {
    expect(DEFAULT_SOUL_MAX_BYTES).toBe(262144);
  });
});
