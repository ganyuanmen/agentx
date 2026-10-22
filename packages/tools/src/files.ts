import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AgentTool, ToolResult } from "@agentx/core";
import { PathEscapeError, relPath, resolveInside } from "./paths.js";

/** 目录遍历时跳过的目录名（PM_SPEC §5.5）。 */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".agentx"]);

export const DEFAULT_READ_MAX_LINES = 400;
export const DEFAULT_READ_MAX_BYTES = 200_000;
export const LIST_MAX_ENTRIES = 500;
export const SEARCH_MAX_HITS = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(error: string): ToolResult {
  return { ok: false, content: "", error };
}

/** 把异常转成 tool 结果（路径越界等错误不回填内容）。 */
function toFail(err: unknown): ToolResult {
  if (err instanceof PathEscapeError) return fail(err.message);
  return fail(errMessage(err));
}

// ---------------------------------------------------------------- read_file

export const readFileInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

function formatWithLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(Math.max(4, width))}|${line}`)
    .join("\n");
}

export const readFileTool: AgentTool<ReadFileInput> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the working directory. Returns lines prefixed with " +
    "`N|` line numbers. Use offset (1-based first line) and limit (max lines) for large files.",
  inputSchema: readFileInputSchema,
  riskLevel: "low",
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string;
    try {
      abs = resolveInside(ctx.cwd, input.path);
    } catch (err) {
      return toFail(err);
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      return fail(`cannot read ${input.path}: ${errMessage(err)}`);
    }
    if (stat.isDirectory()) {
      return fail(`${input.path} is a directory; use list_files instead`);
    }

    const buffer = await fs.readFile(abs);
    const maxBytes = DEFAULT_READ_MAX_BYTES;
    const byteTruncated = buffer.byteLength > maxBytes;
    const slice = byteTruncated ? buffer.subarray(0, maxBytes) : buffer;
    // 截断可能切断多字节字符：用 lossy 解码避免抛错。
    const text = slice.toString("utf8");

    const allLines = text.split(/\r?\n/);
    // 末尾换行会多出一个空串，不算一行。
    if (allLines.length > 0 && allLines[allLines.length - 1] === "" && !byteTruncated) allLines.pop();

    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_READ_MAX_LINES;
    const startIdx = Math.min(offset - 1, allLines.length);
    const selected = allLines.slice(startIdx, startIdx + limit);

    const lineTruncated = startIdx + selected.length < allLines.length;
    const truncated = byteTruncated || lineTruncated;

    const body =
      selected.length === 0
        ? `(no lines; file has ${allLines.length} lines)`
        : formatWithLineNumbers(selected, offset);

    return {
      ok: true,
      content: body,
      metadata: {
        bytes: buffer.byteLength,
        truncated,
        totalLines: allLines.length,
        offset,
        returnedLines: selected.length,
        ...(truncated
          ? {
              hint: `truncated; continue with offset=${offset + selected.length}`,
            }
          : {}),
      },
    };
  },
};

// --------------------------------------------------------------- list_files

export const listFilesInputSchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().min(1).max(5).optional(),
});

export type ListFilesInput = z.infer<typeof listFilesInputSchema>;

interface ListedEntry {
  rel: string;
  isDir: boolean;
}

async function walk(rootAbs: string, baseAbs: string, depth: number, out: ListedEntry[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch {
    return; // 不可读目录静默跳过
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= LIST_MAX_ENTRIES) return;
    // 跳过目录本身也不列出（PM_SPEC：跳过 .git / node_modules / dist / .agentx）。
    if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;
    const abs = path.join(rootAbs, entry.name);
    const rel = path.relative(baseAbs, abs).split(path.sep).join("/");
    let isDir = entry.isDirectory();
    let isLink = entry.isSymbolicLink();
    if (isLink) {
      // 符号链接：只有解析后仍在 cwd 内的目录才展开。
      try {
        const real = await fs.realpath(abs);
        isDir = (await fs.stat(real)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) {
      out.push({ rel, isDir: true });
      if (depth > 1 && !SKIP_DIRS.has(entry.name) && !isLink) {
        await walk(abs, baseAbs, depth - 1, out);
      }
    } else {
      out.push({ rel, isDir: false });
    }
  }
}

export const listFilesTool: AgentTool<ListFilesInput> = {
  name: "list_files",
  description:
    "List files and directories under a path inside the working directory (default: cwd). " +
    "Directories end with `/`. Skips .git, node_modules, dist and .agentx.",
  inputSchema: listFilesInputSchema,
  riskLevel: "low",
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string;
    let cwdReal: string;
    try {
      abs = resolveInside(ctx.cwd, input.path ?? ".");
      cwdReal = resolveInside(ctx.cwd, ".");
    } catch (err) {
      return toFail(err);
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      return fail(`cannot list ${input.path ?? "."}: ${errMessage(err)}`);
    }
    if (!stat.isDirectory()) {
      return fail(`${input.path ?? "."} is not a directory`);
    }

    const depth = input.depth ?? 1;
    const entries: ListedEntry[] = [];
    await walk(abs, cwdReal, depth, entries);

    const shown = entries.slice(0, LIST_MAX_ENTRIES);
    const truncated = entries.length >= LIST_MAX_ENTRIES;
    const content =
      shown.length === 0
        ? "(empty directory)"
        : shown.map((e) => (e.isDir ? `${e.rel}/` : e.rel)).join("\n");

    return {
      ok: true,
      content,
      metadata: { total: shown.length, truncated, depth },
    };
  },
};

// -------------------------------------------------------------- search_text

export const searchTextInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  regex: z.boolean().optional(),
});

export type SearchTextInput = z.infer<typeof searchTextInputSchema>;

/** 把 glob（`*`、`**`、`?`）翻译为正则；`**` 跨目录，`*` 不跨 `/`。 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` 匹配零层或多层目录
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch !== undefined && "\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch ?? "";
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(rel: string, re: RegExp): boolean {
  if (re.test(rel)) return true;
  // 只有文件名时也允许 `*.ts` 这类模式命中任意层
  const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  return re.test(base);
}

async function isBinaryFile(abs: string): Promise<boolean> {
  const handle = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function collectFiles(rootAbs: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length > 20_000) return; // 硬上限，防病态目录
    const abs = path.join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export const searchTextTool: AgentTool<SearchTextInput> = {
  name: "search_text",
  description:
    "Search text files inside the working directory line by line. `pattern` is a literal " +
    "string unless `regex:true`. Optional `path` (subdirectory/file) and `glob` (e.g. `*.ts`). " +
    "Output format: `relpath:lineno: text`.",
  inputSchema: searchTextInputSchema,
  riskLevel: "low",
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    let matcher: RegExp;
    if (input.regex) {
      try {
        matcher = new RegExp(input.pattern);
      } catch (err) {
        return fail(
          `invalid regular expression: ${errMessage(err)}; retry without regex:true to search literally`,
        );
      }
    } else {
      matcher = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    let rootAbs: string;
    let cwdReal: string;
    try {
      rootAbs = resolveInside(ctx.cwd, input.path ?? ".");
      cwdReal = resolveInside(ctx.cwd, ".");
    } catch (err) {
      return toFail(err);
    }

    let stat;
    try {
      stat = await fs.stat(rootAbs);
    } catch (err) {
      return fail(`cannot search ${input.path ?? "."}: ${errMessage(err)}`);
    }

    const files: string[] = [];
    if (stat.isFile()) files.push(rootAbs);
    else await collectFiles(rootAbs, files);

    const globRe = input.glob && input.glob.trim() !== "" ? globToRegExp(input.glob.trim()) : undefined;

    const hits: string[] = [];
    let filesScanned = 0;
    for (const file of files) {
      if (hits.length >= SEARCH_MAX_HITS) break;
      const fileRel = relPath(cwdReal, file);
      if (globRe && !matchesGlob(fileRel, globRe)) continue;
      filesScanned++;
      try {
        if (await isBinaryFile(file)) continue;
        const text = await fs.readFile(file, "utf8");
        if (text.includes("\0")) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (matcher.test(line)) {
            hits.push(`${fileRel}:${i + 1}: ${line.length > 500 ? `${line.slice(0, 500)}…` : line}`);
            if (hits.length >= SEARCH_MAX_HITS) break;
          }
        }
      } catch {
        continue; // 不可读文件跳过
      }
    }

    const truncated = hits.length >= SEARCH_MAX_HITS;
    return {
      ok: true,
      content: hits.length === 0 ? "(no matches)" : hits.join("\n"),
      metadata: { total: hits.length, truncated, filesScanned },
    };
  },
};

// --------------------------------------------------------------- write_file

export const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export const writeFileTool: AgentTool<WriteFileInput> = {
  name: "write_file",
  description:
    "Write UTF-8 text to a file inside the working directory, creating parent directories. " +
    "Overwrites existing content entirely.",
  inputSchema: writeFileInputSchema,
  riskLevel: "medium",
  readOnly: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.readOnly) {
      return fail("READ_ONLY_VIOLATION: write_file is not allowed in read-only mode");
    }
    let abs: string;
    try {
      abs = resolveInside(ctx.cwd, input.path);
    } catch (err) {
      return toFail(err);
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // 先在真实路径上再确认一次，防止 mkdir 后父目录被替换成符号链接。
      const recheck = resolveInside(ctx.cwd, input.path);
      if (recheck !== abs) {
        return fail(`PATH_ESCAPE: path changed while writing: ${input.path}`);
      }
      await fs.writeFile(abs, input.content, "utf8");
    } catch (err) {
      return toFail(err);
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    return {
      ok: true,
      content: `wrote ${bytes} bytes to ${relPath(ctx.cwd, abs)}`,
      metadata: { bytes, path: relPath(ctx.cwd, abs) },
    };
  },
};

// -------------------------------------------------------------- apply_patch

export const applyPatchInputSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const applyPatchTool: AgentTool<ApplyPatchInput> = {
  name: "apply_patch",
  description:
    "Replace `old_string` with `new_string` in a file. `old_string` must occur exactly once " +
    "unless `replace_all:true`. Fails when it matches 0 or multiple times.",
  inputSchema: applyPatchInputSchema,
  riskLevel: "medium",
  readOnly: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.readOnly) {
      return fail("READ_ONLY_VIOLATION: apply_patch is not allowed in read-only mode");
    }
    let abs: string;
    try {
      abs = resolveInside(ctx.cwd, input.path);
    } catch (err) {
      return toFail(err);
    }

    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (err) {
      return fail(`cannot read ${input.path}: ${errMessage(err)}`);
    }

    const count = countOccurrences(text, input.old_string);
    if (count === 0) {
      return fail(`old_string not found in ${input.path} (occurrences: 0)`);
    }
    if (count > 1 && !input.replace_all) {
      return fail(
        `old_string appears ${count} times in ${input.path}; provide more context or set replace_all:true`,
      );
    }

    const updated = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);

    try {
      await fs.writeFile(abs, updated, "utf8");
    } catch (err) {
      return toFail(err);
    }

    return {
      ok: true,
      content: `patched ${relPath(ctx.cwd, abs)} (${count} replacement${count === 1 ? "" : "s"})`,
      metadata: { replacements: count, bytes: Buffer.byteLength(updated, "utf8") },
    };
  },
};
