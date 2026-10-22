import { mkdirSync } from "node:fs";
import { Writable } from "node:stream";
import * as path from "node:path";
import { destination, pino, stdTimeFunctions } from "pino";
import type { Logger as PinoLogger } from "pino";
import type { Logger } from "./types.js";

const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i;
// 用量类字段包含 "token" 但不是凭据，保留其数值。
const USAGE_KEY = /token(?:s|count|usage|usagecount)$/i;
const SK_PATTERN = /sk-[A-Za-z0-9]{8,}/g;
const BEARER_PATTERN = /Bearer\s+\S+/g;
const REDACTED = "***";

export function redactText(input: string): string {
  return input.replace(SK_PATTERN, REDACTED).replace(BEARER_PATTERN, REDACTED);
}

/** 递归脱敏：敏感键名的值整体替换；字符串里的 sk-* / Bearer 片段替换。 */
export function redactObject<T = unknown>(value: T): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
      ...(value instanceof Object && "code" in value ? { code: (value as { code?: unknown }).code } : {}),
    };
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = SENSITIVE_KEY.test(key) && !USAGE_KEY.test(key);
    out[key] = sensitive ? REDACTED : redactValue(val, seen);
  }
  return out;
}

const LEVEL_TEXT: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  level?: LogLevel | string;
  /** 日志文件路径；缺省写 <home>/logs/agentx-YYYY-MM-DD.log。 */
  file?: string;
  /** 是否输出到 stderr（人类可读）。 */
  stderr?: boolean;
  /** 是否启用脱敏（默认 true）。 */
  redact?: boolean;
  /** 逻辑名，写入 base.service。 */
  name?: string;
}

export function logFileName(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `agentx-${yyyy}-${mm}-${dd}.log`;
}

/** 基于 pino 的 logger：文件写 JSON 行，stderr 人类可读。 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const redact = options.redact ?? true;
  const service = options.name ?? "agentx";

  const pinoOptions = { level, base: { service }, timestamp: stdTimeFunctions.isoTime };

  // stderr 通道：不用 pino 的 serializer（只有绑定键名 log 时才会被调用），
  // 而是把 pino 输出的 JSON 行逐行转成人类可读文本后写入 fd 2。
  const stderrLogger: PinoLogger | null = (() => {
    if (options.stderr === false) return null;
    const humanWriter = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(line) as Record<string, unknown>;
          } catch {
            process.stderr.write(`${line}\n`);
            continue;
          }
          const { service: _s, level: objLevel, time, msg, ...rest } = rec;
          const timeText =
            typeof time === "string" || typeof time === "number" ? new Date(time).toISOString() : "";
          const levelText =
            typeof objLevel === "number" ? (LEVEL_TEXT[objLevel] ?? String(objLevel)) : String(objLevel ?? "");
          const fields = Object.entries(rest)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(" ");
          process.stderr.write(`${timeText} ${levelText} ${String(msg ?? "")}${fields ? ` ${fields}` : ""}\n`);
        }
        cb();
      },
    });
    return pino(pinoOptions, humanWriter) as unknown as PinoLogger;
  })();

  // 用同步写入：日志量小，且进程可能随时被 Ctrl+C 终止；
  // 异步 destination 会让末尾几条记录永远停在缓冲区里。
  const fileLogger: PinoLogger | null = options.file
    ? (() => {
        mkdirSync(path.dirname(options.file as string), { recursive: true, mode: 0o700 });
        return pino(pinoOptions, destination({ dest: options.file as string, sync: true, mkdir: true })) as unknown as PinoLogger;
      })()
    : null;

  const wrap =
    (levelName: "debug" | "info" | "warn" | "error") => (msg: string, obj?: unknown): void => {
      const payload = redact ? (redactObject(obj) as object) : (obj as object);
      if (stderrLogger) stderrLogger[levelName](payload, msg);
      if (fileLogger) fileLogger[levelName](payload, msg);
    };

  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    // 文件通道已同步写入，flush 只是保持接口一致（供 CLI 统一收尾）。
    flush: (): void => {
      fileLogger?.flush?.();
    },
  };
}

export function defaultLogFile(home: string, date: Date = new Date()): string {
  return path.join(home, "logs", logFileName(date));
}
