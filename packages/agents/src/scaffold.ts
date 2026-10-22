/**
 * `agentx agent init <name>` 的脚手架。
 *
 * 只写文件、不联网。生成的 SOUL.md 带可删除的示例段与字段注释，
 * 让用户不用查文档就能改出一个能用的 agent。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface ScaffoldOptions {
  /** agents 根目录（通常是 ~/.agentx/agents）。 */
  agentsRoot: string;
  name: string;
  /** 已存在时是否覆盖 SOUL.md。 */
  force?: boolean;
}

export interface ScaffoldResult {
  ok: boolean;
  /** 实际创建/覆盖的路径。 */
  soulFile?: string;
  skillsDir?: string;
  /** ok=false 时的原因。 */
  reason?: "EEXIST";
  message?: string;
}

export function soulTemplate(name: string): string {
  return `---
name: ${name}
description: 一句话说明这个 agent 负责什么
# model: deepseek:deepseek-chat      # 可选：覆盖全局默认模型
# skills: [example-skill]             # 可选：只允许加载这些技能（白名单）
---

# 你是 ${name}

（这段正文就是你的 SOUL：身份、职责、判断标准、说话方式。
每次会话开始时它会被完整注入 system prompt 的最前面，所以要写成
「你是谁、你负责什么、你如何判断」，而不是一次性的任务描述。）

## 职责

- 你负责 ……（写清边界：做什么、不做什么）
- 遇到超出职责范围的请求，说明原因并交还给用户，不要自行扩大范围。

## 判断标准

- 拿不准时先查证，再回答；不臆测未读过的代码或未验证的结论。
- 输出要有依据：引用文件路径、命令输出或具体数据。

## 说话方式

- 简洁、直接，先说结论再说原因。
`;
}

export function exampleSkillTemplate(): string {
  return `---
name: example-skill
description: 示例技能，可删除
version: 1.0.0
tags: [example]
---

# 示例技能

## 适用条件
说明什么时候该用这个技能。

## 步骤
1. 第一步
2. 第二步

## 约束
- 写清不该做什么。
`;
}

/**
 * 创建 agent 骨架。已存在且未指定 force 时返回 ok=false（EEXIST），绝不覆盖用户已写的 SOUL.md。
 */
export function scaffoldAgent(options: ScaffoldOptions): ScaffoldResult {
  const dir = path.join(options.agentsRoot, options.name);
  const soulFile = path.join(dir, "SOUL.md");
  const skillsDir = path.join(dir, "skills");
  const exampleDir = path.join(skillsDir, "example-skill");

  if (existsSync(soulFile) && !options.force) {
    return {
      ok: false,
      reason: "EEXIST",
      message: `${soulFile} already exists (use --force to overwrite)`,
    };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(soulFile, soulTemplate(options.name), "utf8");
  mkdirSync(exampleDir, { recursive: true });
  const exampleSkill = path.join(exampleDir, "SKILL.md");
  // force 时不覆盖用户可能已改过的示例技能，只在缺失时补。
  if (!existsSync(exampleSkill)) writeFileSync(exampleSkill, exampleSkillTemplate(), "utf8");

  return { ok: true, soulFile, skillsDir };
}
