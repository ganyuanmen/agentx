import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { AgentxError, ConfigInvalidError, ErrorCode } from "./errors.js";

const providerSchema = z
  .object({
    type: z.enum(["deepseek", "openai-compatible", "mock"]),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).min(1),
    maxRetries: z.number().int().min(0).max(10).default(2),
    timeoutMs: z.number().int().positive().default(120000),
  })
  .strict();

export const DEFAULT_TOOLS_ALLOW = [
  "read_file",
  "list_files",
  "search_text",
  "write_file",
  "apply_patch",
  "exec",
  "memory_search",
];

export const configSchema = z
  .object({
    defaultModel: z.string().min(1).default("deepseek-chat"),
    providers: z
      .record(providerSchema)
      .default({
        deepseek: {
          type: "deepseek" as const,
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: ["deepseek-chat"],
          maxRetries: 2,
          timeoutMs: 120000,
        },
        local: {
          type: "openai-compatible" as const,
          baseUrl: "http://127.0.0.1:8000/v1",
          apiKeyEnv: "LOCAL_API_KEY",
          models: ["local-model"],
          maxRetries: 0,
          timeoutMs: 180000,
        },
        mock: { type: "mock" as const, models: ["mock-1"], maxRetries: 0, timeoutMs: 120000 },
      }),
    cwd: z.string().default("."),
    readOnly: z.boolean().default(false),
    maxSteps: z.number().int().min(1).max(100).default(12),
    timeoutMs: z.number().int().positive().default(300000),
    maxTotalTokens: z.number().int().min(0).default(0),
    policy: z
      .object({
        approval: z.enum(["none", "high", "all"]).default("high"),
        requireApprovalFor: z.array(z.string()).optional(),
      })
      .strict()
      .default({ approval: "high" }),
    tools: z
      .object({
        allow: z.array(z.string()).default(DEFAULT_TOOLS_ALLOW),
        maxCallsPerTask: z.number().int().min(1).default(50),
        exec: z
          .object({
            defaultTimeoutMs: z.number().int().positive().default(30000),
            maxOutputBytes: z.number().int().positive().default(100000),
            envAllow: z.array(z.string()).default([]),
          })
          .strict()
          .default({ defaultTimeoutMs: 30000, maxOutputBytes: 100000, envAllow: [] }),
      })
      .strict()
      .default({
        allow: DEFAULT_TOOLS_ALLOW,
        maxCallsPerTask: 50,
        exec: { defaultTimeoutMs: 30000, maxOutputBytes: 100000, envAllow: [] },
      }),
    context: z
      .object({ historyMessages: z.number().int().min(0).default(30) })
      .strict()
      .default({ historyMessages: 30 }),
    skills: z
      .object({
        dirs: z.array(z.string()).default([]),
        maxBytes: z.number().int().positive().default(262144),
        autoMatch: z.boolean().default(true),
      })
      .strict()
      .default({ dirs: [], maxBytes: 262144, autoMatch: true }),
    agents: z
      .object({
        /** 额外的 agent 定义目录（相对路径按 cwd 解析）；排在 $AGENTX_HOME/agents 之后。 */
        dirs: z.array(z.string()).default([]),
        /** SOUL.md 体积上限（字节）。 */
        maxBytes: z.number().int().positive().default(262144),
      })
      .strict()
      .default({ dirs: [], maxBytes: 262144 }),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        dir: z.string().nullable().default(null),
      })
      .strict()
      .default({ enabled: true, dir: null }),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        retentionDays: z.number().int().min(1).default(14),
      })
      .strict()
      .default({ level: "info", retentionDays: 14 }),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

export interface LoadConfigOptions {
  home?: string;
  /** 命令行覆盖（优先级最高）。 */
  overrides?: DeepPartial<Config>;
  env?: NodeJS.ProcessEnv;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface LoadedConfig {
  /** 参与解析的合并环境（含 .env），provider 构造应使用它。 */
  env?: NodeJS.ProcessEnv;
  /** .env 相关告警（权限过宽等）。 */
  warnings?: string[];
  config: Config;
  home: string;
  sources: string[];
}

/** AGENTX_HOME 优先，其次 ~/.agentx。 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AGENTX_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homedir(), ".agentx");
}

/** 创建 home 目录骨架：logs/ data/ memory/ skills/；data 权限 0700。 */
export function ensureHomeLayout(home: string): void {
  for (const dir of ["logs", "data", "memory", "skills"]) {
    const full = path.join(home, dir);
    mkdirSync(full, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(path.join(home, "data"), 0o700);
  } catch {
    // 非 POSIX 文件系统或权限不足时忽略。
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseBool(raw: string): boolean | string {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return `expected a boolean, received "${raw}"`;
}

function envOverrides(env: NodeJS.ProcessEnv, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.AGENTX_MODEL) out.defaultModel = env.AGENTX_MODEL;
  if (env.AGENTX_CWD) out.cwd = env.AGENTX_CWD;
  if (env.AGENTX_READ_ONLY !== undefined && env.AGENTX_READ_ONLY !== "") {
    const parsed = parseBool(env.AGENTX_READ_ONLY);
    if (typeof parsed === "boolean") out.readOnly = parsed;
    else errors.push(`AGENTX_READ_ONLY: ${parsed}`);
  }
  if (env.AGENTX_LOG_LEVEL) out.logging = { level: env.AGENTX_LOG_LEVEL };
  return out;
}

/**
 * 解析 `<home>/.env` 形式的键值文件。
 *
 * 支持 `KEY=VALUE`、`export KEY=VALUE`、`#` 注释、单/双引号包裹的值。
 * 空行与无法识别的行被忽略；不做变量展开（避免意外执行）。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface DotEnvLoadResult {
  /** 合并后的环境（真实进程环境优先，.env 只做补足）。 */
  env: NodeJS.ProcessEnv;
  /** 实际读取到的 .env 路径（存在时）。 */
  path?: string;
  /** 权限告警：.env 对其他用户可读时给出提示。 */
  warnings: string[];
}

/** 读取 `<home>/.env` 并合并进给定环境（真实环境变量优先）。 */
export function loadDotEnv(home: string, base: NodeJS.ProcessEnv = process.env): DotEnvLoadResult {
  const dotenvPath = path.join(home, ".env");
  const warnings: string[] = [];
  if (!existsSync(dotenvPath)) return { env: base, warnings };
  let parsed: Record<string, string> = {};
  try {
    parsed = parseDotEnv(readFileSync(dotenvPath, "utf8"));
  } catch (err) {
    warnings.push(`cannot read ${dotenvPath}: ${(err as Error).message}`);
    return { env: base, path: dotenvPath, warnings };
  }
  try {
    const mode = statSync(dotenvPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `${dotenvPath} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${dotenvPath}`,
      );
    }
  } catch {
    // 权限探测失败不影响使用
  }
  return { env: { ...parsed, ...base }, path: dotenvPath, warnings };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const baseEnv = options.env ?? process.env;
  const home = options.home ? path.resolve(options.home) : resolveHome(baseEnv);
  // .env 参与环境解析：密钥可以只放在 <home>/.env 里，不必污染 shell 环境。
  const dotenv = loadDotEnv(home, baseEnv);
  const env = dotenv.env;
  const sources: string[] = ["defaults"];
  if (dotenv.path) sources.push(dotenv.path);
  let raw: Record<string, unknown> = {};

  const filePath = path.join(home, "config.json");
  if (existsSync(filePath)) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new ConfigInvalidError(`cannot read config file ${filePath}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigInvalidError(`config file ${filePath} is not valid JSON: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (!isPlainObject(parsed)) {
      throw new ConfigInvalidError(`config file ${filePath} must contain a JSON object`);
    }
    raw = parsed;
    sources.push(filePath);
  }

  const errors: string[] = [];
  const fromEnv = envOverrides(env, errors);
  if (Object.keys(fromEnv).length > 0) {
    raw = deepMerge(raw, fromEnv);
    sources.push("env");
  }
  if (options.overrides) {
    raw = deepMerge(raw, options.overrides as Record<string, unknown>);
    sources.push("cli");
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${field}: ${issue.message}`;
    });
    errors.push(...issues);
  }
  if (errors.length > 0) {
    throw new ConfigInvalidError(`invalid configuration: ${errors.join("; ")}`, { detail: errors });
  }
  return {
    config: (result as z.SafeParseSuccess<Config>).data,
    home,
    sources,
    env,
    warnings: dotenv.warnings,
  };
}

/** 取出默认模型对应的 provider 配置。 */
export function providerForModel(config: Config, modelRef: string): { providerId: string; modelId: string; def: ProviderConfig } {
  const idx = modelRef.indexOf(":");
  if (idx > 0) {
    const providerId = modelRef.slice(0, idx);
    const modelId = modelRef.slice(idx + 1);
    const def = config.providers[providerId];
    if (!def) throw new AgentxError(ErrorCode.CONFIG_INVALID, `unknown provider "${providerId}"`);
    return { providerId, modelId, def };
  }
  for (const [providerId, def] of Object.entries(config.providers)) {
    if (def.models.includes(modelRef)) return { providerId, modelId: modelRef, def };
  }
  const fallback = config.providers[modelRef];
  if (fallback) {
    const modelId = fallback.models[0] ?? modelRef;
    return { providerId: modelRef, modelId, def: fallback };
  }
  const first = Object.entries(config.providers)[0];
  if (!first) throw new AgentxError(ErrorCode.CONFIG_INVALID, "no providers configured");
  return { providerId: first[0], modelId: modelRef, def: first[1] };
}
