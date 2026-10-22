import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "packages", "cli", "bin", "agentx.js");

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<RunOut> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: ROOT, env: { ...process.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: number }).code === "number"
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout, stderr });
      },
    );
    // stdin 明确关闭，模拟非交互环境（不得挂起）
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

let home: string;

function script(scriptDir: string, body: unknown): string {
  const p = path.join(scriptDir, `s-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "agentx-sessions-"));
});

describe("sessions delete confirmation", () => {
  it("E22 refuses to delete without --yes in a non-interactive shell and exits 3", async () => {
    const env = { AGENTX_HOME: home, AGENTX_MOCK_SCRIPT: script(home, [{ type: "final", text: "ok" }]) };

    const created = await run(["run", "seed", "--model", "mock", "--session", "keepme"], env);
    expect(created.code).toBe(0);

    const del = await run(["sessions", "delete", "keepme"], env);
    expect(del.code).toBe(3);
    expect(del.stderr).toMatch(/refus|confirm|approval/i);

    // 会话必须仍然存在
    const list = await run(["sessions", "list", "--json"], env);
    expect(list.stdout).toContain("keepme");
  });

  it("E22 deletes the session when --yes is passed", async () => {
    const env = { AGENTX_HOME: home, AGENTX_MOCK_SCRIPT: script(home, [{ type: "final", text: "ok" }]) };

    await run(["run", "seed", "--model", "mock", "--session", "dropme"], env);
    const del = await run(["sessions", "delete", "dropme", "--yes"], env);
    expect(del.code).toBe(0);

    const list = await run(["sessions", "list", "--json"], env);
    expect(list.stdout).not.toContain("dropme");
  });

  it("AC7 session transcript stores each user message exactly once", async () => {
    const env = {
      AGENTX_HOME: mkdtempSync(path.join(tmpdir(), "agentx-sess-dup-")),
      AGENTX_MOCK_SCRIPT: script(home, [{ type: "final", text: "answer" }]),
    };

    await run(["run", "unique prompt text", "--model", "mock", "--session", "dupcheck"], env);
    const show = await run(["sessions", "show", "dupcheck", "--json"], env);

    const payload = JSON.parse(show.stdout) as {
      messageCount: number;
      messages: Array<{ role: string; content: string }>;
    };
    // 同一句话会出现在会话标题里，所以只统计消息流中的用户消息
    const userMessages = payload.messages.filter(
      (m) => m.role === "user" && m.content === "unique prompt text",
    );
    expect(userMessages).toHaveLength(1);
    expect(payload.messageCount).toBe(payload.messages.length);
  });
});
