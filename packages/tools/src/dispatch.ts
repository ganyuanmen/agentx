/**
 * dispatch_agent：让一个 agent 在一次任务内真实调用另一个 agent。
 *
 * 为什么需要它：agentx 的每个 `agentx agent run/chat <name>` 是独立进程、独立会话，
 * 默认工具里没有任何一个能触达另一个 agent。于是像 PM 这种"职责是派发"的角色，
 * 只能把派发指令打印出来让用户手工转发——流程断在人工环节。
 *
 * 为什么不能用 exec 代替：
 *   1) `buildExecEnv` 会把 `DEEPSEEK_API_KEY`（匹配 `_KEY$`）和 `AGENTX_HOME` 丢掉，
 *      子进程拿不到凭据；
 *   2) exec 的默认超时是 30s，而真实模型跑一轮 agent 要几十秒到几分钟。
 * 所以这里直接 spawn，环境变量由我们自己控制。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool, ToolResult } from "@agentx/core";

/** 默认派发超时：一个 agent 跑完一轮通常要 1~3 分钟，给足余量。 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
/** 单次派发允许的最大超时。 */
export const MAX_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 递归深度环境变量。父进程若已带该值（>=1），说明自己就是被派发出来的，
 * 此时再派发会造成 A→B→A 的进程爆炸，直接拒绝。
 */
export const DISPATCH_DEPTH_ENV = "AGENTX_DISPATCH_DEPTH";

/**
 * 父进程处于 `--yes`（自动放行）时置为 "1"。
 * dispatch_agent 据此决定要不要把同样的授权传给子进程 —— 子进程没有 TTY，
 * 拿不到交互审批，不继承这份授权的话它的 exec 必然 APPROVAL_REQUIRED 失败。
 */
export const DISPATCH_AUTO_APPROVE_ENV = "AGENTX_DISPATCH_AUTO_APPROVE";

/**
 * 标记本进程是 dispatch_agent 起的子 agent。
 * 子 agent 没有 TTY，CLI 若只按 `process.stdin.isTTY` 判定 interactive，
 * 就会把审批器关掉，导致它的 exec 永远 APPROVAL_REQUIRED 失败。
 * 置位后子 agent 会启用交互审批，审批请求经 stderr 送到父进程、
 * 答案由父进程写回 stdin。
 */
export const DISPATCH_CHILD_ENV = "AGENTX_DISPATCH_CHILD";

/**
 * 子 agent 审批提示的形状（见 policy.ts 的 summarizeToolCall）：
 *   `\nexec high 将执行：echo child-exec-ok [y/N] `
 * 第一个捕获组是工具名，第二个是摘要。ANSI 颜色码可能夹在中间，先剥离。
 */
const APPROVAL_PROMPT_RE = /([a-z_][a-z0-9_]*)\s+\w+\s+将执行：([^\r\n]*?)\[y\/N\]/i;

export const dispatchInputSchema = z.object({
  /** 目标 agent 名（agentx agent 目录名）。 */
  agent: z.string().min(1),
  /** 交给该 agent 的任务描述。 */
  prompt: z.string().min(1),
  /** 子 agent 的工作目录；缺省沿用父任务 cwd。 */
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_DISPATCH_TIMEOUT_MS).optional(),
});

export type DispatchInput = z.infer<typeof dispatchInputSchema>;

export interface DispatchToolOptions {
  /** 覆盖默认超时。 */
  timeoutMs?: number;
  /** 子进程输出上限（stdout+stderr 合计）。 */
  maxOutputBytes?: number;
  /** 环境变量来源，默认 process.env（测试可注入）。 */
  env?: Record<string, string | undefined>;
  /**
   * 定位 bin/agentx.js 的方式，默认按本模块位置向上找。
   * 测试可注入一个假脚本以避免真的起模型调用。
   */
  binPath?: string;
  /**
   * 子 agent 的审批回调：子进程发出 `[y/N]` 时由它决定放行与否。
   * 由 CLI 注入父 agent 的审批器，使审批请求能沿管道转回真实的用户面前。
   * 未注入且父进程带 --yes 时退化为自动放行；两者都没有则子 agent
   * 会收到 n，从而以 APPROVAL_REQUIRED 失败（不静默提权）。
   */
  approve?: (req: { toolName: string; summary: string }) => Promise<boolean>;
}

interface AgentRunJson {
  status?: string;
  terminationReason?: string;
  finalText?: string;
  errorCode?: string;
  errorSummary?: string;
}

/** 从 dist/ 或 src/ 出发找 packages/cli/bin/agentx.js。 */
function defaultBinPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/tools/dist/dispatch.js -> packages/tools -> packages -> repo root
  const repoRoot = path.resolve(here, "..", "..", "..");
  return path.join(repoRoot, "packages", "cli", "bin", "agentx.js");
}

function depthOf(env: Record<string, string | undefined>): number {
  const raw = env[DISPATCH_DEPTH_ENV];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function createDispatchAgentTool(options: DispatchToolOptions = {}): AgentTool<DispatchInput> {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? 100_000;
  const sourceEnv = options.env ?? process.env;
  const binPath = options.binPath ?? defaultBinPath();
  /** 父进程是否已被授权自动放行（`--yes`）。 */
  const autoApprove = sourceEnv[DISPATCH_AUTO_APPROVE_ENV] === "1";
  /**
   * 实际用于子 agent 审批的决策函数。
   * 显式注入的 approve 优先；否则按父进程是否 --yes 退化。
   * 两者都没有时返回 false —— 子 agent 会以 APPROVAL_REQUIRED 失败，绝不静默放行。
   */
  const approveChild = async (req: { toolName: string; summary: string }): Promise<boolean> => {
    if (options.approve) return options.approve(req);
    return autoApprove;
  };

  const tool: AgentTool<DispatchInput> = {
    name: "dispatch_agent",
    description:
      "Run another named agent (e.g. coder, tester, auditor) on a task and return its final " +
      "answer. Use this to hand work off inside one task instead of asking the user to relay " +
      "messages. The child agent runs in its own process with its own session and tools. " +
      "Returns the child's status, termination reason and final text.",
    inputSchema: dispatchInputSchema,
    // 编排级操作：派发本身不直接改动文件系统，真正的写操作发生在子 agent 内部，
    // 由子 agent 自己的策略/审批把关。标成 high 会让每次派发都弹 [y/N]，
    // 一轮多环协作能弹出十几次，把审批疲劳变成实际风险。
    riskLevel: "medium",
    readOnly: false,
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.readOnly) {
        return {
          ok: false,
          content: "",
          error: "READ_ONLY_VIOLATION: dispatch_agent is not allowed in read-only mode",
        };
      }

      // 防递归：被派发出来的进程不再允许派发。
      const depth = depthOf(sourceEnv);
      if (depth >= 1) {
        return {
          ok: false,
          content: "",
          error:
            `DISPATCH_DEPTH_EXCEEDED: this agent is already running inside a dispatched task ` +
            `(${DISPATCH_DEPTH_ENV}=${depth}). Nested dispatch is disabled to avoid ` +
            `runaway agent-to-agent recursion.`,
          metadata: { rejected: "dispatch_depth", depth },
        };
      }

      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const cwd = input.cwd ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;

      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(sourceEnv)) {
        if (v !== undefined) childEnv[k] = v;
      }
      childEnv[DISPATCH_DEPTH_ENV] = String(depth + 1);
      // 只有在父进程确实能给出审批决定时，才让子 agent 进入交互审批模式；
      // 否则它会一直等一个永远不会来的 y/n（实测表现为子进程卡在启动后不动，
      // 直到 10 分钟超时）。无审批器时不设该变量，子 agent 会直接以
      // APPROVAL_REQUIRED 失败，把问题立刻暴露出来。
      if (options.approve || autoApprove) childEnv[DISPATCH_CHILD_ENV] = "1";
      // 子进程沿用父进程的 AGENTX_HOME（上面已整体继承），确保读到同一份
      // .env / agents / memory。父进程没设时留空，子进程会自行回退到 ~/.agentx。

      const args = [binPath, "agent", "run", input.agent, input.prompt, "--json"];

      // 子进程没有 TTY，靠自己拿不到交互审批。这里不把 --yes 传给子进程，
      // 而是让它的审批请求透传回本进程（runChild 的 approve 回调）：
      //   - 父进程 --yes        -> 回调恒 true，等价于放行
      //   - 父进程交互且有审批器 -> 弹到真实用户面前
      //   - 两者都没有          -> 回调返回 false，子 agent 以 APPROVAL_REQUIRED 失败
      // 这样审批权始终留在父进程手里，不会因为派发而静默提权。

      const startedMs = Date.now();
      const outcome = await runChild(args, {
        cwd,
        env: childEnv,
        timeoutMs,
        maxOutputBytes,
        approve: approveChild,
      });

      if (outcome.timedOut) {
        return {
          ok: false,
          content: outcome.stdout,
          error: `TOOL_TIMEOUT: dispatch_agent did not finish within ${timeoutMs}ms (agent "${input.agent}")`,
          metadata: { agent: input.agent, timedOut: true, durationMs: Date.now() - startedMs },
        };
      }

      const parsed = parseJsonLine(outcome.stdout);

      if (outcome.exitCode !== 0 || !parsed || parsed.status !== "succeeded") {
        // 同时给出「为什么停」（terminationReason/errorCode）和「具体原因」（errorSummary），
        // 只给其中一个都会让上层难以判断该重试、改配置还是改代码。
        const reason = parsed
          ? `${parsed.status ?? "unknown"} (${parsed.terminationReason ?? "?"}${
              parsed.errorCode ? `, ${parsed.errorCode}` : ""
            })`
          : undefined;
        const detail = parsed?.errorSummary ?? (outcome.stderr.trim() || "no output");
        const message = reason ? `${reason}: ${detail}` : detail;
        return {
          ok: false,
          content: parsed?.finalText ?? "",
          error: `dispatch_agent failed for "${input.agent}": ${message}`,
          metadata: {
            agent: input.agent,
            exitCode: outcome.exitCode,
            terminationReason: parsed?.terminationReason,
            errorCode: parsed?.errorCode,
            durationMs: Date.now() - startedMs,
          },
        };
      }

      return {
        ok: true,
        content: parsed.finalText ?? "",
        metadata: {
          agent: input.agent,
          exitCode: outcome.exitCode,
          steps: (parsed as { steps?: number }).steps,
          durationMs: Date.now() - startedMs,
          truncated: outcome.truncated,
        },
      };
    },
  };

  return tool;
}

interface ChildOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function runChild(
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    /** 父 agent 的审批器；子 agent 的审批请求会被转给它。 */
    approve?: (req: { toolName: string; summary: string }) => Promise<boolean>;
  },
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    timer.unref?.();

    const append = (target: "out" | "err", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      if (target === "out") stdout += text;
      else {
        stderr += text;
        // 子 agent 的审批提示：转给父 agent 的审批器，答案写回子进程 stdin。
        maybeRelayApproval(text);
      }
    };

    /**
     * 子 agent 的审批请求透传。
     *
     * 子进程没有 TTY，它的审批提示出现在自己的 stderr 上；父进程把它当成
     * "另一个 agent 要执行某个工具" 转给上层审批器，拿到 y/n 后写回子进程 stdin。
     * 一次派发可能多次触发（多个工具调用），用 pending 防止并发重入。
     */
    let pending = false;
    const maybeRelayApproval = (text: string): void => {
      if (!opts.approve) return;
      if (pending) return;
      const match = APPROVAL_PROMPT_RE.exec(text);
      if (!match) return;
      pending = true;
      const toolName = match[1] ?? "tool";
      const summary = (match[2] ?? "").trim();
      void opts
        .approve({ toolName, summary })
        .then((ok) => {
          child.stdin?.write(ok ? "y\n" : "n\n");
        })
        .catch(() => {
          child.stdin?.write("n\n");
        })
        .finally(() => {
          pending = false;
        });
    };

    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));

    const done = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    };

    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err.message}`;
      done(-1);
    });
    child.on("close", (code) => done(code ?? -1));
  });
}

/** --json 会输出一行 JSON；允许子进程日志混入，取最后一个可解析的行。 */
function parseJsonLine(stdout: string): AgentRunJson | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as AgentRunJson;
    } catch {
      // 继续往前找
    }
  }
  return undefined;
}
