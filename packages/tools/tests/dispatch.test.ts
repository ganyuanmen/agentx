import { describe, expect, it } from "vitest";
import { createDispatchAgentTool, DISPATCH_DEPTH_ENV, DISPATCH_AUTO_APPROVE_ENV } from "../src/dispatch.js";
import type { ToolContext } from "@agentx/core";
import { createLogger } from "@agentx/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const logger = createLogger({ level: "error", stderr: false, file: undefined });

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: "task_test",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    readOnly: false,
    approved: false,
    logger,
    env: {},
    ...over,
  } as ToolContext;
}

/** 造一个假的 agentx CLI：按 fixture 决定输出与退出码。 */
function fakeBin(dir: string, spec: { stdout?: string; stderr?: string; exitCode?: number; sleepMs?: number }): string {
  const file = path.join(dir, "fake-agentx.mjs");
  const body = `
const spec = ${JSON.stringify(spec)};
if (spec.sleepMs) await new Promise((r) => setTimeout(r, spec.sleepMs));
if (spec.stdout) process.stdout.write(spec.stdout);
if (spec.stderr) process.stderr.write(spec.stderr);
process.exit(spec.exitCode ?? 0);
`;
  writeFileSync(file, body);
  return file;
}

describe("dispatch_agent (B)", () => {
  it("D0 is medium risk so orchestration does not demand per-call approval", async () => {
    // 回归背景：标成 high 时，approval="high" 的配置会让每次派发都弹 [y/N]，
    // 一轮多环协作弹出 6 次以上，用户被迫一路按 y —— 审批疲劳本身就是风险。
    const tool = createDispatchAgentTool({ env: {} });
    expect(tool.riskLevel).toBe("medium");
    // 但仍然是写操作，只读任务里必须被拒（见 D4）。
    expect(tool.readOnly).toBe(false);
  });

  it("D1 returns the child agent's final text on success", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, {
      stdout: JSON.stringify({
        status: "succeeded",
        terminationReason: "completed",
        finalText: "coder finished the forum",
        steps: 7,
      }) + "\n",
    });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const r = await tool.execute({ agent: "coder", prompt: "build it" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.content).toBe("coder finished the forum");
    expect((r.metadata as { agent: string }).agent).toBe("coder");
  });

  it("D2 surfaces the child's failure reason", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, {
      stdout: JSON.stringify({
        status: "failed",
        terminationReason: "policy_denied",
        errorCode: "POLICY_DENIED",
        errorSummary: 'tool "exec" is not in the allow list',
        finalText: "",
      }) + "\n",
    });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const r = await tool.execute({ agent: "coder", prompt: "build it" }, ctx());

    expect(r.ok).toBe(false);
    expect(r.error).toContain("policy_denied");
    expect(r.error).toContain("not in the allow list");
  });

  it("D8 relays the child's approval request instead of passing --yes", async () => {
    // 设计演进：子进程没有 TTY，早先靠给子进程加 --yes 让它能干活，等于把审批权
    // 静默下放。现在改成审批透传 —— 子进程的 [y/N] 沿 stderr 回来，由父进程决定：
    //   父进程 --yes -> 自动放行；父进程交互 -> 交给真实用户；都没有 -> 拒绝。
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = path.join(dir, "relaybin.mjs");
    // 假 CLI：先打一条审批提示，再等 stdin 的答案，最后把答案回显在 finalText 里。
    writeFileSync(
      bin,
      `process.stderr.write("\\nexec high 将执行：echo probe [y/N] ");
       let answered = "";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data", (d) => {
         if (answered) return;
         answered = d.trim();
         process.stdout.write(JSON.stringify({
           status: "succeeded",
           terminationReason: "completed",
           finalText: "child-approval-answer:" + answered,
         }) + "\\n");
         process.exit(0);
       });
      `,
    );

    // 父进程 --yes：子进程拿到 y
    const approved = createDispatchAgentTool({
      binPath: bin,
      env: { [DISPATCH_AUTO_APPROVE_ENV]: "1" },
    });
    const r1 = await approved.execute({ agent: "coder", prompt: "p" }, ctx());
    expect(r1.content).toContain("child-approval-answer:y");

    // 父进程未授权且没有审批器：子进程拿到 n（不静默提权）
    const denied = createDispatchAgentTool({ binPath: bin, env: {} });
    const r2 = await denied.execute({ agent: "coder", prompt: "p" }, ctx());
    expect(r2.content).toContain("child-approval-answer:n");
  });

  it("D8b asks the injected approver and honours its answer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = path.join(dir, "relaybin2.mjs");
    writeFileSync(
      bin,
      `process.stderr.write("\\nexec high 将执行：echo probe [y/N] ");
       process.stdin.setEncoding("utf8");
       process.stdin.on("data", (d) => {
         process.stdout.write(JSON.stringify({
           status: "succeeded", terminationReason: "completed",
           finalText: "answer:" + d.trim(),
         }) + "\\n");
         process.exit(0);
       });
      `,
    );

    const seen: string[] = [];
    const tool = createDispatchAgentTool({
      binPath: bin,
      env: {},
      // 未经 --yes 也能放行，但必须经过显式审批回调。
      approve: async (req) => {
        seen.push(req.toolName);
        return true;
      },
    });
    const r = await tool.execute({ agent: "coder", prompt: "p" }, ctx());
    expect(seen).toContain("exec");
    expect(r.content).toContain("answer:y");
  });

  it("D9 refuses nested dispatch (depth >= 1)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, { stdout: '{"status":"succeeded","finalText":"should not run"}\n' });
    const tool = createDispatchAgentTool({ binPath: bin, env: { [DISPATCH_DEPTH_ENV]: "1" } });
    const r = await tool.execute({ agent: "coder", prompt: "x" }, ctx());

    expect(r.ok).toBe(false);
    expect(r.error).toContain("DISPATCH_DEPTH_EXCEEDED");
  });

  it("D4 refuses in read-only tasks", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, { stdout: "{}" });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const r = await tool.execute({ agent: "coder", prompt: "x" }, ctx({ readOnly: true }));

    expect(r.ok).toBe(false);
    expect(r.error).toContain("READ_ONLY_VIOLATION");
  });

  it("D5 kills the child and reports TOOL_TIMEOUT", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, { stdout: '{"status":"succeeded"}\n', sleepMs: 5000 });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const started = Date.now();
    const r = await tool.execute({ agent: "coder", prompt: "x", timeoutMs: 300 }, ctx());
    const elapsed = Date.now() - started;

    expect(r.ok).toBe(false);
    expect(r.error).toContain("TOOL_TIMEOUT");
    // 必须真的提前结束，而不是等满 5s
    expect(elapsed).toBeLessThan(3000);
  });

  it("D6 reports a non-zero exit with stderr when no JSON is produced", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, { stderr: "error: unknown agent 'ghost'\n", exitCode: 2 });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const r = await tool.execute({ agent: "ghost", prompt: "x" }, ctx());

    expect(r.ok).toBe(false);
    expect(r.error).toContain("ghost");
  });

  it("D7 tolerates log noise before the JSON line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    const bin = fakeBin(dir, {
      stdout:
        '{"level":30,"msg":"task.start"}\n' +
        '{"status":"succeeded","terminationReason":"completed","finalText":"ok despite noise"}\n',
    });
    const tool = createDispatchAgentTool({ binPath: bin, env: {} });
    const r = await tool.execute({ agent: "coder", prompt: "x" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.content).toBe("ok despite noise");
  });
});
