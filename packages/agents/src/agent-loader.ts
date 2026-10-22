/**
 * agent 定义（SOUL.md）的发现与解析。
 *
 * 一个 agent = 一段持久人格/职责（SOUL.md 正文）+ 一组专属技能（skills/ 子目录）。
 * 区别于「技能」：技能是**可被任意 agent 取用的参考资料**，SOUL 是**这个 agent 的身份**，
 * 每次启动都无条件注入 system prompt 最前面。
 *
 * 目录布局：
 *   ~/.agentx/agents/<name>/SOUL.md
 *   ~/.agentx/agents/<name>/skills/<skill>/SKILL.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { parseFrontmatter } from "@agentx/skills";

/** 解析成功后的 agent 定义。 */
export interface AgentDefinition {
  /** agent 名，恒等于目录名。 */
  name: string;
  description: string;
  /** SOUL 正文（已 trim），注入 system prompt 最前面。 */
  soul: string;
  /** 可选的模型覆盖，形如 `provider:model` 或裸模型名。 */
  model?: string;
  /** 可选技能白名单；undefined 表示允许该 agent 目录下的全部技能。 */
  skillWhitelist?: string[];
  /** 目录绝对路径。 */
  dir: string;
  /** SOUL.md 绝对路径。 */
  soulFile: string;
  /** 该 agent 的 skills 目录（即使不存在也返回路径，便于提示）。 */
  skillsDir: string;
  /**
   * 该 agent 的配置文件路径（`<dir>/config.json`，可能不存在）。
   *
   * 存在时在全局 `~/.agentx/config.json` 之后合并，用于「这个 agent 的默认设定」
   * ——模型、策略、工具白名单等。字段与全局配置文件完全相同。
   */
  configFile: string;
  /** config.json 是否实际存在。 */
  hasConfigFile: boolean;
  /** SOUL.md 的字节数（用于体积提示）。 */
  soulBytes: number;
}

/** 解析失败的单项。 */
export interface InvalidAgent {
  name: string;
  dir: string;
  /** 机器可读的原因码。 */
  code: AgentErrorCode;
  /** 人可读的说明。 */
  message: string;
}

export type AgentErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_SOUL_MISSING"
  | "AGENT_FRONTMATTER_INVALID"
  | "AGENT_NAME_MISMATCH"
  | "AGENT_DESCRIPTION_MISSING"
  | "AGENT_SOUL_EMPTY"
  | "AGENT_SOUL_TOO_LARGE"
  | "AGENT_NAME_INVALID"
  | "AGENT_UNREADABLE";

export interface AgentScanResult {
  agents: AgentDefinition[];
  invalid: InvalidAgent[];
}

export interface AgentScanOptions {
  /** 依次尝试的 agents 根目录；先出现的优先。 */
  dirs: string[];
  /** SOUL.md 体积上限（字节），默认与技能一致 256KiB。 */
  maxBytes?: number;
}

export const DEFAULT_SOUL_MAX_BYTES = 262144;

/**
 * agent 名只允许字母、数字、`_`、`-`、`.`，且不能是 `.`/`..`、不能含路径分隔符。
 *
 * 这是防目录穿越的唯一关口：`agentx agent ../../etc chat` 必须在查表前就被拒绝，
 * 否则 path.join 会把 name 拼成任意路径。
 */
export function isValidAgentName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.length > 128) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith(".");
}

/** 解析单个 agent 目录；不抛异常，失败返回 InvalidAgent。 */
export function parseAgentDir(dir: string, expectedName: string, maxBytes = DEFAULT_SOUL_MAX_BYTES): AgentDefinition | InvalidAgent {
  const name = expectedName;
  const soulFile = path.join(dir, "SOUL.md");
  const skillsDir = path.join(dir, "skills");

  if (!existsSync(soulFile)) {
    return {
      name,
      dir,
      code: "AGENT_SOUL_MISSING",
      message: `missing SOUL.md in ${dir}`,
    };
  }

  let raw: string;
  let bytes: number;
  try {
    const stat = statSync(soulFile);
    bytes = stat.size;
    if (bytes > maxBytes) {
      return {
        name,
        dir,
        code: "AGENT_SOUL_TOO_LARGE",
        message: `SOUL.md is ${bytes} bytes, over the ${maxBytes}-byte limit`,
      };
    }
    raw = readFileSync(soulFile, "utf8");
  } catch (err) {
    return {
      name,
      dir,
      code: "AGENT_UNREADABLE",
      message: `cannot read ${soulFile}: ${(err as Error).message}`,
    };
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    return {
      name,
      dir,
      code: "AGENT_FRONTMATTER_INVALID",
      message: `SOUL.md has no YAML frontmatter (expected a leading --- block) in ${soulFile}`,
    };
  }

  const fields = parsed.fields;
  const declaredName = Array.isArray(fields.name) ? undefined : fields.name;
  if (!declaredName) {
    return {
      name,
      dir,
      code: "AGENT_FRONTMATTER_INVALID",
      message: `SOUL.md frontmatter is missing "name" in ${soulFile}`,
    };
  }
  // 名字必须与目录一致：否则 `agentx agent a` 可能读到 b 的定义，命名与内容就对不上了。
  if (declaredName !== name) {
    return {
      name,
      dir,
      code: "AGENT_NAME_MISMATCH",
      message: `frontmatter name "${declaredName}" does not match directory name "${name}"`,
    };
  }

  const description = Array.isArray(fields.description) ? undefined : fields.description;
  if (!description || description.trim() === "") {
    return {
      name,
      dir,
      code: "AGENT_DESCRIPTION_MISSING",
      message: `SOUL.md frontmatter is missing a non-empty "description" in ${soulFile}`,
    };
  }

  const soul = parsed.body.trim();
  if (soul === "") {
    return {
      name,
      dir,
      code: "AGENT_SOUL_EMPTY",
      message: `SOUL.md body is empty in ${soulFile}`,
    };
  }

  const model = Array.isArray(fields.model) ? undefined : fields.model;
  const whitelistRaw = fields.skills;
  const skillWhitelist = Array.isArray(whitelistRaw)
    ? whitelistRaw.map((s) => s.trim()).filter((s) => s !== "")
    : undefined;

  const configFile = path.join(dir, "config.json");
  const hasConfigFile = existsSync(configFile);

  const def: AgentDefinition = {
    name,
    description: description.trim(),
    soul,
    dir,
    soulFile,
    skillsDir,
    configFile,
    hasConfigFile,
    soulBytes: bytes,
  };
  if (model && model.trim() !== "") def.model = model.trim();
  if (skillWhitelist && skillWhitelist.length > 0) def.skillWhitelist = skillWhitelist;
  return def;
}

/** 扫描所有 agents 目录。同名时先出现的优先。 */
export function scanAgents(options: AgentScanOptions): AgentScanResult {
  const maxBytes = options.maxBytes ?? DEFAULT_SOUL_MAX_BYTES;
  const agents: AgentDefinition[] = [];
  const invalid: InvalidAgent[] = [];
  const seen = new Set<string>();

  for (const root of options.dirs) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // 目录不存在或不可读：静默跳过（用户可能只用全局 agents，没配项目本地目录）。
      continue;
    }
    for (const name of entries.sort()) {
      if (!isValidAgentName(name)) continue;
      const dir = path.join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const parsed = parseAgentDir(dir, name, maxBytes);
      if ("code" in parsed) {
        // 同名已被前面的目录占住时，不再重复报错，避免噪音。
        if (!seen.has(name)) invalid.push(parsed);
        continue;
      }
      if (seen.has(name)) continue; // 先出现的优先
      seen.add(name);
      agents.push(parsed);
    }
  }

  return { agents, invalid };
}

/** 按名字查找；找不到返回 undefined。 */
export function findAgent(result: AgentScanResult, name: string): AgentDefinition | undefined {
  return result.agents.find((a) => a.name === name);
}

/** 找出 invalid 里指定名字的条目（用于给出生效的失败原因）。 */
export function findInvalidAgent(result: AgentScanResult, name: string): InvalidAgent | undefined {
  return result.invalid.find((a) => a.name === name);
}
