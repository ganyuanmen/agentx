import { spawn } from "node:child_process";
import { z } from "zod";
import type { AgentTool, ToolResult } from "@agentx/core";
import { resolveInside } from "./paths.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/**
 * 允许透传给子进程的环境变量白名单（PM_SPEC §5.5）。
 * 即使某个键在白名单里，只要命中敏感模式也一律删除。
 */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "NODE_ENV",
  "PWD",
  "SHELL",
];

const SENSITIVE_ENV_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD|APIKEY)$/i;

/**
 * command 中不允许出现的 shell 元字符（E05）。
 * 出现即拒绝，提示改用 args 传参 —— 我们从不用 shell，这些字符只会带来误解与注入风险。
 */
const SHELL_METACHAR_RE = /[;&|`$()<>\n\r]/;

/** command 只能是「可执行文件名」或绝对/相对路径。 */
const COMMAND_ALLOWED_RE = /^[A-Za-z0-9_./+@-]+$/;

export function buildExecEnv(
  source: Record<string, string | undefined> = process.env,
  extraAllow: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set<string>([...ENV_ALLOWLIST, ...extraAllow]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) continue;
    if (SENSITIVE_ENV_RE.test(key)) continue; // 白名单也不豁免敏感键
    env[key] = value;
  }
  return env;
}

export const execInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export type ExecInput = z.infer<typeof execInputSchema>;

export interface ExecToolOptions {
  /** 缺省执行超时（毫秒）。 */
  timeoutMs?: number;
  /** stdout+stderr 合计上限。 */
  maxOutputBytes?: number;
  /** 额外允许透传的环境变量名（tools.exec.envAllow）。 */
  envAllow?: readonly string[];
  /** 环境变量来源，默认 process.env（测试可注入）。 */
  env?: Record<string, string | undefined>;
}

interface Captured {
  text: string;
  bytes: number;
  truncated: boolean;
}

export function createExecTool(options: ExecToolOptions = {}): AgentTool<ExecInput> {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const envAllow = options.envAllow ?? [];
  /** 工厂级兜底环境；单次调用时以 ctx.env 为准（它已由框架按白名单过滤）。 */
  const fallbackEnv = options.env ?? process.env;

  const tool: AgentTool<ExecInput> = {
    name: "exec",
    description:
      "Run a program without a shell. `command` is the executable and `args` is the argument " +
      "array (no shell expansion, no quoting needed). Shell metacharacters in `command` are " +
      "rejected; pass them as separate args instead. Runs inside the working directory unless " +
      "`cwd` is given. Returns stdout+stderr and metadata.exitCode.",
    inputSchema: execInputSchema,
    riskLevel: "high",
    readOnly: false,
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.readOnly) {
        return {
          ok: false,
          content: "",
          error: "READ_ONLY_VIOLATION: exec is not allowed in read-only mode",
        };
      }

      // 1) command 中禁止 shell 元字符（E05）
      const metaMatch = input.command.match(SHELL_METACHAR_RE);
      if (metaMatch) {
        return {
          ok: false,
          content: "",
          error:
            `INVALID_TOOL_ARGS: command contains shell metacharacter "${metaMatch[0]}". ` +
            "exec never uses a shell; pass the program name (e.g. \"node\") and put every " +
            "argument, including operators, into the `args` array.",
          metadata: { rejected: "shell_metacharacter", char: metaMatch[0] },
        };
      }

      // 2) command 只允许安全字符集（允许 /usr/bin/node 这类路径）
      if (!COMMAND_ALLOWED_RE.test(input.command)) {
        return {
          ok: false,
          content: "",
          error:
            `INVALID_TOOL_ARGS: command "${input.command}" contains unsupported characters. ` +
            "Use a plain executable name or path and pass arguments via `args`.",
          metadata: { rejected: "invalid_command" },
        };
      }

      // 3) 工作目录必须在 cwd 内
      let workdir: string;
      try {
        workdir = input.cwd ? resolveInside(ctx.cwd, input.cwd) : resolveInside(ctx.cwd, ".");
      } catch (err) {
        return {
          ok: false,
          content: "",
          error: err instanceof Error ? `${(err as { code?: string }).code ?? "PATH_ESCAPE"}: ${err.message}` : String(err),
        };
      }

      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const startedAt = Date.now();

      return await new Promise<ToolResult>((resolve) => {
        let settled = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let totalBytes = 0;
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        const child = spawn(input.command, input.args ?? [], {
          cwd: workdir,
          shell: false, // 绝不 shell:true
          detached: process.platform !== "win32", // 独立进程组，便于整组 kill
          stdio: ["ignore", "pipe", "pipe"],
          // 单次调用的 ctx.env 优先：它承载框架过滤后的环境；空对象时退回工厂级来源。
          env: buildExecEnv(
            Object.keys(ctx.env ?? {}).length > 0 ? (ctx.env as Record<string, string>) : fallbackEnv,
            envAllow,
          ),
        });

        const killTree = (): void => {
          const pid = child.pid;
          if (pid === undefined) return;
          if (process.platform === "win32") {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            return;
          }
          try {
            process.kill(-pid, "SIGKILL"); // 整个进程组
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        };

        const capture = (which: "out" | "err", chunk: Buffer): void => {
          const remaining = maxOutputBytes - totalBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
          if (chunk.byteLength > remaining) truncated = true;
          totalBytes += slice.byteLength;
          if (which === "out") {
            stdoutBytes += slice.byteLength;
            outChunks.push(slice);
          } else {
            stderrBytes += slice.byteLength;
            errChunks.push(slice);
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => capture("out", chunk));
        child.stderr?.on("data", (chunk: Buffer) => capture("err", chunk));

        const finish = (result: ToolResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const summarize = (): { out: string; err: string } => ({
          out: Buffer.concat(outChunks).toString("utf8"),
          err: Buffer.concat(errChunks).toString("utf8"),
        });

        const timer = setTimeout(() => {
          killTree();
          const { out, err } = summarize();
          const durationMs = Date.now() - startedAt;
          finish({
            ok: false,
            content: [out, err].filter((s) => s.length > 0).join("\n"),
            error: `TOOL_TIMEOUT: command "${input.command}" exceeded ${timeoutMs}ms and was killed`,
            metadata: {
              durationMs,
              bytes: totalBytes,
              truncated,
              timedOut: true,
              timeoutMs,
            },
          });
        }, timeoutMs);
        // 不要因为 timer 让进程悬停
        if (typeof timer === "object" && "unref" in timer) timer.unref();

        const onAbort = (): void => {
          killTree();
          const { out, err } = summarize();
          finish({
            ok: false,
            content: [out, err].filter((s) => s.length > 0).join("\n"),
            error: "CANCELLED: task aborted, child process killed",
            metadata: {
              durationMs: Date.now() - startedAt,
              bytes: totalBytes,
              truncated,
              cancelled: true,
            },
          });
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          finish({
            ok: false,
            content: "",
            error:
              code === "ENOENT"
                ? `TOOL_FAILED: executable not found: ${input.command}`
                : `TOOL_FAILED: ${err.message}`,
            metadata: { durationMs: Date.now() - startedAt, bytes: 0, truncated: false },
          });
        });

        child.on("close", (code, signal) => {
          const durationMs = Date.now() - startedAt;
          const { out, err } = summarize();
          const combined = [out, err].filter((s) => s.length > 0).join(out.length > 0 && err.length > 0 ? "\n" : "");
          const exitCode = code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : undefined);
          const ok = code === 0;
          finish({
            ok,
            content: combined,
            ...(ok
              ? {}
              : {
                  error: signal
                    ? `TOOL_FAILED: command terminated by signal ${signal}`
                    : `TOOL_FAILED: command exited with code ${code ?? "unknown"}`,
                }),
            metadata: {
              ...(exitCode !== undefined ? { exitCode } : {}),
              durationMs,
              bytes: totalBytes,
              truncated,
              stdoutBytes,
              stderrBytes,
              ...(truncated ? { maxOutputBytes } : {}),
              ...(signal ? { signal } : {}),
            },
          });
        });
      });
    },
  };

  return tool;
}

/** 缺省 exec 工具（30s / 100KB）。 */
export const execTool: AgentTool<ExecInput> = createExecTool();
