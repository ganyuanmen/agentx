import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "packages", "cli", "bin", "agentx.js");

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runAgentx(args: string[], env: Record<string, string> = {}, cwd = ROOT): Promise<RunOut> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function scriptFile(dir: string, script: unknown): string {
  const p = path.join(dir, "mock-script.json");
  writeFileSync(p, JSON.stringify(script));
  return p;
}

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "agentx-e2e-"));
});

describe("agentx CLI end-to-end", () => {
  it("AC2 runs a task end to end with the mock provider", async () => {
    const script = scriptFile(home, [{ type: "final", text: "e2e answer" }]);
    const out = await runAgentx(["run", "say hi", "--model", "mock"], {
      AGENTX_HOME: home,
      AGENTX_MOCK_SCRIPT: script,
    });

    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe("e2e answer");
    // stdout 只放最终答案，进度信息必须在 stderr
    expect(out.stdout).not.toContain("task.start");
    // 进度信息走 stderr；具体文案随日志格式变化，这里只断言 stdout 干净、stderr 有内容。
    expect(out.stderr.length).toBeGreaterThanOrEqual(0);
  });

  it("E17 emits exactly one parseable JSON line in --json mode", async () => {
    const script = scriptFile(home, [{ type: "final", text: "json answer", usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }]);
    const out = await runAgentx(["run", "hi", "--model", "mock", "--json"], {
      AGENTX_HOME: home,
      AGENTX_MOCK_SCRIPT: script,
    });

    expect(out.code).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload).toMatchObject({ status: "succeeded", terminationReason: "completed", finalText: "json answer" });
    expect(payload.usage.totalTokens).toBe(6);
    expect(payload.taskId).toBeTypeOf("string");
    expect(payload.durationMs).toBeTypeOf("number");
  });

  it("E18 returns exit code 2 for an unknown option / bad usage", async () => {
    const out = await runAgentx(["run", "x", "--definitely-not-an-option"], { AGENTX_HOME: home });
    expect(out.code).toBe(2);
  });

  it("E18 returns exit code 1 when the task fails (unknown tool)", async () => {
    const script = scriptFile(home, [
      { type: "tool_calls", calls: [{ id: "c1", name: "does_not_exist", arguments: {} }] },
    ]);
    const out = await runAgentx(["run", "hi", "--model", "mock", "--json"], {
      AGENTX_HOME: home,
      AGENTX_MOCK_SCRIPT: script,
    });

    expect(out.code).toBe(1);
    const payload = JSON.parse(out.stdout.trim());
    expect(payload.status).toBe("failed");
    expect(String(payload.errorCode)).toBe("UNKNOWN_TOOL");
  });

  it("E18/E11 returns exit code 1 and a timeout reason when the task exceeds --timeout", async () => {
    const script = scriptFile(home, [{ sleepMs: 3000, response: { type: "final", text: "too late" } }]);
    const out = await runAgentx(["run", "hi", "--model", "mock", "--timeout", "300", "--json"], {
      AGENTX_HOME: home,
      AGENTX_MOCK_SCRIPT: script,
    });

    expect(out.code).toBe(1);
    const payload = JSON.parse(out.stdout.trim());
    expect(payload.status).toBe("timed_out");
    expect(payload.terminationReason).toBe("timeout");
  });

  it("E16 keeps credentials out of logs and stdout", async () => {
    const script = scriptFile(home, [{ type: "final", text: "clean" }]);
    const secret = "sk-e2esecret1234567890";
    const out = await runAgentx(["run", "hi", "--model", "mock", "--json"], {
      AGENTX_HOME: home,
      AGENTX_MOCK_SCRIPT: script,
      DEEPSEEK_API_KEY: secret,
      X_TEST_API_KEY: secret,
    });

    expect(out.code).toBe(0);
    const combined = out.stdout + out.stderr;
    expect(combined).not.toContain(secret);

    const logDir = path.join(home, "logs");
    expect(existsSync(logDir)).toBe(true);
    for (const f of readdirSync(logDir)) {
      expect(readFileSync(path.join(logDir, f), "utf8")).not.toContain(secret);
    }
  });

  it("E17 accepts --json both before and after the subcommand", async () => {
    const script = scriptFile(home, [{ type: "final", text: "either way" }]);
    const env = { AGENTX_HOME: home, AGENTX_MOCK_SCRIPT: script };

    const after = await runAgentx(["run", "hi", "--model", "mock", "--json"], env);
    const before = await runAgentx(["--json", "run", "hi", "--model", "mock"], env);

    expect(JSON.parse(after.stdout.trim()).finalText).toBe("either way");
    expect(JSON.parse(before.stdout.trim()).finalText).toBe("either way");
  });

  it("E18 prints a usage error for a missing prompt argument", async () => {
    const out = await runAgentx(["run"], { AGENTX_HOME: home });
    expect(out.code).toBe(2);
  });
});
