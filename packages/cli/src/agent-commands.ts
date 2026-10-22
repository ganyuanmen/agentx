/**
 * `agentx agent` 命令族的执行逻辑。
 *
 * 关键设计：`agent <name> chat` / `agent <name> run` **复用** executeChat / executeRun，
 * 只把解析出的 AgentDefinition 塞进 options。这样 TTY 渲染、状态栏、审批、退出码、
 * 管道行为全部自动一致——重写一份「agent 版 chat」必然会逐渐偏离主实现。
 */
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { findAgent, findInvalidAgent, isValidAgentName, scanAgents, scaffoldAgent } from "@agentx/agents";
import type { AgentDefinition } from "@agentx/agents";
import { loadConfig } from "@agentx/core";

/** 退出码取自 main.ts 的 EXIT，避免循环依赖，这里重复声明数值。 */
const EXIT_OK = 0;
const EXIT_USAGE = 2;

export interface AgentContext {
  env: Record<string, string | undefined>;
  stdout: { write(c: string): unknown };
  stderr: { write(c: string): unknown };
}

/** agents 根目录：$AGENTX_HOME/agents（默认 ~/.agentx/agents）。 */
export function agentsRootFor(env: Record<string, string | undefined>): { root: string; home: string; extra: string[]; maxBytes: number } {
  const loaded = loadConfig({ home: env.AGENTX_HOME, env });
  const cwd = path.resolve(loaded.config.cwd);
  const extra = loaded.config.agents.dirs.map((d) => (path.isAbsolute(d) ? d : path.resolve(cwd, d)));
  return {
    root: path.join(loaded.home, "agents"),
    home: loaded.home,
    extra,
    maxBytes: loaded.config.agents.maxBytes,
  };
}

/**
 * 解析指定名字的 agent。失败时返回 { code, message } 供调用方决定退出码。
 *
 * 名字先过 isValidAgentName（防目录穿越），再查表；查不到时如果该名字
 * 在 invalid 列表里，就把具体原因回给用户，而不是笼统的 not found。
 */
export function resolveAgentByName(
  name: string,
  env: Record<string, string | undefined>,
): { agent: AgentDefinition } | { error: string; exitCode: number } {
  if (!isValidAgentName(name)) {
    return {
      error: `invalid agent name "${name}" (letters, digits, ".", "_" and "-" only; no path separators)`,
      exitCode: EXIT_USAGE,
    };
  }
  const { root, extra, maxBytes } = agentsRootFor(env);
  const scan = scanAgents({ dirs: [root, ...extra], maxBytes });
  const agent = findAgent(scan, name);
  if (agent) return { agent };
  const invalid = findInvalidAgent(scan, name);
  if (invalid) return { error: `${name}: ${invalid.message}`, exitCode: EXIT_USAGE };
  const known = scan.agents.map((a) => a.name);
  const suffix = known.length > 0 ? ` (available: ${known.join(", ")})` : ` (none found in ${root})`;
  return { error: `agent not found: ${name}${suffix}`, exitCode: EXIT_USAGE };
}

export interface AgentListRow {
  name: string;
  description: string;
  model?: string;
  skills: number;
  path: string;
  valid: boolean;
  reason?: string;
}

/** 列出 agent；损坏项也列出但不影响退出码。 */
export function listAgents(env: Record<string, string | undefined>): AgentListRow[] {
  const { root, extra, maxBytes } = agentsRootFor(env);
  const scan = scanAgents({ dirs: [root, ...extra], maxBytes });
  const rows: AgentListRow[] = [];
  for (const agent of scan.agents) {
    rows.push({
      name: agent.name,
      description: agent.description,
      ...(agent.model ? { model: agent.model } : {}),
      skills: countSkillsSync(agent),
      path: agent.dir,
      valid: true,
    });
  }
  for (const bad of scan.invalid) {
    rows.push({
      name: bad.name,
      description: "",
      skills: 0,
      path: bad.dir,
      valid: false,
      reason: bad.message,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** 数一个 agent 目录下的技能数（只看 `skills/<name>/SKILL.md` 是否存在）。 */
export function countSkillsSync(agent: AgentDefinition): number {
  try {
    return readdirSync(agent.skillsDir).filter((d) => existsSync(path.join(agent.skillsDir, d, "SKILL.md"))).length;
  } catch {
    return 0;
  }
}

export interface AgentScaffoldOutcome {
  ok: boolean;
  soulFile?: string;
  message?: string;
}

export function initAgent(name: string, env: Record<string, string | undefined>, force: boolean): AgentScaffoldOutcome {
  if (!isValidAgentName(name)) {
    return { ok: false, message: `invalid agent name "${name}"` };
  }
  const { root } = agentsRootFor(env);
  const result = scaffoldAgent({ agentsRoot: root, name, force });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, ...(result.soulFile ? { soulFile: result.soulFile } : {}), message: `created ${result.soulFile}` };
}
