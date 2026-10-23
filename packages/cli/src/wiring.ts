import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  ApprovalRequiredError,
  ContextBuilder,
  DEFAULT_TOOLS_ALLOW,
  ErrorCode,
  MockProvider,
  runAgent,
  statusForErrorCode,
  type AgentRequest,
  type AgentResult,
  type AgentTool,
  type Approver,
  type ChatMessage,
  type Config,
  type Logger,
  type MockScript,
  type ModelProvider,
  type ModelUsage,
  type PolicyLike,
  type ToolContext,
  type ToolExecutorLike,
  type ToolResult,
  type ToolSpec,
} from "@agentx/core";
import { createProviders } from "@agentx/providers";
import { MarkdownMemory, SqliteSessionStore, SqliteTaskStore, openStore } from "@agentx/store";
import { SkillLoader, type LoadedSkill, type SkillMeta } from "@agentx/skills";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  createDefaultTools,
  createPolicyEngine,
  createToolExecutor,
  zodToJsonSchema,
} from "@agentx/tools";

/**
 * 测试/自动化专用：当 provider type 为 "mock" 且设置了 AGENTX_MOCK_SCRIPT
 * （一个 JSON 文件的路径）时，用该文件内容作为 mock provider 的脚本队列。
 * 文件内容必须是 ModelResponse 数组，元素可为 ModelResponse 或 {sleepMs, response}。
 * 未设置该环境变量时 mock provider 使用空脚本（首步即 PROVIDER_FAILED）。
 */
export const MOCK_SCRIPT_ENV = "AGENTX_MOCK_SCRIPT";

export function loadMockScriptFromEnv(env: NodeJS.ProcessEnv = process.env): MockScript | undefined {
  const file = env[MOCK_SCRIPT_ENV];
  if (!file || file.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${MOCK_SCRIPT_ENV} must contain a JSON array of mock responses`);
  }
  return parsed as MockScript;
}

export interface ProviderMapEntry {
  provider: ModelProvider;
  type: string;
  models: string[];
}

export interface ProviderResolver {
  get(ref: string): ProviderMapEntry | undefined;
  list(): ProviderMapEntry[];
  /** 解析 "providerId:modelId" 或裸模型名。 */
  resolve(ref: string): { provider: ModelProvider; modelId: string; providerId: string } | undefined;
}

export function buildProviders(
  configProviders: Parameters<typeof createProviders>[0],
  mockScript?: MockScript,
  /** 合并了 .env 的环境；不传则退回进程环境。 */
  env?: NodeJS.ProcessEnv,
): ProviderResolver {
  const entries = new Map<string, ProviderMapEntry>();
  const built = createProviders(configProviders, {
    ...(mockScript !== undefined ? { mockScript } : {}),
    ...(env ? { env } : {}),
  });
  const ids = Object.keys(configProviders);
  ids.forEach((id, index) => {
    const provider = built[index];
    if (!provider) return;
    const def = configProviders[id];
    if (def) entries.set(id, { provider, type: def.type, models: def.models });
  });
  const resolve: ProviderResolver["resolve"] = (ref) => {
    const idx = ref.indexOf(":");
    if (idx > 0) {
      const entry = entries.get(ref.slice(0, idx));
      if (!entry) return undefined;
      return { provider: entry.provider, modelId: ref.slice(idx + 1), providerId: ref.slice(0, idx) };
    }
    for (const [id, entry] of Array.from(entries.entries())) {
      if (entry.models.includes(ref)) return { provider: entry.provider, modelId: ref, providerId: id };
    }
    const byId = entries.get(ref);
    if (byId) {
      const modelId = byId.models[0] ?? ref;
      return { provider: byId.provider, modelId, providerId: ref };
    }
    return undefined;
  };
  return {
    get: (ref) => entries.get(ref),
    list: () => Array.from(entries.values()),
    resolve,
  };
}

/** 注册工具所需的配置片段（config.tools + memory 检索钩子）。 */
export interface ToolRegistrationOptions {
  maxOutputBytes?: number;
  execTimeoutMs?: number;
  envAllow?: readonly string[];
  memorySearch?: (query: string, limit?: number) => Promise<string[]>;
  /** dispatch_agent 的选项（含把子 agent 审批请求转给父 agent 的回调）。 */
  dispatch?: { approve?: (req: { toolName: string; summary: string }) => Promise<boolean> };
}

export interface ToolRegistrationContext extends ToolRegistrationOptions {
  config?: Config;
  /** 真实记忆检索钩子（store 提供时传入；未提供则不注册 memory_search）。 */
}

/**
 * 工具注册点（M2）：read_file / list_files / search_text / write_file /
 * apply_patch / exec（memory_search 仅在有 memorySearch 钩子时注册）。
 */
export function registerTools(
  config?: Config,
  ctx: ToolRegistrationContext = {},
): AgentTool[] {
  const execCfg = config?.tools.exec;
  const memorySearch = ctx.memorySearch;
  return createDefaultTools({
    maxOutputBytes: ctx.maxOutputBytes ?? execCfg?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    execTimeoutMs: ctx.execTimeoutMs ?? execCfg?.defaultTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    envAllow: ctx.envAllow ?? execCfg?.envAllow ?? [],
    ...(memorySearch ? { memorySearch } : {}),
    // agent 间派发：只有 tools.allow 里写了 dispatch_agent 才注册，
    // 这样默认行为不变，是否给某个 agent 派发权仍然由白名单决定。
    ...(config?.tools.allow.includes("dispatch_agent")
      ? { dispatch: ctx.dispatch ?? true }
      : {}),
  });
}

export const EMPTY_TOOLS: AgentTool[] = [];

export interface PolicyWiringOptions {
  allow: readonly string[];
  approval: "none" | "high" | "all";
  readOnly: boolean;
}

/**
 * 真实 PolicyEngine：白名单 -> 只读 -> 审批（PM_SPEC §7）。
 * `--yes` 不经过这里：它只把 approver 换成恒 true，白名单与只读检查仍然生效。
 */
export function createPermissivePolicy(options: PolicyWiringOptions): PolicyLike;
export function createPermissivePolicy(): PolicyLike;
export function createPermissivePolicy(options?: PolicyWiringOptions): PolicyLike {
  return createPolicyEngine(
    options ?? { allow: DEFAULT_TOOLS_ALLOW, approval: "none", readOnly: false },
  );
}

/** 真实 executor：测量耗时、把工具异常转成 ok:false 结果。 */
export function createDefaultExecutor(
  logger: Logger,
  options: { toolTimeoutMs?: number } = {},
): ToolExecutorLike {
  return createToolExecutor({
    logger,
    ...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
  });
}

/** `--yes`：恒批准的 approver（仍需 interactive=true 才会被 loop 调用）。 */
export const yesApprover: Approver = async () => true;

export interface LoopRunHooks {
  onStart: () => void;
  onStepStart: (step: number) => void;
  onApprovalStateChange: (state: "waiting" | "resolved") => void;
  onToolCall?: (info: {
    callId: string;
    name: string;
    ok: boolean;
    durationMs: number;
    arguments: unknown;
    result: unknown;
  }) => void;
  /** 每次模型调用结束后上报该步 usage（chat 状态栏用它算上下文占用）。 */
  onStepUsage?: (usage: ModelUsage) => void;
}

export interface LoopRunOptions {
  provider: ModelProvider;
  policy: PolicyLike;
  executor: ToolExecutorLike;
  logger: Logger;
  tools: AgentTool[];
  historyLimit: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  approval?: Approver;
  interactive: boolean;
  /** 已选定技能正文（CLI 每轮按需加载后传入）；未指定则不注入。 */
  skills?: LoadedSkill[];
  /** agent 的 SOUL 正文；注入 system prompt 最前面，未指定则不注入。 */
  soul?: string;
}

/** 组装 runAgent 依赖；与 AgentRuntime 配合使用。 */
export function createLoopRunner(
  options: LoopRunOptions,
): (request: AgentRequest, signal: AbortSignal, hooks: LoopRunHooks) => Promise<AgentResult> {
  const tools = options.tools;
  let currentHooks: LoopRunHooks | undefined;
  return async (request, signal, hooks) => {
    currentHooks = hooks;
    const toolsByName = new Map(tools.map((t) => [t.name, t]));
    const contextBuilder = new ContextBuilder({
      tools: tools.map(
        (t): ToolSpec => ({
          name: t.name,
          description: t.description,
          // 真实 JSON Schema（zod -> JSON Schema），不再是占位的 { type: "object" }
          parameters: zodToJsonSchema(t.inputSchema as unknown as Parameters<typeof zodToJsonSchema>[0]),
        }),
      ),
      cwd: request.cwd,
      readOnly: request.readOnly,
      historyLimit: options.historyLimit,
      skills: options.skills ?? [],
      ...(options.soul ? { soul: options.soul } : {}),
    });
    const deps = {
      provider: options.provider,
      contextBuilder,
      tools: {
        get: (name: string) => toolsByName.get(name),
        list: () => tools,
      },
      policy: options.policy,
      executor: options.executor,
      logger: options.logger,
      interactive: options.interactive,
      maxToolCalls: options.maxToolCalls,
      maxTotalTokens: options.maxTotalTokens,
      onStart: hooks.onStart,
      onStepStart: hooks.onStepStart,
      onToolCall: (info: Parameters<NonNullable<LoopRunHooks["onToolCall"]>>[0]) => {
        hooks.onToolCall?.(info);
      },
      onStepUsage: (usage: ModelUsage) => {
        hooks.onStepUsage?.(usage);
      },
      onApprovalStateChange: (state: "waiting" | "resolved") => {
        currentHooks?.onApprovalStateChange(state);
        hooks.onApprovalStateChange(state);
      },
      ...(options.approval ? { approval: options.approval } : {}),
    };
    return runAgent(request, deps, signal);
  };
}

export function makeRuntime(
  options: LoopRunOptions & { run?: ReturnType<typeof createLoopRunner> },
): AgentRuntime {
  return new AgentRuntime({
    logger: options.logger,
    run: options.run ?? createLoopRunner(options),
  });
}

export { ApprovalRequiredError, ErrorCode, MockProvider, statusForErrorCode };
export type { ChatMessage };

// ---------- M3：真实存储 / 记忆 / 技能接线 ----------

/**
 * 仓库根目录：从本文件解析。
 * 编译产物是 packages/cli/dist/wiring.js（源码是 packages/cli/src/wiring.ts），两者都
 * 位于 packages/<pkg>/<dir>/ 下，向上找名为 "packages" 的目录再取父目录即可。
 * （不直接写 import.meta 是为了兼容 tsconfig 里可能出现的 CommonJS 输出。）
 */
export function repoRootFrom(moduleUrl?: string): string {
  // 默认值用注入的模块 URL（bin/agentx.js 通过 AGENTX_REPO_ROOT 传入），避免依赖 import.meta 语法。
  const envRoot = process.env["AGENTX_REPO_ROOT"];
  if (moduleUrl === undefined && envRoot && envRoot !== "") return path.resolve(envRoot);
  const url = moduleUrl ?? process.env["AGENTX_MODULE_URL"] ?? "";
  if (url !== "") return repoRootFromDir(path.dirname(fileURLToPath(url)));
  return repoRootFromDir(process.cwd());
}

export function repoRootFromDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === "packages") return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, "..", "..", "..");
}

/** <home>/data/agentx.sqlite */
export function defaultDatabasePath(home: string): string {
  return path.join(home, "data", "agentx.sqlite");
}

export interface SqliteStoreBundle {
  db: ReturnType<typeof openStore>;
  sessionStore: SqliteSessionStore;
  taskStore: SqliteTaskStore;
  close(): void;
}

/** 打开 home 下的 SQLite（自动迁移）并构造 runtime 需要的 session/task store。 */
export function createSqliteStoreBundle(home: string): SqliteStoreBundle {
  const db = openStore(defaultDatabasePath(home));
  const sessionStore = new SqliteSessionStore(db);
  const taskStore = new SqliteTaskStore(db);
  return {
    db,
    sessionStore,
    taskStore,
    close: () => {
      try {
        db.close();
      } catch {
        // 已关闭时忽略。
      }
    },
  };
}

/** 长期记忆：config.memory.enabled=false 时返回 undefined（memory_search 工具不注册）。 */
export function createMemory(config: Config, home: string): MarkdownMemory | undefined {
  if (!config.memory.enabled) return undefined;
  const dir = config.memory.dir && config.memory.dir !== "" ? config.memory.dir : path.join(home, "memory");
  return new MarkdownMemory(dir);
}

/** memory_search 工具钩子：返回 "id: source: text" 形式的片段。 */
export function memorySearchHook(
  memory: MarkdownMemory | undefined,
): ((query: string, limit?: number) => Promise<string[]>) | undefined {
  if (!memory) return undefined;
  return async (query: string, limit?: number) =>
    memory.search(query, limit ?? 5).map((e) => `[${e.id}] (${e.source}) ${e.text}`);
}

/** 技能目录：配置的 skills.dirs（相对路径按 cwd 解析）在前，内置 <repoRoot>/skills 在后。 */
export function resolveSkillDirs(config: Config, cwd: string, repoRoot: string = repoRootFrom()): string[] {
  const configured = config.skills.dirs.map((d) => (path.isAbsolute(d) ? d : path.resolve(cwd, d)));
  const builtin = path.join(repoRoot, "skills");
  return [...configured.filter((d) => d !== builtin), builtin];
}

export function createSkillLoader(
  config: Config,
  cwd: string,
  logger?: Logger,
  repoRoot?: string,
  /** 额外的技能目录（agent 专属 skills/）；排在配置目录之前，同名时优先。 */
  extraDirs: string[] = [],
): SkillLoader {
  const base = resolveSkillDirs(config, cwd, repoRoot);
  const dirs = [...extraDirs.filter((d) => d !== ""), ...base];
  return new SkillLoader({
    dirs,
    maxBytes: config.skills.maxBytes,
    ...(logger ? { logger } : {}),
  });
}

/**
 * 按需选出本轮要注入的技能：显式 --skill 优先，否则 autoMatch。
 *
 * `whitelist` 存在时只允许这些技能：白名单之外的技能一律不注入，
 * 连 autoMatch 命中的也丢掉——这是 agent 作者用来收紧能力面的开关。
 * 白名单里出现不存在的技能名属于配置错误，调用方（CLI）必须报错而不是静默忽略。
 */
export async function selectSkills(
  loader: SkillLoader,
  options: { explicit?: readonly string[]; query?: string; autoMatch: boolean; whitelist?: readonly string[] },
): Promise<{ metas: SkillMeta[]; skills: LoadedSkill[] }> {
  const whitelist = options.whitelist;
  const allowed = (name: string): boolean => whitelist === undefined || whitelist.includes(name);
  const explicit = (options.explicit ?? []).filter((s) => s.trim() !== "").filter(allowed);
  const metas = (explicit.length > 0
    ? (await loader.discover()).filter((m) => explicit.includes(m.name))
    : options.autoMatch && options.query
      ? await loader.match(options.query)
      : []
  ).filter((m) => allowed(m.name));
  const skills = await loader.loadMany(metas.map((m) => m.name));
  return { metas, skills };
}
