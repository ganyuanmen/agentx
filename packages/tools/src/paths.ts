import { realpathSync } from "node:fs";
import * as path from "node:path";
import { AgentxError, ErrorCode } from "@agentx/core";

/**
 * 路径越界错误（PM_SPEC §5.5 / E01-E03）。
 * core 尚未提供专用类，这里用 AgentxError + ErrorCode.PATH_ESCAPE 构造。
 */
export class PathEscapeError extends AgentxError {
  readonly inputPath: string;
  constructor(inputPath: string, cwd: string, reason?: string) {
    super(
      ErrorCode.PATH_ESCAPE,
      // 前缀错误码：脚本化调用者需要机器可读的分类，而不只是自然语言描述。
      `PATH_ESCAPE: path escapes the working directory: ${inputPath}${reason ? ` (${reason})` : ""} (cwd: ${cwd})`,
      { detail: { inputPath, cwd } },
    );
    this.inputPath = inputPath;
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

/** 规范化比较用的路径：Windows 大小写不敏感，且去掉尾部分隔符。 */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  return isWindows() ? trimmed.toLowerCase() : trimmed;
}

/**
 * 判断 child 是否位于 parent 之内（含 parent 自身）。
 * 跨平台：使用 path.relative，Windows 上不同盘符 relative 会返回绝对路径 -> 视为不在内部。
 */
export function isInside(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../")) return false;
  if (path.isAbsolute(rel)) return false; // 不同盘符 / 不同根
  return true;
}

/**
 * 取最近一个存在的祖先并 realpath，再把剩余段拼回去。
 * 目标本身不存在时（write_file 新文件）也能得到「真实」路径，从而捕获符号链接逃逸：
 *   cwd/link -> /tmp, 传入 link/evil.txt：最近的已存在祖先可能是 cwd 本身，
 *   因此不能只看祖先 —— 见下方分段解析。
 */
function realpathNearestExisting(target: string): string {
  const segments: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      return segments.length === 0 ? real : path.join(real, ...segments.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return target; // 到达根仍不存在（异常情况）
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 把「目标路径上已存在的中间段」逐个 realpath，捕获符号链接。
 * 例如 target=/cwd/link/evil.txt 且 /cwd/link -> /tmp：
 * step 1: /cwd 存在 -> real /cwd，剩余 [link, evil.txt]
 * step 2: /cwd/link 存在 -> real /tmp，剩余 [evil.txt]
 * 结果 /tmp/evil.txt -> 越界。
 */
function realpathWithSymlinkExpansion(target: string): string {
  const parsed = path.parse(target);
  const rel = path.relative(parsed.root, target);
  const parts = rel.split(path.sep).filter((s) => s.length > 0);
  let current = parsed.root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const next = path.join(current, part);
    try {
      const real = realpathSync(next);
      current = real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // 从这里开始都不存在：把剩余段拼回去即可。
      return path.join(current, ...parts.slice(i));
    }
  }
  return current;
}

/**
 * 解析路径并强制其落在 cwd 内（PM_SPEC §5.5）。
 *
 * 顺序：
 *  1. cwdReal = realpathSync(cwd)（cwd 必须存在）
 *  2. 相对路径基于 cwdReal 解析；绝对路径直接使用
 *  3. 对目标做符号链接展开 + nearest-existing-ancestor realpath
 *  4. 判断结果是否仍在 cwdReal 内，否则抛 PathEscapeError
 */
export function resolveInside(cwd: string, inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new PathEscapeError(String(inputPath), cwd, "empty path");
  }
  if (inputPath.includes("\0")) {
    throw new PathEscapeError(inputPath, cwd, "NUL byte in path");
  }
  let cwdReal: string;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    // cwd 不存在时退化为词法解析（仍做越界判断）。
    cwdReal = path.resolve(cwd);
  }

  const target = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwdReal, inputPath);

  // 词法层面先挡一次，避免对明显越界的绝对路径做文件系统探测。
  if (!isInside(cwdReal, target)) {
    throw new PathEscapeError(inputPath, cwd);
  }

  let resolved: string;
  try {
    resolved = realpathWithSymlinkExpansion(target);
  } catch {
    resolved = realpathNearestExisting(target);
  }

  if (!isInside(cwdReal, resolved)) {
    throw new PathEscapeError(inputPath, cwd, "symlink or parent resolves outside cwd");
  }
  return resolved;
}

/** 计算相对 cwd 的展示路径（用于工具输出），始终使用 `/` 分隔。 */
export function relPath(cwd: string, absolute: string): string {
  let base = cwd;
  try {
    base = realpathSync(cwd);
  } catch {
    base = path.resolve(cwd);
  }
  const rel = path.relative(base, absolute);
  const out = rel === "" ? "." : rel;
  return out.split(path.sep).join("/");
}
