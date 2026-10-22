import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createLogger } from "@agentx/core";
import { createDefaultTools } from "../src/index.js";

const logger = createLogger({ level: "error", stderr: false });

function ctx(signal?: AbortSignal) {
  return {
    taskId: "kill-test",
    cwd: mkdtempSync(path.join(tmpdir(), "agentx-kill-")),
    signal: signal ?? new AbortController().signal,
    readOnly: false,
    approved: false,
    logger,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL 是异步生效的，必须等一小段时间再断言进程已消失，否则会误报泄漏。 */
async function waitForDeath(pid: number, budgetMs = 2000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

describe("exec process cleanup (E07)", () => {
  it("E07 kills the child process on timeout and leaves no orphan behind", async () => {
    const exec = createDefaultTools({ execTimeoutMs: 400 }).find((t) => t.name === "exec")!;
    const r = await exec.execute(
      { command: process.execPath, args: ["-e", "process.stdout.write(String(process.pid)); setTimeout(()=>{},60000)"] },
      ctx(),
    );

    expect(r.ok).toBe(false);
    expect(r.metadata?.timedOut).toBe(true);

    const pid = Number(r.content.trim());
    expect(Number.isFinite(pid) && pid > 0).toBe(true);
    expect(await waitForDeath(pid)).toBe(true);
  });

  it("kills the child when the task signal is aborted", async () => {
    const exec = createDefaultTools({ execTimeoutMs: 30000 }).find((t) => t.name === "exec")!;
    const controller = new AbortController();
    const pending = exec.execute(
      { command: process.execPath, args: ["-e", "process.stdout.write(String(process.pid)); setTimeout(()=>{},60000)"] },
      ctx(controller.signal),
    );
    setTimeout(() => controller.abort(), 200);

    const r = await pending;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/CANCELLED|abort/i);

    const pid = Number(r.content.trim());
    if (Number.isFinite(pid) && pid > 0) {
      expect(await waitForDeath(pid)).toBe(true);
    }
  });
});
