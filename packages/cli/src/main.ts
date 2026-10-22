import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import {
  AgentxError,
  ConfigInvalidError,
  ErrorCode,
  createLogger,
  defaultLogFile,
  ensureHomeLayout,
  loadConfig,
  type AgentResult,
  type Approver,
  type Config,
  type Logger,
  type ModelUsage,
  type ProviderConfig,
} from "@agentx/core";
import { migrate, openDatabase, SCHEMA_VERSION, type SqliteDatabase } from "@agentx/store";
import { createDefaultTools } from "@agentx/tools";

import { Command, Option } from "commander";

import { Ui, type UiStreams } from "./ui.js";
import {
  buildProviders,
  createDefaultExecutor,
  createLoopRunner,
  createMemory,
  createPermissivePolicy,
  createSkillLoader,
  createSqliteStoreBundle,
  loadMockScriptFromEnv,
  memorySearchHook,
  registerTools,
  selectSkills,
  yesApprover,
  type ProviderResolver,
  type SqliteStoreBundle,
} from "./wiring.js";
import { AgentRuntime } from "@agentx/core";
import { formatSkillsTable, type SkillLoader } from "@agentx/skills";

export const VERSION = "0.1.0";

/** PM_SPEC E18 退出码。 */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  APPROVAL_REQUIRED: 3,
  CANCELLED: 130,
} as const;

export class UsageError extends Error {
  readonly exitCode = EXIT.USAGE;
}

export interface RunOptions {
  model?: string;
  session?: string;
  cwd?: string;
  maxSteps?: string;
  timeout?: string;
  verbose?: boolean;
  json?: boolean;
  yes?: boolean;
  readOnly?: boolean;
  excludeTools?: string;
  /** --skill（可重复）。 */
  skill?: string[];
}

export interface ChatOptions {
  model?: string;
  session?: string;
  cwd?: string;
  maxSteps?: string;
  timeout?: string;
  verbose?: boolean;
  json?: boolean;
  yes?: boolean;
  readOnly?: boolean;
  excludeTools?: string;
  skill?: string[];
}

export interface SessionsListOptions {
  limit?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface SessionsShowOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface SessionsDeleteOptions {
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface SkillsListOptions {
  json?: boolean;
  verbose?: boolean;
  cwd?: string;
}

export interface ConfigShowOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface ToolsListOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface ModelsListOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
}

export interface RunContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  /** chat 的输入流（默认 process.stdin）。 */
  stdin?: NodeJS.ReadableStream;
  /** 顶层 program，用于读取只写在命令前的全局选项（--json/--verbose）。 */
  program?: Command;
}

function parsePositiveInt(raw: string | undefined, flag: string, opts: { allowZero?: boolean } = {}): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  const min = opts.allowZero ? 0 : 1;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new UsageError(`option ${flag} expects an integer >= ${min}, received "${raw}"`);
  }
  return value;
}

/** 收集可重复的 --skill 值。 */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** 非 TTY 环境下的 approver：立即失败，不挂起等待（PM_SPEC E15）。 */
/**
 * 交互式审批器。
 *
 * 关键约束：不能自己再建一个 readline —— 那会与 chat 的 REPL 抢同一个 stdin，
 * 造成输入被吞或阻塞。存在外部 readline 时复用它的 question()。
 */
function createInteractiveApprover(
  ctx: RunContext,
  hooks: { beforePrompt?: () => void; afterPrompt?: () => void; readline?: { question: (q: string, cb: (a: string) => void) => void; pause?: () => void; resume?: () => void } } = {},
): Approver {
  return (req) =>
    new Promise<boolean>((resolve) => {
      hooks.beforePrompt?.();
      const prompt = `\n${req.summary} [y/N] `;
      const finish = (answer: string): void => {
        hooks.afterPrompt?.();
        resolve(/^y(es)?$/i.test(answer.trim()));
      };

      if (hooks.readline) {
        hooks.readline.question(prompt, finish);
        return;
      }

      const rl = createInterface({ input: process.stdin, output: ctx.stderr as NodeJS.WritableStream });
      const timer = setTimeout(() => {
        rl.close();
        finish("");
      }, 10 * 60 * 1000);
      rl.question(prompt, (answer) => {
        clearTimeout(timer);
        rl.close();
        finish(answer);
      });
    });
}

export function buildProgram(ctx: RunContext): Command {
  const program = new Command();
  // 顶层选项（--json / --verbose）不会传给子命令 action，需要从这里取。
  ctx.program = program;
  program
    .name("agentx")
    .description("Local command-line AI agent framework")
    .version(VERSION, "--version", "print version")
    .option("--json", "print a single JSON result line on stdout")
    .option("--verbose", "verbose logging (debug level)")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return;
      throw new UsageError(err.message);
    })
    .configureOutput({
      writeOut: (str) => {
        ctx.stdout.write(str);
      },
      writeErr: (str) => {
        ctx.stderr.write(str);
      },
    });

  const run = program
    .command("run")
    .description("run a single task")
    .argument("<prompt>", "task prompt")
    .option("--model <model>", "model reference (providerId:modelId or model id)")
    .option("--session <id>", "session id to continue")
    .option("--cwd <dir>", "working directory")
    .option("--max-steps <n>", "maximum agent loop steps")
    .option("--timeout <ms>", "task timeout in milliseconds")
    .option("--verbose", "verbose logging (debug level)")
    .option("--json", "print a single JSON result line on stdout")
    .option("--yes", "auto-approve tools that require approval")
    .option("--read-only", "disallow tools with side effects")
    .option("--exclude-tools <names>", "comma-separated tool names to disable")
    .option("--skill <name>", "load a skill by name (repeatable)", collect)
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  run.action(async (prompt: string, options: RunOptions) => {
    const code = await executeRun(prompt, options, ctx);
    process.exitCode = code;
  });

  const chat = program
    .command("chat")
    .description("interactive chat REPL (one task per line)")
    .option("--model <model>", "model reference (providerId:modelId or model id)")
    .option("--session <id>", "session id to continue")
    .option("--cwd <dir>", "working directory")
    .option("--max-steps <n>", "maximum agent loop steps")
    .option("--timeout <ms>", "task timeout in milliseconds")
    .option("--verbose", "verbose logging (debug level)")
    .option("--json", "print one JSON line per turn")
    .option("--yes", "auto-approve tools that require approval")
    .option("--read-only", "disallow tools with side effects")
    .option("--exclude-tools <names>", "comma-separated tool names to disable")
    .option("--skill <name>", "load a skill by name (repeatable)", collect)
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  chat.action(async (options: ChatOptions) => {
    const code = await executeChat(options, ctx);
    process.exitCode = code;
  });

  const sessions = program
    .command("sessions")
    .description("inspect and manage persisted sessions")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  sessions
    .command("list")
    .description("list sessions")
    .option("--limit <n>", "maximum number of sessions")
    .option("--json", "print a JSON array")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (options: SessionsListOptions) => {
      process.exitCode = await executeSessionsList(options, ctx);
    });

  sessions
    .command("show")
    .description("show a session transcript")
    .argument("<id>", "session id")
    .option("--json", "print the full session as JSON")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (id: string, options: SessionsShowOptions) => {
      process.exitCode = await executeSessionsShow(id, options, ctx);
    });

  sessions
    .command("delete")
    .description("delete a session (requires confirmation)")
    .argument("<id>", "session id")
    .option("--yes", "skip the confirmation prompt")
    .option("--json", "print a single JSON result line on stdout")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (id: string, options: SessionsDeleteOptions) => {
      process.exitCode = await executeSessionsDelete(id, options, ctx);
    });

  const skills = program
    .command("skills")
    .description("inspect discovered skills")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  skills
    .command("list")
    .description("list all discovered skills")
    .option("--json", "print a JSON array")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (options: SkillsListOptions) => {
      process.exitCode = await executeSkillsList(options, ctx);
    });

  // ---------- M4：config / models / doctor ----------

  const tools = program
    .command("tools")
    .description("inspect registered tools")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  tools
    .command("list")
    .description("list registered tools and whether each is allowed / needs approval")
    .option("--json", "print a JSON array")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (options: ToolsListOptions) => {
      process.exitCode = await executeToolsList(options, ctx);
    });

  const config = program
    .command("config")
    .description("inspect the effective configuration")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  config
    .command("show")
    .description("print the effective configuration with credentials redacted")
    .option("--json", "print the configuration as JSON")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (options: ConfigShowOptions) => {
      process.exitCode = await executeConfigShow(options, ctx);
    });

  const models = program
    .command("models")
    .description("inspect configured model providers")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    });

  models
    .command("list")
    .description("list providers, models and whether credentials are configured")
    .option("--json", "print a JSON array")
    .option("--verbose", "verbose logging (debug level)")
    .action(async (options: ModelsListOptions) => {
      process.exitCode = await executeModelsList(options, ctx);
    });

  program
    .command("doctor")
    .description("run local environment self-checks (no network access)")
    .option("--json", "print the check results as JSON")
    .option("--verbose", "verbose logging (debug level)")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed") return;
      throw new UsageError(err.message);
    })
    .action(async (options: DoctorOptions) => {
      process.exitCode = await executeDoctor(ctx, options);
    });

  // 顶层 help 的末尾补充：范围声明 + 分组命令索引（commander 只列出已注册的顶层命令）。
  program.addHelpText(
    "after",
    [
      "",
      "Scope: local CLI only. agentx never starts a server and never listens on a port.",
      "        It only makes outbound HTTPS calls to the configured model provider.",
      "",
      "Command groups:",
      "  run / chat                 one-shot task, interactive REPL",
      "  sessions list|show|delete  persisted session history (SQLite)",
      "  tools list                 registered tools, risk level, allow/approval state",
      "  skills list                discovered SKILL.md files",
      "  config show                effective config with credentials redacted",
      "  models list                providers, models, whether an API key is configured",
      "  doctor                     local self-checks (no network)",
      "",
      "Exit codes: 0 ok, 1 failure, 2 usage error, 3 approval required, 130 cancelled",
    ].join("\n"),
  );

  return program;
}

/** 判断结果对应的退出码（PM_SPEC E18）。 */
export function exitCodeForResult(result: AgentResult): number {
  if (result.status === "succeeded") return EXIT.OK;
  if (result.status === "cancelled") return EXIT.CANCELLED;
  if (result.errorCode === ErrorCode.APPROVAL_REQUIRED) return EXIT.APPROVAL_REQUIRED;
  return EXIT.FAILURE;
}

// ---------- 共享接线 ----------

interface PreparedRuntime {
  config: Config;
  home: string;
  logger: Logger;
  store: SqliteStoreBundle;
  providers: ProviderResolver;
  modelRef: string;
  skillLoader: SkillLoader;
  interactive: boolean;
  approval: Approver | undefined;
  excludeTools: string[];
  maxSteps: number | undefined;
  timeoutMs: number | undefined;
  readOnly: boolean;
}

class SetupFailure extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * run / chat / sessions 共享的初始化：配置 -> home 骨架 -> 日志 -> SQLite store ->
 * provider -> 技能加载器 -> 策略/executor。
 */
function prepare(options: {
  model?: string;
  cwd?: string;
  readOnly?: boolean;
  verbose?: boolean;
  json?: boolean;
  yes?: boolean;
  excludeTools?: string;
  maxSteps?: string;
  timeout?: string;
}, ctx: RunContext, argv: string[] = [], approvalHooks?: Parameters<typeof createInteractiveApprover>[1]): PreparedRuntime {
  const inherited = inheritedOptions(ctx);
  const json = Boolean(options.json ?? inherited.json ?? false);
  const verbose = Boolean(options.verbose ?? inherited.verbose ?? false);
  let config: Config;
  let home: string;
  let mergedEnv: NodeJS.ProcessEnv = ctx.env;
  try {
    const model = options.model ?? argvModel(argv);
    const loaded = loadConfig({
      home: ctx.env.AGENTX_HOME,
      env: ctx.env,
      overrides: {
        ...(model ? { defaultModel: model } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.readOnly ? { readOnly: true } : {}),
        ...(verbose ? { logging: { level: "debug" as const } } : {}),
      },
    });
    config = loaded.config;
    home = loaded.home;
    if (loaded.env) mergedEnv = loaded.env;
    for (const w of loaded.warnings ?? []) ctx.stderr.write(`agentx: warning: ${w}\n`);
  } catch (err) {
    throw new SetupFailure((err as Error).message, EXIT.USAGE);
  }

  const maxSteps = parsePositiveInt(options.maxSteps, "--max-steps");
  const timeoutMs = parsePositiveInt(options.timeout, "--timeout");

  ensureHomeLayout(home);
  const level = verbose ? "debug" : config.logging.level;
  const logger: Logger = createLogger({
    level,
    file: defaultLogFile(home),
    stderr: !json && level === "debug",
  });

  const modelRef = options.model ?? config.defaultModel;
  const mockScript = loadMockScriptFromEnv(ctx.env);
  const providers = buildProviders(config.providers, mockScript, mergedEnv);
  const resolved = providers.resolve(modelRef);
  if (!resolved) {
    throw new SetupFailure(
      `unknown model "${modelRef}" (available providers: ${providers
        .list()
        .map((p) => p.type)
        .join(", ")})`,
      EXIT.USAGE,
    );
  }

  const store = createSqliteStoreBundle(home);
  const cwd = path.resolve(config.cwd);
  const skillLoader = createSkillLoader(config, cwd, logger);
  const interactive = options.yes ? true : ctx.interactive;
  const approval: Approver | undefined = options.yes
    ? yesApprover
    : interactive
      ? createInteractiveApprover(ctx, approvalHooks ?? {})
      : undefined;

  return {
    config,
    home,
    logger,
    store,
    providers,
    modelRef,
    skillLoader,
    interactive,
    approval,
    excludeTools: parseListOption(options.excludeTools),
    maxSteps,
    timeoutMs,
    readOnly: Boolean(options.readOnly ?? config.readOnly),
  };
}

/** 构造一个 task 级别的 AgentRuntime（同一会话多轮复用时每轮新建 taskId）。 */
/** 把 home 前缀换成 ~，让面板里的路径短一些。 */
function shortenHome(p: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/** 结果转成脚本友好的 JSON 结构（与 run --json 一致）。 */
function toJsonResult(result: AgentResult): Record<string, unknown> {
  return {
    taskId: result.taskId,
    sessionId: result.sessionId,
    status: result.status,
    terminationReason: result.terminationReason,
    steps: result.steps,
    usage: result.usage,
    durationMs: result.durationMs,
    finalText: result.finalText,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorSummary ? { errorSummary: result.errorSummary } : {}),
  };
}

/** chat 的进度事件：让 UI 能实时显示工具调用与步骤。 */
export interface RuntimeEvent {
  kind: "tool" | "step" | "usage";
  name?: string;
  args?: unknown;
  ok?: boolean;
  durationMs?: number;
  step?: number;
  /** kind=usage 时：该步模型调用的 usage。 */
  usage?: ModelUsage;
}

function makeRuntime(
  prep: PreparedRuntime,
  skills: Array<{ name: string; body: string }>,
  onEvent?: (event: RuntimeEvent) => void,
): AgentRuntime {
  const { config, logger } = prep;
  const resolved = prep.providers.resolve(prep.modelRef);
  if (!resolved) throw new SetupFailure(`unknown model "${prep.modelRef}"`, EXIT.USAGE);
  const tools =
    prep.excludeTools.length === 0
      ? registerTools(config, { ...memoryToolContext(prep) })
      : registerTools(config, { ...memoryToolContext(prep) }).filter((t) => !prep.excludeTools.includes(t.name));
  const policy = createPermissivePolicy({
    allow: config.tools.allow,
    approval: config.policy.approval,
    readOnly: prep.readOnly,
  });
  const runLoop = createLoopRunner({
    provider: resolved.provider,
    policy,
    executor: createDefaultExecutor(logger),
    logger,
    tools,
    historyLimit: config.context.historyMessages,
    maxToolCalls: config.tools.maxCallsPerTask,
    maxTotalTokens: config.maxTotalTokens,
    interactive: prep.interactive,
    skills,
    ...(prep.approval ? { approval: prep.approval } : {}),
  });
  // 包一层：把 loop 的 onToolCall 钩子转成 UI 事件（仅 chat 传入 onEvent 时启用）。
  const runWithEvents =
    onEvent === undefined
      ? runLoop
      : async (
          request: Parameters<typeof runLoop>[0],
          signal: AbortSignal,
          hooks: Parameters<typeof runLoop>[2],
        ) => {
          hooks.onToolCall = (info) => {
            onEvent({
              kind: "tool",
              name: info.name,
              args: info.arguments,
              ok: info.ok,
              durationMs: info.durationMs,
            });
          };
          hooks.onStepUsage = (usage) => onEvent({ kind: "usage", usage });
          return runLoop(request, signal, hooks);
        };

  return new AgentRuntime({
    logger,
    sessionStore: prep.store.sessionStore,
    taskStore: prep.store.taskStore,
    run: runWithEvents,
  });
}

function memoryToolContext(prep: PreparedRuntime): { memorySearch?: (q: string, limit?: number) => Promise<string[]> } {
  const memory = createMemory(prep.config, prep.home);
  const hook = memorySearchHook(memory);
  return hook ? { memorySearch: hook } : {};
}

function printSetupFailure(err: unknown, ctx: RunContext): number {
  if (err instanceof SetupFailure) {
    ctx.stderr.write(`agentx: ${err.message}\n`);
    return err.exitCode;
  }
  if (err instanceof ConfigInvalidError) {
    ctx.stderr.write(`agentx: ${err.message}\n`);
    return EXIT.USAGE;
  }
  ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
  return EXIT.FAILURE;
}

/** 单次任务执行：run 命令与 chat 每轮共用。 */
async function runTurn(
  prep: PreparedRuntime,
  prompt: string,
  sessionId: string,
  ctx: RunContext,
  json: boolean,
  onEvent?: (event: RuntimeEvent) => void,
  /** false 时由调用方（chat TUI）自行渲染结果，本函数不写 stdout。 */
  emit = true,
): Promise<AgentResult> {
  const { config } = prep;
  const taskId = `task_${randomUUID()}`;
  const selection = await selectSkills(prep.skillLoader, {
    explicit: (ctx as { skills?: string[] }).skills ?? [],
    query: prompt,
    autoMatch: config.skills.autoMatch,
  });
  const runtime = makeRuntime(prep, selection.skills, onEvent);
  if (prep.logger.debug) {
    prep.logger.debug("skills.selected", { skills: selection.metas.map((m) => m.name) });
  }

  const controller = new AbortController();
  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount++;
    if (sigintCount === 1) {
      prep.logger.warn("task.sigint", { taskId });
      controller.abort();
    } else {
      ctx.stderr.write("agentx: forced exit\n");
      process.exit(EXIT.CANCELLED);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    const result = await runtime.run(
      {
        taskId,
        sessionId,
        input: prompt,
        cwd: path.resolve(config.cwd),
        model: prep.modelRef,
        maxSteps: prep.maxSteps ?? config.maxSteps,
        timeoutMs: prep.timeoutMs ?? config.timeoutMs,
        readOnly: prep.readOnly,
      },
      controller.signal,
    );
    // 完整结果（steps/usage/终止原因）补充落库。
    try {
      prep.store.taskStore.finish(taskId, {
        status: result.status,
        terminationReason: result.terminationReason,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.errorSummary ? { errorSummary: result.errorSummary } : {}),
        steps: result.steps,
        usage: result.usage,
        finishedAt: result.finishedAt,
      });
    } catch (finishErr) {
      prep.logger.warn("task.finish.failed", { taskId, message: (finishErr as Error).message });
    }
    if (!emit) {
      // 调用方（chat TUI / 管道）自行渲染结果；这里只把错误摘要送到 stderr，
      // 绝不能重复写 stdout，否则管道会拿到两份答案。
      if (result.status !== "succeeded" && result.errorSummary) {
        ctx.stderr.write(`agentx: ${result.errorSummary}\n`);
      }
    } else if (json) {
      const payload = {
        taskId: result.taskId,
        sessionId: result.sessionId,
        status: result.status,
        terminationReason: result.terminationReason,
        steps: result.steps,
        usage: result.usage,
        durationMs: result.durationMs,
        finalText: result.finalText,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.errorSummary ? { errorSummary: result.errorSummary } : {}),
      };
      ctx.stdout.write(`${JSON.stringify(payload)}\n`);
    } else if (result.status === "succeeded") {
      ctx.stdout.write(result.finalText.endsWith("\n") ? result.finalText : `${result.finalText}\n`);
    } else {
      ctx.stderr.write(
        `agentx: task ${result.status} (${result.terminationReason}${result.errorCode ? `, ${result.errorCode}` : ""})\n`,
      );
      if (result.errorSummary) ctx.stderr.write(`agentx: ${result.errorSummary}\n`);
    }
    return result;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// ---------- run ----------

export async function executeRun(
  prompt: string,
  options: RunOptions,
  ctx: RunContext,
  argv: string[] = [],
): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  let prep: PreparedRuntime;
  try {
    prep = prepare(options, ctx, argv);
  } catch (err) {
    return printSetupFailure(err, ctx);
  }
  try {
    const sessionId = options.session ?? `ses_${randomUUID()}`;
    const result = await runTurn(prep, prompt, sessionId, ctx, json);
    return exitCodeForResult(result);
  } catch (err) {
    if (err instanceof SetupFailure) return printSetupFailure(err, ctx);
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  } finally {
    prep.store.close();
  }
}

// ---------- chat ----------

export interface ChatSessionInfo {
  sessionId: string;
  turns: number;
}

/**
 * chat 的输入提示符：带会话短 id（对齐 Hermes 的「项目名 ❯」）。
 *
 * 必须是函数而不是固定字符串：`/new` 之后提示符要跟着换，而 readline 的
 * `setPrompt()` 只有拿到新字符串才能刷新。
 */
export function promptFor(sessionId: string, ui: Pick<Ui, "mode" | "color">): string {
  const short = sessionId.slice(0, 8);
  if (ui.mode === "silent") return "agentx> ";
  if (ui.color) return `\u001b[96m${short} ❯\u001b[0m `;
  return `${short}> `;
}

/**
 * chat REPL：每行一个任务；共享同一 session 历史（E13），`--session` 续接（E14）。
 * 非 TTY（管道）时按行读到 EOF 正常退出，不挂起（§13.2）。
 */
export async function executeChat(options: ChatOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  let prep: PreparedRuntime;
  try {
    prep = prepare(options, ctx, []);
  } catch (err) {
    return printSetupFailure(err, ctx);
  }
  (ctx as { skills?: string[] }).skills = options.skill ?? [];

  const input = ctx.stdin ?? process.stdin;
  const wantTty = Boolean((input as { isTTY?: boolean }).isTTY);
  const tty = ctx.interactive && wantTty;
  let sessionId = options.session ?? `ses_${randomUUID()}`;

  // 显式传递 isTTY/columns：RunContext.stdout 是 WritableStream 类型，
  // 直接 cast 会让 isTTY 变成 undefined，导致 UI 误判为 TUI 模式污染管道。
  const stdoutTTY = Boolean((ctx.stdout as { isTTY?: boolean }).isTTY);
  const ui = new Ui(
    {
      stdout: {
        write: (chunk: string) => ctx.stdout.write(chunk) as unknown as boolean,
        isTTY: stdoutTTY,
        columns: (ctx.stdout as { columns?: number }).columns,
      },
      stderr: ctx.stderr as unknown as UiStreams["stderr"],
      env: ctx.env,
    },
    { json },
  );

  if (ctx.env.AGENTX_DEBUG_UI) {
    ctx.stderr.write(`DEBUG ui.mode=${ui.mode} stdoutTTY=${stdoutTTY} interactive=${ctx.interactive} json=${json}\n`);
  }

  const toolNames = registerTools(prep.config, { ...memoryToolContext(prep) }).map((t) => t.name);

  // 上下文上限来自 provider 的 ModelInfo；未知时状态栏省略进度条而不是编一个数。
  const resolvedModel = prep.providers.resolve(prep.modelRef);
  const contextLimit = resolvedModel?.provider.models.find((m) => m.id === resolvedModel.modelId)?.contextLimit;

  const banner = (): void => {
    ctx.stdout.write(ui.logo());

    // 工具按「功能」分组（对应参考产品的 file / delegation / browser 版式），
    // 风险等级改为条目的后缀标注，信息不丢但不占版面。
    const tools = registerTools(prep.config, { ...memoryToolContext(prep) });
    const groups: Array<{ label: string; items: string[] }> = [
      {
        label: "file",
        items: tools.filter((t) => ["read_file", "list_files", "write_file", "apply_patch"].includes(t.name)).map((t) => t.name),
      },
      {
        label: "search",
        items: tools.filter((t) => ["search_text", "memory_search"].includes(t.name)).map((t) => t.name),
      },
      { label: "exec", items: tools.filter((t) => t.name === "exec").map((t) => t.name) },
    ].filter((g) => g.items.length > 0);

    ctx.stdout.write(
      ui.sidebarPanel(
        `agentx v${VERSION} · local CLI agent`,
        [
          { label: "model", items: [prep.modelRef, shortenHome(path.resolve(prep.config.cwd), ctx.env)] },
          ...groups,
          { label: "session", items: [sessionId.slice(0, 8), prep.readOnly ? "read-only" : "read-write"] },
          // 命令清单不再逐条列出：提示符就带 ❯，/help 一条就能看全，省下整行高度。
          { label: "help", items: [ui.mode === "tui" ? "/help · commands" : "/help · commands (plain)"] },
        ],
        { titleRight: ui.mode === "tui" ? "TUI" : "PLAIN" },
      ),
    );
  };

  const rl = createInterface({
    input,
    output: ctx.stdout as NodeJS.WritableStream,
    terminal: tty,
    prompt: promptFor(sessionId, ui),
  });

  let pending: Promise<void> = Promise.resolve();
  let turns = 0;
  let lastExitCode: number = EXIT.OK;

  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line === "") return;
    if (line === "/exit" || line === "/quit" || line === "/q") {
      rl.close();
      return;
    }
    if (line === "/new") {
      sessionId = `ses_${randomUUID()}`;
      prep.store.sessionStore.ensureSession(sessionId, path.resolve(prep.config.cwd));
      // 新会话的计时从零开始，否则状态栏会继续显示上一个会话的累计值。
      turns = 0;
      if (tty) rl.setPrompt(promptFor(sessionId, ui));
      ctx.stdout.write(`new session ${sessionId}\n`);
      return;
    }
    if (line === "/sessions") {
      const rows = prep.store.sessionStore.listSessions({ limit: 20 });
      ctx.stdout.write(`${formatSessionsTable(rows)}\n`);
      return;
    }
    if (line === "/tools") {
      const tools = registerTools(prep.config, { ...memoryToolContext(prep) });
      ctx.stdout.write(
        ui.panel(
          "Registered tools",
          tools.map((t) =>
            ui.kv(
              t.name,
              `${t.riskLevel.padEnd(6)} ${t.readOnly ? "read-only  " : "side-effect"} ${t.description.slice(0, 40)}`,
              12,
              t.riskLevel === "high" ? "red" : t.riskLevel === "medium" ? "yellow" : "green",
            ),
          ),
        ),
      );
      return;
    }
    if (line === "/help" || line === "/?") {
      ctx.stdout.write(
        ui.panel("Help", [
          ui.kv("/help", "show this help", 12),
          ui.kv("/new", "start a new session", 12),
          ui.kv("/sessions", "list recent sessions", 12),
          ui.kv("/tools", "list tools and risk levels", 12),
          ui.kv("/exit", "leave agentx (/quit, Ctrl+D)", 12),
          "",
          ui.kv("Tips", "Ctrl+C cancels the running task; twice force-exits", 12, "gray"),
        ]),
      );
      return;
    }
    if (line.startsWith("/")) {
      ctx.stderr.write(`agentx: unknown command ${line} (try /new /sessions /exit)\n`);
      return;
    }
    // TTY 下 readline 已经把「提示符 + 输入」回显在屏幕上了，再画一遍 ❯ 就是重复。
    // 只有非 TTY（但仍是 plain 模式，例如读文件输入）才需要我们自己回显。
    if (!json && ui.mode !== "silent" && !tty) ctx.stdout.write(`\n${ui.userLine(line)}\n`);
    const toolLines: string[] = [];
    let spinnerOn = false;
    // 本轮上下文占用：chat 的进度钩子按步记录，只保留最后一步（最新上下文）。
    let lastStepUsage: ModelUsage | undefined;
    try {
      if (!json && ui.mode !== "silent") {
        ui.startSpinner("thinking");
        spinnerOn = true;
      }
      const result = await runTurn(prep, line, sessionId, ctx, json, (event) => {
        if (event.kind === "usage") {
          // 只保留最后一步：状态栏要的是「当前上下文有多大」，不是各步之和。
          if (event.usage) lastStepUsage = event.usage;
          return;
        }
        if (json || event.kind !== "tool" || !event.name) return;
        const rendered = ui.toolLine(event.name, event.args, Boolean(event.ok), event.durationMs);
        toolLines.push(rendered);
        // 工具执行期间先把 spinner 停掉，避免和工具行抢同一行
        if (spinnerOn) {
          ui.stopSpinner();
          spinnerOn = false;
        }
        ctx.stdout.write(`${rendered}\n`);
        ui.startSpinner("thinking");
        spinnerOn = true;
      }, false);
      if (spinnerOn) {
        ui.stopSpinner();
        spinnerOn = false;
      }
      turns++;
      lastExitCode = exitCodeForResult(result) === EXIT.CANCELLED ? EXIT.CANCELLED : EXIT.OK;

      if (json) {
        ctx.stdout.write(`${JSON.stringify(toJsonResult(result))}\n`);
      } else if (ui.mode === "silent") {
        // 管道模式：只输出答案本身，保持 `agentx chat | ...` 可用
        if (result.status === "succeeded") {
          ctx.stdout.write(result.finalText.endsWith("\n") ? result.finalText : `${result.finalText}\n`);
        } else if (result.errorSummary) {
          ctx.stderr.write(`agentx: ${result.errorSummary}\n`);
        }
      } else {
        // Hermes 版式：回答 → 分隔线 → 状态栏 → 分隔线。
        // 状态栏是每轮的常驻底栏，所以两条 rule 把「最后一次回答」和「下一次输入」隔开。
        if (result.status === "succeeded") {
          ctx.stdout.write(`${ui.assistantLine(result.finalText)}\n`);
        } else {
          ctx.stdout.write(
            `${ui.badge("err", "failed")} ${ui.badge("muted", result.terminationReason)}${
              result.errorCode ? ` ${ui.badge("muted", result.errorCode)}` : ""
            }\n`,
          );
          if (result.errorSummary) ctx.stderr.write(`agentx: ${result.errorSummary}\n`);
        }
        // 上下文占用取「最近一次请求的 prompt+completion」，而不是本轮累加值：
        // 多步任务的 usage 是各步之和，拿它算占用会把每一步的上下文重复计数。
        // 每步的 usage 由 chat 的进度钩子记录进 lastStepUsage（core 的 AgentResult 不暴露它）。
        const usedTokens = lastStepUsage
          ? lastStepUsage.promptTokens + lastStepUsage.completionTokens
          : result.usage.totalTokens;
        // 会话视角的累计耗时：本轮耗时 + 该会话历史任务耗时之和（本轮任务记录
        // 在 finish 之后才落 finishedAt，所以单独把本轮算进来）。
        const sessionMs = result.durationMs + sessionWorkMs(prep.store.taskStore, sessionId);
        ctx.stdout.write(
          `${ui.statusLine({
            model: prep.modelRef,
            usedTokens,
            ...(contextLimit !== undefined ? { contextLimit } : {}),
            turnMs: result.durationMs,
            sessionMs,
            steps: result.steps,
            ...(result.status !== "succeeded" && result.errorCode ? { errorCode: result.errorCode } : {}),
          })}\n`,
        );
        ctx.stdout.write(`${ui.rule()}\n`);
      }
    } catch (err) {
      if (spinnerOn) {
        ui.stopSpinner();
        spinnerOn = false;
      }
      // 单轮失败不退出循环。
      ctx.stderr.write(`agentx: turn failed: ${(err as Error).message}\n`);
    }
  };

  if (tty) banner();
  else if (ui.mode !== "silent") ctx.stdout.write(`agentx chat — session ${sessionId} (non-interactive)\n`);

  const closed = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    rl.on("close", finish);
    // 管道 EOF 时输入流结束，也视为会话结束，保证进程能退出。
    input.on?.("end", () => {
      try {
        rl.close();
      } catch {
        // 已关闭时忽略。
      }
      finish();
    });
  });

  rl.on("line", (line: string) => {
    pending = pending.then(() => handleLine(line)).catch((err: unknown) => {
      ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    });
  });

  if (tty) rl.prompt();
  rl.on("line", () => {
    if (tty) rl.prompt();
  });

  await closed;
  await pending;
  prep.store.close();
  ui.stopSpinner();
  if (!json && turns > 0 && ui.mode !== "silent") {
    ctx.stdout.write(`\n${ui.badge("muted", `session ${sessionId.slice(0, 8)} · ${turns} turn(s) · resume with --session ${sessionId}`)}\n`);
  }
  return turns === 0 ? EXIT.OK : lastExitCode;
}

// ---------- sessions ----------

/**
 * 会话的累计任务耗时（毫秒），状态栏 `⏲` 段用。
 *
 * 语义是「这个会话里 agent 总共干了多久活」——各任务 startedAt->finishedAt 之和，
 * 不含用户思考与空转时间。为什么不用 createdAt->now：
 * 那个值会随进程启动时刻漂移，同一会话重启后 _session-2.6s_ 这种数字对用户没有意义。
 * 为什么不只用本轮 result.durationMs：那等于把「本轮耗时」写了两遍。
 *
 * 未完成的任务（无 finishedAt）按 now 计，避免运行中显示 0。
 */
export function sessionWorkMs(
  store: { listTasks(id: string): Array<{ startedAt?: string; finishedAt?: string }> },
  sessionId: string,
  now: number = Date.now(),
): number {
  try {
    let total = 0;
    for (const task of store.listTasks(sessionId)) {
      const start = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
      if (!Number.isFinite(start)) continue;
      const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
      if (!Number.isFinite(end)) continue;
      total += Math.max(0, end - start);
    }
    return total;
  } catch {
    return 0;
  }
}

function formatSessionsTable(rows: Array<{ id: string; title: string; updatedAt: string; messageCount: number }>): string {
  if (rows.length === 0) return "no sessions\n";
  const headers = ["ID", "TITLE", "UPDATED", "MSGS"];
  const data = rows.map((r) => [r.id.slice(0, 8), r.title, r.updatedAt, String(r.messageCount)]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length))).join("  ").trimEnd();
  return [fmt(headers), ...data.map(fmt)].join("\n");
}

function withStore<T>(
  ctx: RunContext,
  options: { verbose?: boolean; json?: boolean },
  fn: (store: SqliteStoreBundle, home: string) => T,
): T {
  const inherited = inheritedOptions(ctx);
  const verbose = Boolean(options.verbose ?? inherited.verbose ?? false);
  const loaded = loadConfig({
    home: ctx.env.AGENTX_HOME,
    env: ctx.env,
    ...(verbose ? { overrides: { logging: { level: "debug" as const } } } : {}),
  });
  ensureHomeLayout(loaded.home);
  const store = createSqliteStoreBundle(loaded.home);
  try {
    return fn(store, loaded.home);
  } finally {
    store.close();
  }
}

export async function executeSessionsList(options: SessionsListOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  const limit = parsePositiveInt(options.limit, "--limit", { allowZero: true });
  try {
    const rows = withStore(ctx, options, (store) =>
      store.sessionStore.listSessions(limit !== undefined ? { limit } : {}),
    );
    if (json) ctx.stdout.write(`${JSON.stringify(rows)}\n`);
    else ctx.stdout.write(`${formatSessionsTable(rows)}\n`);
    return EXIT.OK;
  } catch (err) {
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

export async function executeSessionsShow(
  id: string,
  options: SessionsShowOptions,
  ctx: RunContext,
): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  try {
    const detail = withStore(ctx, options, (store) => store.sessionStore.getSession(id));
    if (json) {
      ctx.stdout.write(`${JSON.stringify(detail)}\n`);
      return EXIT.OK;
    }
    ctx.stdout.write(`id:        ${detail.id}\n`);
    ctx.stdout.write(`title:     ${detail.title}\n`);
    ctx.stdout.write(`created:   ${detail.createdAt}\n`);
    ctx.stdout.write(`updated:   ${detail.updatedAt}\n`);
    ctx.stdout.write(`messages:  ${detail.messageCount}\n`);
    ctx.stdout.write("\ntranscript:\n");
    for (const msg of detail.messages) {
      if (msg.role === "tool") {
        ctx.stdout.write(`[tool] ${truncate(msg.content, 500)}\n`);
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        if (msg.content.trim() !== "") ctx.stdout.write(`assistant: ${msg.content}\n`);
        for (const call of msg.toolCalls) {
          const args = JSON.stringify(call.arguments ?? {});
          ctx.stdout.write(`[tool ${call.name}] ${truncate(args, 200)}\n`);
        }
      } else {
        ctx.stdout.write(`${msg.role}: ${msg.content}\n`);
      }
    }
    return EXIT.OK;
  } catch (err) {
    if (err instanceof AgentxError && err.code === ErrorCode.SESSION_NOT_FOUND) {
      ctx.stderr.write(`agentx: ${err.message}\n`);
      return EXIT.FAILURE;
    }
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * sessions delete：必须二次确认（E22）。
 * 非 TTY 且没有 --yes -> 退出码 3 且不删除；TTY 下询问 y/N。
 */
export async function executeSessionsDelete(
  id: string,
  options: SessionsDeleteOptions,
  ctx: RunContext,
): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  const emit = (payload: Record<string, unknown>): void => {
    if (json) ctx.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    return await withStoreAsync(ctx, options, async (store) => {
      const exists = store.sessionStore.hasSession(id);
      if (!exists) {
        ctx.stderr.write(`agentx: session not found: ${id}\n`);
        emit({ deleted: false, id, reason: "SESSION_NOT_FOUND" });
        return EXIT.FAILURE;
      }
      if (!options.yes) {
        if (!ctx.interactive) {
          ctx.stderr.write(
            `agentx: refusing to delete session "${id}" without confirmation (non-interactive; pass --yes)\n`,
          );
          emit({ deleted: false, id, reason: "APPROVAL_REQUIRED" });
          return EXIT.APPROVAL_REQUIRED;
        }
        const ok = await askYesNo(ctx, `delete session "${id}" and all its messages? [y/N] `);
        if (!ok) {
          ctx.stderr.write("agentx: aborted\n");
          emit({ deleted: false, id, reason: "cancelled" });
          return EXIT.CANCELLED;
        }
      }
      const deleted = store.sessionStore.deleteSession(id);
      if (!json) ctx.stdout.write(deleted ? `deleted session ${id}\n` : `session not found: ${id}\n`);
      emit({ deleted, id });
      return deleted ? EXIT.OK : EXIT.FAILURE;
    });
  } catch (err) {
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

async function withStoreAsync<T>(
  ctx: RunContext,
  options: { verbose?: boolean },
  fn: (store: SqliteStoreBundle) => Promise<T>,
): Promise<T> {
  const inherited = inheritedOptions(ctx);
  const verbose = Boolean(options.verbose ?? inherited.verbose ?? false);
  const loaded = loadConfig({
    home: ctx.env.AGENTX_HOME,
    env: ctx.env,
    ...(verbose ? { overrides: { logging: { level: "debug" as const } } } : {}),
  });
  ensureHomeLayout(loaded.home);
  const store = createSqliteStoreBundle(loaded.home);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function askYesNo(ctx: RunContext, question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: ctx.stderr as NodeJS.WritableStream });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------- skills ----------

export async function executeSkillsList(options: SkillsListOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  try {
    const loaded = loadConfig({ home: ctx.env.AGENTX_HOME, env: ctx.env });
    ensureHomeLayout(loaded.home);
    const cwd = path.resolve(options.cwd ?? loaded.config.cwd);
    const logger = createLogger({ level: "warn", stderr: !json });
    const loader = createSkillLoader(loaded.config, cwd, logger);
    const metas = await loader.discover();
    const warnings = loader.getWarnings();
    if (!json) {
      for (const w of warnings) ctx.stderr.write(`agentx: warn: skipped skill ${w.file}: ${w.reason}\n`);
    }
    if (json) {
      ctx.stdout.write(`${JSON.stringify(metas.map(({ file: _file, ...rest }) => rest))}\n`);
    } else {
      ctx.stdout.write(formatSkillsTable(metas));
    }
    return EXIT.OK;
  } catch (err) {
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

// ---------- tools list（M4） ----------

interface ToolRow {
  name: string;
  riskLevel: string;
  readOnly: boolean;
  allowed: boolean;
  needsApproval: boolean;
  description: string;
}

export async function executeToolsList(options: ToolsListOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  try {
    const loaded = loadConfig({ home: ctx.env.AGENTX_HOME, env: ctx.env });
    const { config } = loaded;
    const approval = config.policy.approval;
    const allow = new Set(config.tools.allow);
    const rows: ToolRow[] = createDefaultTools().map((tool) => ({
      name: tool.name,
      riskLevel: tool.riskLevel,
      readOnly: tool.readOnly,
      allowed: allow.has(tool.name),
      needsApproval:
        approval === "none" ? false : approval === "all" ? tool.readOnly === false : tool.riskLevel === "high",
      description: tool.description,
    }));
    if (!json) {
      const headers = ["TOOL", "RISK", "SIDE EFFECTS", "ALLOWED", "APPROVAL"];
      const data = rows.map((r) => [
        r.name,
        r.riskLevel,
        r.readOnly ? "no" : "yes",
        r.allowed ? "yes" : "no",
        r.needsApproval ? "required" : "-",
      ]);
      const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
      const fmt = (cells: string[]): string =>
        cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length))).join("  ").trimEnd();
      ctx.stdout.write(`${[fmt(headers), ...data.map(fmt)].join("\n")}\n`);
      ctx.stdout.write(
        `\n${rows.length} tool(s); approval mode: ${approval}; read-only mode: ${config.readOnly ? "on" : "off"}\n`,
      );
    } else {
      ctx.stdout.write(`${JSON.stringify(rows)}\n`);
    }
    return EXIT.OK;
  } catch (err) {
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

// ---------- config show / models list（M4） ----------

/** 任意形如 apiKey / token / secret / password / authorization 的字段一律脱敏（E16）。 */
const CREDENTIAL_KEY = /(api[-_]?key|access[-_]?key|secret|token|password|passwd|authorization|cookie|credential)/i;
/** 用量类字段含 "token" 但不是凭据，保留数值（与 core/logger 的口径一致）。 */
const NON_CREDENTIAL_TOKEN_KEY = /token(?:s|count|usage|usagecount|limit)$/i;
const REDACTED = "***";

function isCredentialKey(key: string): boolean {
  if (NON_CREDENTIAL_TOKEN_KEY.test(key)) return false;
  // apiKeyEnv 只是环境变量的名字，不含凭据本身，保留以便排障。
  if (/^(api[-_]?key[-_]?env|key[-_]?env)$/i.test(key)) return false;
  return CREDENTIAL_KEY.test(key);
}

/**
 * 递归脱敏：敏感键的值替换为 "***"（空值也替换，避免泄漏"是否为空"之外的任何信息）；
 * 字符串内的 sk-* / Bearer 片段同样替换。
 */
export function redactConfig<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") {
    return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, REDACTED).replace(/Bearer\s+\S+/g, REDACTED) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]" as unknown as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactConfig(item, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isCredentialKey(key) ? REDACTED : redactConfig(val, seen);
  }
  return out as unknown as T;
}

/** provider 是否已配置凭据：只回 true/false，绝不返回 key 本身。 */
export function providerKeyState(def: ProviderConfig, env: NodeJS.ProcessEnv): { configured: boolean; source: string } {
  if (def.type === "mock") return { configured: true, source: "not-required" };
  if (def.apiKey !== undefined && def.apiKey.trim() !== "") return { configured: true, source: "config" };
  if (def.apiKeyEnv) {
    const fromEnv = env[def.apiKeyEnv];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return { configured: true, source: `env:${def.apiKeyEnv}` };
    return { configured: false, source: `env:${def.apiKeyEnv} (missing)` };
  }
  return { configured: false, source: "none" };
}

export async function executeConfigShow(options: ConfigShowOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  try {
    const loaded = loadConfig({ home: ctx.env.AGENTX_HOME, env: ctx.env });
    const safe = redactConfig(loaded.config);
    if (json) {
      ctx.stdout.write(
        `${JSON.stringify({ config: safe, home: loaded.home, sources: loaded.sources }, null, 2)}\n`,
      );
      return EXIT.OK;
    }
    ctx.stdout.write(`home:    ${loaded.home}\n`);
    ctx.stdout.write(`config:  ${path.join(loaded.home, "config.json")}${existsSync(path.join(loaded.home, "config.json")) ? "" : " (not present)"}\n`);
    ctx.stdout.write(`sources: ${loaded.sources.join(", ")}\n\n`);
    ctx.stdout.write("--- effective config (credentials redacted) ---\n");
    ctx.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    for (const [id, def] of Object.entries(loaded.config.providers)) {
      const state = providerKeyState(def, loaded.env ?? ctx.env);
      ctx.stderr.write(`agentx: provider ${id}: api key ${state.configured ? "configured" : "missing"} (${state.source})\n`);
    }
    return EXIT.OK;
  } catch (err) {
    const code = err instanceof ConfigInvalidError ? EXIT.USAGE : EXIT.FAILURE;
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return code;
  }
}

interface ModelRow {
  provider: string;
  type: string;
  defaultModel: string;
  models: string[];
  keyConfigured: boolean;
  keySource: string;
  isDefault: boolean;
}

export async function executeModelsList(options: ModelsListOptions, ctx: RunContext): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  try {
    const loaded = loadConfig({ home: ctx.env.AGENTX_HOME, env: ctx.env });
    const rows: ModelRow[] = Object.entries(loaded.config.providers).map(([id, def]) => {
      const state = providerKeyState(def, loaded.env ?? ctx.env);
      return {
        provider: id,
        type: def.type,
        defaultModel: def.models[0] ?? "",
        models: def.models,
        keyConfigured: state.configured,
        keySource: state.source,
        isDefault: loaded.config.defaultModel === id || def.models.includes(loaded.config.defaultModel),
      };
    });
    if (json) {
      ctx.stdout.write(`${JSON.stringify(rows)}\n`);
      return EXIT.OK;
    }
    const headers = ["PROVIDER", "TYPE", "DEFAULT MODEL", "API KEY", "MODELS"];
    const data = rows.map((r) => [
      `${r.provider}${r.isDefault ? " *" : ""}`,
      r.type,
      r.defaultModel,
      r.keyConfigured ? stateLabel(r) : "missing",
      r.models.join(","),
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
    const fmt = (cells: string[]): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length))).join("  ").trimEnd();
    ctx.stdout.write(`${[fmt(headers), ...data.map(fmt)].join("\n")}\n`);
    ctx.stdout.write(`\ndefault model: ${loaded.config.defaultModel}\n* = matches the default model\n`);
    return EXIT.OK;
  } catch (err) {
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    return EXIT.FAILURE;
  }
}

function stateLabel(row: ModelRow): string {
  if (row.keySource === "not-required") return "not-required";
  return `configured (${row.keySource})`;
}

// ---------- doctor（M4 / AC11） ----------

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const MIN_NODE_MAJOR = 22;

function compareNodeVersion(current: string, minMajor: number): boolean {
  const major = Number.parseInt(current.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) && major >= minMajor;
}

/**
 * 本地环境自检（AC11）：八项检查，全部只读本地状态，**不发起任何网络请求**。
 * - a Node 版本 >= 22
 * - b 配置可解析（路径 + 来源）
 * - c home 可写（logs 下写探针文件再删除）
 * - d 数据库可迁移（<home>/data/agentx.sqlite，读 user_version）
 * - e 技能目录（数量 + warnings）
 * - f 工具注册数与 tools.allow 一致性
 * - g 默认 provider 的 API key 是否配置（只报 configured/missing，绝不打印值）
 * - h 日志目录与最近日志文件
 */
export async function executeDoctor(ctx: RunContext, options: DoctorOptions = {}): Promise<number> {
  const json = Boolean(options.json ?? inheritedOptions(ctx).json ?? false);
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  // a) Node 版本
  const nodeVersion = process.versions.node;
  if (compareNodeVersion(nodeVersion, MIN_NODE_MAJOR)) {
    add("node-version", "PASS", `node v${nodeVersion} (>= ${MIN_NODE_MAJOR})`);
  } else {
    add("node-version", "FAIL", `node v${nodeVersion} is too old (requires >= ${MIN_NODE_MAJOR})`);
  }

  // b) 配置可解析
  let config: Config | undefined;
  let home = path.resolve(ctx.env.AGENTX_HOME && ctx.env.AGENTX_HOME.trim() !== "" ? ctx.env.AGENTX_HOME : path.join(ctx.env.HOME ?? "", ".agentx"));
  let sources: string[] = [];
  // doctor 的 api-key 检查必须看到 .env 里的键，否则会误报 missing。
  let doctorEnv: NodeJS.ProcessEnv = ctx.env;
  const configPath = (h: string): string => path.join(h, "config.json");
  try {
    const loaded = loadConfig({ home: ctx.env.AGENTX_HOME, env: ctx.env });
    config = loaded.config;
    home = loaded.home;
    sources = loaded.sources;
    if (loaded.env) doctorEnv = loaded.env;
    for (const w of loaded.warnings ?? []) add("config", "WARN", w);
    const fileExists = existsSync(configPath(home));
    add(
      "config",
      "PASS",
      `${configPath(home)} ${fileExists ? "(present)" : "(absent, using defaults)"}; sources: ${sources.join(",")}`,
    );
  } catch (err) {
    add("config", "FAIL", `${configPath(home)}: ${(err as Error).message}`);
  }

  // c) home 可写
  let homeWritable = false;
  try {
    ensureHomeLayout(home);
    const probe = path.join(home, "logs", `.doctor-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    rmSync(probe, { force: true });
    homeWritable = true;
    add("home-writable", "PASS", `${home} is writable (probe file in logs/ created and removed)`);
  } catch (err) {
    add("home-writable", "FAIL", `${home} is not writable: ${(err as Error).message}`);
  }

  // d) 数据库可迁移
  const dbPath = path.join(home, "data", "agentx.sqlite");
  if (!homeWritable) {
    add("database", "WARN", `skipped: home ${home} is not writable (would use ${dbPath})`);
  } else {
    let db: SqliteDatabase | undefined;
    try {
      db = openDatabase(dbPath);
      const version = migrate(db);
      const row = db.prepare("PRAGMA user_version").get();
      const reported = Number(row?.["user_version"] ?? 0);
      add(
        "database",
        reported === version && version === SCHEMA_VERSION ? "PASS" : "WARN",
        `${dbPath}; user_version=${reported} (expected ${SCHEMA_VERSION})`,
      );
    } catch (err) {
      add("database", "FAIL", `${dbPath}: ${(err as Error).message}`);
    } finally {
      try {
        db?.close();
      } catch {
        // 已关闭 / 打开失败时忽略。
      }
    }
  }

  // e) 技能目录
  if (!config) {
    add("skills", "WARN", "skipped: configuration could not be loaded");
  } else {
    try {
      const cwd = path.resolve(config.cwd);
      const loader = createSkillLoader(config, cwd);
      const metas = await loader.discover();
      const warnings = loader.getWarnings();
      const dirs = loader.dirs.join(", ");
      const detail = `${metas.length} skill(s) from ${dirs}; ${warnings.length} warning(s)`;
      if (warnings.length > 0) {
        add("skills", "WARN", `${detail}: ${warnings.map((w) => `${w.file}: ${w.reason}`).join("; ")}`);
      } else {
        add("skills", metas.length > 0 ? "PASS" : "WARN", metas.length > 0 ? detail : `${detail} (no skills found)`);
      }
    } catch (err) {
      add("skills", "FAIL", `skill discovery failed: ${(err as Error).message}`);
    }
  }

  // f) 工具注册数与 allow 列表一致性
  if (!config) {
    add("tools", "WARN", "skipped: configuration could not be loaded");
  } else {
    try {
      const registered = createDefaultTools();
      const names = registered.map((t) => t.name);
      // memory_search 仅在 memory.enabled 且记忆目录可用时注册，属于允许的缺省差异。
      const allow = config.tools.allow;
      const allowNotRegistered = allow.filter((n) => !names.includes(n) && n !== "memory_search");
      const registeredNotAllowed = names.filter((n) => !allow.includes(n));
      const base = `${registered.length} tool(s) registered: ${names.join(", ")}; tools.allow has ${allow.length} entr(ies)`;
      // memory_search 只在提供记忆钩子时注册；不把它算作配置不一致，但要说明缺席原因。
      const optionalMissing = allow.filter((n) => !names.includes(n) && n === "memory_search");
      const hint =
        optionalMissing.length > 0
          ? `; ${optionalMissing.join(", ")} is optional and not registered (no memory hook configured)`
          : "";
      if (allowNotRegistered.length > 0) {
        add("tools", "WARN", `${base}; allow lists unregistered tool(s): ${allowNotRegistered.join(", ")}${hint}`);
      } else if (registeredNotAllowed.length > 0) {
        add("tools", "WARN", `${base}; registered but not in tools.allow: ${registeredNotAllowed.join(", ")}${hint}`);
      } else {
        add("tools", "PASS", `${base}${hint}`);
      }
    } catch (err) {
      add("tools", "FAIL", `tool registration failed: ${(err as Error).message}`);
    }
  }

  // g) 默认 provider 的 key（只报 configured / missing）
  if (!config) {
    add("api-key", "WARN", "skipped: configuration could not be loaded");
  } else {
    const matched = Object.entries(config.providers).find(
      ([id, def]) => id === config!.defaultModel || def.models.includes(config!.defaultModel),
    );
    if (!matched) {
      add("api-key", "FAIL", `defaultModel "${config.defaultModel}" does not match any configured provider`);
    } else {
      const [id, def] = matched;
      const state = providerKeyState(def, doctorEnv);
      add(
        "api-key",
        state.configured ? "PASS" : "WARN",
        `${id} (${def.type}) defaultModel=${config.defaultModel}: api key ${state.configured ? "configured" : "missing"} [${state.source}]`,
      );
    }
  }

  // h) 日志目录与最近日志文件
  try {
    const logsDir = path.join(home, "logs");
    const today = defaultLogFile(home);
    const files = existsSync(logsDir)
      ? readdirSync(logsDir)
          .filter((f) => f.endsWith(".log") || f.endsWith(".jsonl"))
          .map((f) => ({ name: f, mtime: statSync(path.join(logsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
      : [];
    const latest = files[0];
    if (!existsSync(logsDir)) {
      add("logs", "WARN", `${logsDir} does not exist`);
    } else if (!latest) {
      add("logs", "WARN", `${logsDir} is writable but has no log file yet (today's file would be ${today})`);
    } else {
      add(
        "logs",
        "PASS",
        `${logsDir}; ${files.length} file(s); latest ${latest.name} (${new Date(latest.mtime).toISOString()})`,
      );
    }
  } catch (err) {
    add("logs", "FAIL", `${path.join(home, "logs")}: ${(err as Error).message}`);
  }

  const ok = checks.every((c) => c.status !== "FAIL");
  if (json) {
    ctx.stdout.write(`${JSON.stringify({ ok, checks })}\n`);
  } else {
    const headers = ["CHECK", "STATUS", "DETAIL"];
    const data = checks.map((c) => [c.name, c.status, c.detail]);
    const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
    const fmt = (cells: string[]): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length))).join("  ").trimEnd();
    ctx.stdout.write(`${[fmt(headers), ...data.map(fmt)].join("\n")}\n`);
    const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.name);
    const warned = checks.filter((c) => c.status === "WARN").map((c) => c.name);
    ctx.stdout.write(
      `\n${ok ? "OK" : "FAILED"}: ${checks.length} checks, ${checks.length - failed.length - warned.length} pass, ${warned.length} warn, ${failed.length} fail\n`,
    );
    if (failed.length > 0) ctx.stdout.write(`failed: ${failed.join(", ")}\n`);
  }
  return ok ? EXIT.OK : EXIT.FAILURE;
}

/** 读取顶层 program 上的同名选项（commander 子命令 action 不会自动继承）。 */
function inheritedOptions(ctx: RunContext): { json?: boolean; verbose?: boolean } {
  const program = (ctx as { program?: Command }).program;
  if (!program) return {};
  const opts = program.opts<{ json?: boolean; verbose?: boolean }>();
  return { json: opts.json, verbose: opts.verbose };
}

function parseListOption(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function argvModel(argv: string[]): string | undefined {
  const idx = argv.indexOf("--model");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith("--model="));
  return inline ? inline.slice("--model=".length) : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const ctx: RunContext = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    interactive: Boolean(process.stdin.isTTY),
  };
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr.write(`${err.message.trim()}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }
    ctx.stderr.write(`agentx: ${(err as Error).message}\n`);
    process.exitCode = EXIT.FAILURE;
  }
}
