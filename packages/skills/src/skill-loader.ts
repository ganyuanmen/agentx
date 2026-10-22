import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  /** 来源目录绝对路径。 */
  source: string;
  /** SKILL.md 路径。 */
  file?: string;
  /** 文件大小（字节）。 */
  bytes: number;
  tags: string[];
  /** frontmatter 中可选的适用条件（whenToUse / 适用条件 / applies_to）。 */
  whenToUse?: string;
}

export interface LoadedSkill {
  name: string;
  body: string;
}

export interface SkillWarning {
  file: string;
  reason: string;
}

export interface SkillLoaderOptions {
  /** 扫描目录（顺序即优先级：先出现的同名技能胜出）。 */
  dirs?: readonly string[];
  /** 单个 SKILL.md 大小上限，缺省 256KB。 */
  maxBytes?: number;
  logger?: { warn(msg: string, obj?: unknown): void };
}

export const DEFAULT_SKILL_MAX_BYTES = 262144;

/** 技能正文中的上下文标签全部替换掉，避免技能内容伪造消息边界。 */
const TAG_PATTERN = /<\/?\s*(system|assistant|user|tool|developer|function)\b[^>]*>/gi;
const PLACEHOLDER = "[tag removed]";

export function sanitizeSkillBody(body: string): string {
  return body.replace(TAG_PATTERN, PLACEHOLDER);
}

export interface ParsedFrontmatter {
  fields: Record<string, string | string[]>;
  body: string;
}

/**
 * 最小 YAML frontmatter 解析器：只支持 `key: value`、`key: [a, b]` 与 `- item` 列表，
 * 去掉简单引号。不支持嵌套结构（SKILL.md 不需要）。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | undefined {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return undefined;
  const body = text.slice(match[0].length);
  const fields: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const existing = fields[listKey];
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(unquote((item[1] ?? "").trim()));
      fields[listKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_\-.\u4e00-\u9fff]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").trim();
    const rawValue = (kv[2] ?? "").trim();
    if (rawValue === "") {
      // 可能是 `tags:` 后跟 `- a` 列表。
      fields[key] = [];
      listKey = key;
      continue;
    }
    listKey = undefined;
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      fields[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      fields[key] = unquote(rawValue);
    }
  }
  return { fields, body };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function asString(v: string | string[] | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

function asStringArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function tokenize(query: string): string[] {
  const out: string[] = [];
  for (const part of query.toLowerCase().split(/[^a-z0-9_\-\u00c0-\uffff]+/i)) {
    const t = part.trim();
    if (!t) continue;
    const isCjk = /^[\u4e00-\u9fff]+$/.test(t);
    if (isCjk) {
      for (const ch of t) if (!STOP_WORDS.has(ch)) out.push(ch);
    } else if (t.length >= 2 && !STOP_WORDS.has(t)) {
      out.push(t);
    }
  }
  return out;
}

/**
 * 技能加载器：只解析 frontmatter 建立索引（discover），正文按需读取（load）。
 * 单个技能的格式问题只跳过该技能并 warn，不影响其它技能（E19）。
 */
/**
 * 英文停用词：这类词在任何描述里都常见（"deploy the service" / "what is the weather"），
 * 计入相关度会让任意任务都命中技能。中文按单字切，同样排除高频虚字。
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "in", "on", "at", "for",
  "and", "or", "but", "with", "this", "that", "these", "those", "it", "its", "as", "by",
  "what", "which", "who", "how", "why", "when", "where", "do", "does", "did", "can", "should",
  "i", "you", "we", "they", "he", "she", "me", "my", "your", "please", "help", "want", "need",
  "的", "了", "是", "在", "和", "与", "把", "被", "对", "个", "有", "我", "你", "他", "它",
  "请", "帮", "下", "一", "这", "那", "什", "么", "怎", "样",
]);

/** 把一段文本切成小写词集合（CJK 按单字切，拉丁按词切），并去掉停用词。 */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of text.toLowerCase().split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)) {
    if (!part) continue;
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      for (const ch of part) if (!STOP_WORDS.has(ch)) out.add(ch);
    } else if (!STOP_WORDS.has(part)) {
      out.add(part);
    }
  }
  return out;
}

/** autoMatch 的最低相关度：只有 name/tags/description 的实质命中才算相关。 */
const MATCH_SCORE_THRESHOLD = 2;

export class SkillLoader {
  readonly dirs: string[];
  readonly maxBytes: number;
  private readonly warnings: SkillWarning[] = [];
  private readonly logger: SkillLoaderOptions["logger"];
  private index: Map<string, SkillMeta> | undefined;

  constructor(options: SkillLoaderOptions = {}) {
    this.dirs = (options.dirs ?? []).filter((d) => d !== undefined && d !== null);
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_SKILL_MAX_BYTES;
    this.logger = options.logger;
  }

  /** 扫描过程中收集的警告（被跳过的技能）。 */
  getWarnings(): SkillWarning[] {
    return [...this.warnings];
  }

  private warn(file: string, reason: string): void {
    const w = { file, reason };
    this.warnings.push(w);
    this.logger?.warn("skill.skipped", w);
  }

  discoverSync(): SkillMeta[] {
    const index = new Map<string, SkillMeta>();
    this.warnings.length = 0;
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch (err) {
        this.warn(dir, `unreadable directory: ${(err as Error).message}`);
        continue;
      }
      for (const entry of entries.sort()) {
        const skillFile = path.join(dir, entry, "SKILL.md");
        let size: number;
        try {
          if (!statSync(path.join(dir, entry)).isDirectory()) continue;
          size = statSync(skillFile).size;
        } catch {
          continue; // 没有 SKILL.md 的子目录直接忽略（不是技能）。
        }
        if (size > this.maxBytes) {
          this.warn(skillFile, `file too large: ${size} bytes > limit ${this.maxBytes}`);
          continue;
        }
        let raw: string;
        try {
          raw = readFileSync(skillFile, "utf8");
        } catch (err) {
          this.warn(skillFile, `unreadable: ${(err as Error).message}`);
          continue;
        }
        const parsed = parseFrontmatter(raw);
        if (!parsed) {
          this.warn(skillFile, "missing YAML frontmatter");
          continue;
        }
        const name = asString(parsed.fields["name"]).trim();
        if (name === "") {
          this.warn(skillFile, "frontmatter has empty name");
          continue;
        }
        if (name !== entry) {
          this.logger?.warn("skill.name_mismatch", { dir: entry, name, file: skillFile });
        }
        if (index.has(name)) {
          // 先出现的目录优先（用户目录在前，内置目录在后）。
          this.logger?.warn("skill.duplicate", { name, file: skillFile, kept: index.get(name)?.file });
          continue;
        }
        const meta: SkillMeta = {
          name,
          description: asString(parsed.fields["description"]).trim(),
          version: asString(parsed.fields["version"]).trim() || "0.0.0",
          source: path.resolve(dir),
          file: skillFile,
          bytes: size,
          tags: asStringArray(parsed.fields["tags"]),
        };
        const when =
          asString(parsed.fields["whenToUse"]).trim() ||
          asString(parsed.fields["when_to_use"]).trim() ||
          asString(parsed.fields["适用条件"]).trim();
        if (when !== "") meta.whenToUse = when;
        index.set(name, meta);
      }
    }
    this.index = index;
    return Array.from(index.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async discover(): Promise<SkillMeta[]> {
    return this.discoverSync();
  }

  private lookup(name: string): SkillMeta | undefined {
    if (!this.index) this.discoverSync();
    return this.index?.get(name);
  }

  /** 按需加载正文（frontmatter 已剥离，且经过标签清洗）。 */
  loadSync(name: string): LoadedSkill | undefined {
    const meta = this.lookup(name);
    if (!meta?.file) return undefined;
    let raw: string;
    try {
      raw = readFileSync(meta.file, "utf8");
    } catch {
      return undefined;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return undefined;
    return { name: meta.name, body: sanitizeSkillBody(parsed.body.trim()) };
  }

  async load(name: string): Promise<LoadedSkill | undefined> {
    return this.loadSync(name);
  }

  /** 多个技能按需加载（CLI --skill 可重复）。未知名字直接跳过。 */
  async loadMany(names: readonly string[]): Promise<LoadedSkill[]> {
    const out: LoadedSkill[] = [];
    for (const name of names) {
      const skill = this.loadSync(name);
      if (skill) out.push(skill);
    }
    return out;
  }

  /** autoMatch：query 与 name/description/tags 的关键词重叠打分，返回 top 2。 */
  async match(query: string, limit = 2): Promise<SkillMeta[]> {
    const metas = this.index ? Array.from(this.index.values()) : this.discoverSync();
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scored: Array<{ meta: SkillMeta; score: number }> = [];
    for (const meta of metas) {
      const name = meta.name.toLowerCase();
      const description = meta.description.toLowerCase();
      const tags = meta.tags.map((t) => t.toLowerCase());
      const when = (meta.whenToUse ?? "").toLowerCase();
      // 用整词匹配而不是子串匹配：子串会让 "weather" 命中 "her"、"the" 命中 "he"，
      // 从而把完全无关的任务误判为相关技能。
      const nameWords = words(name);
      const tagWords = tags.flatMap(words);
      const descWords = words(description);
      const whenWords = words(when);
      let score = 0;
      for (const token of tokens) {
        if (nameWords.has(token)) score += 5;
        else if (tags.some((t) => t.includes(token))) score += 3;
        if (descWords.has(token)) score += 2;
        if (whenWords.has(token)) score += 1;
      }
      // 低于阈值的弱信号不构成"技能相关"，避免把无关任务也注入技能正文。
      if (score >= MATCH_SCORE_THRESHOLD) scored.push({ meta, score });
    }
    scored.sort((a, b) => b.score - a.score || a.meta.name.localeCompare(b.meta.name));
    return scored.slice(0, Math.max(0, limit)).map((s) => s.meta);
  }
}

/** CLI 表格输出（无第三方依赖）。 */
export function formatSkillsTable(metas: readonly SkillMeta[]): string {
  if (metas.length === 0) return "no skills found\n";
  const headers = ["NAME", "VERSION", "DESCRIPTION"];
  const rows = metas.map((m) => [m.name, m.version, m.description.replace(/\s+/g, " ")]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length)))
      .join("  ")
      .trimEnd();
  return `${[fmt(headers), ...rows.map(fmt)].join("\n")}\n`;
}
