import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface MemoryEntry {
  id: string;
  text: string;
  /** 来源标记（如 "cli:add"、"session:ses_x"），用于追溯。 */
  source: string;
  tags: string[];
  createdAt: string;
}

export interface AddMemoryInput {
  text: string;
  source: string;
  tags?: string[];
}

/** 单条记忆正文上限：禁止把整段任务日志写进记忆。 */
export const MAX_MEMORY_ENTRY_CHARS = 4000;

export class MemoryEntryTooLargeError extends Error {
  readonly code = "MEMORY_ENTRY_TOO_LARGE";
  constructor(length: number) {
    super(
      `memory entry rejected: ${length} characters exceeds the ${MAX_MEMORY_ENTRY_CHARS} character limit ` +
        `(store a short fact or preference, not a task log)`,
    );
    this.name = "MemoryEntryTooLargeError";
  }
}

const HEADER = "# agentx memory\n\n<!-- 每条记忆以 \"## <id>\" 开头，其后是元数据行与正文。手动编辑请保持该结构。 -->\n";

function sha1Id(text: string, source: string): string {
  return createHash("sha1").update(`${source}\u0000${text}`).digest("hex").slice(0, 8);
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\-\u00c0-\uffff]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Markdown 长期记忆：<dir>/memory.md，单文件、可人工阅读、每条带 id / source / created_at。
 * 检索为关键词子串匹配（大小写不敏感）+ 命中次数与标题（首行）加权。
 */
export class MarkdownMemory {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, "memory.md");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  list(): MemoryEntry[] {
    if (!existsSync(this.file)) return [];
    return parseMemoryFile(readFileSync(this.file, "utf8"));
  }

  add(entry: AddMemoryInput): MemoryEntry {
    const text = entry.text.trim();
    if (text.length === 0) throw new Error("memory entry rejected: empty text");
    if (text.length > MAX_MEMORY_ENTRY_CHARS) throw new MemoryEntryTooLargeError(text.length);
    const source = entry.source.trim() === "" ? "unknown" : entry.source.trim();
    const existing = this.list();
    let id = sha1Id(text, source);
    let suffix = 1;
    while (existing.some((e) => e.id === id)) {
      id = `${sha1Id(text, source)}-${suffix++}`;
    }
    const record: MemoryEntry = {
      id,
      text,
      source,
      tags: (entry.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
      createdAt: new Date().toISOString(),
    };
    this.write([...existing, record]);
    return record;
  }

  remove(id: string): boolean {
    const existing = this.list();
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) return false;
    this.write(next);
    return true;
  }

  /** 关键词检索；返回按得分降序的前 limit 条（默认 5）。 */
  search(query: string, limit = 5): MemoryEntry[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.list()) {
      const haystack = `${entry.tags.join(" ")}\n${entry.text}`.toLowerCase();
      const title = entry.text.split("\n")[0]?.toLowerCase() ?? "";
      let score = 0;
      for (const token of tokens) {
        let hits = 0;
        let from = 0;
        while (true) {
          const idx = haystack.indexOf(token, from);
          if (idx < 0) break;
          hits++;
          from = idx + token.length;
        }
        if (hits > 0) score += hits;
        if (title.includes(token)) score += 3;
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, Math.max(0, limit)).map((s) => s.entry);
  }

  private write(entries: MemoryEntry[]): void {
    this.ensureDir();
    const parts: string[] = [HEADER];
    for (const e of entries) {
      parts.push(
        `## ${e.id}`,
        `- source: ${e.source}`,
        `- created_at: ${e.createdAt}`,
        `- tags: ${e.tags.join(", ")}`,
        "",
        e.text,
        "",
      );
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, parts.join("\n"), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** 解析 memory.md（容错：忽略无法识别的块）。 */
export function parseMemoryFile(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  let current: { id: string; fields: Record<string, string>; body: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    const text = current.body.join("\n").trim();
    if (current.id && text.length > 0) {
      entries.push({
        id: current.id,
        text,
        source: current.fields["source"] ?? "unknown",
        tags: (current.fields["tags"] ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        createdAt: current.fields["created_at"] ?? "",
      });
    }
    current = undefined;
  };
  for (const line of lines) {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    if (heading && heading[1]) {
      flush();
      current = { id: heading[1], fields: {}, body: [] };
      continue;
    }
    if (!current) continue;
    const field = /^-\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (field && field[1] && current.body.length === 0) {
      current.fields[field[1]] = (field[2] ?? "").trim();
      continue;
    }
    current.body.push(line);
  }
  flush();
  return entries;
}
