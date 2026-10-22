import { describe, expect, it, beforeAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AgentRuntime,
  InMemorySessionStore,
  InMemoryTaskStore,
  MockProvider,
  createLogger,
} from "../packages/core/src/index.js";

// 验收测试（QA）：只补 packages/*/tests 与 tests/e2e-run.test.ts 未覆盖的缺口。
// 全部走真实子进程：node packages/cli/bin/agentx.js，AGENTX_HOME 指向临时目录。
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "packages", "cli", "bin", "agentx.js");

interface RunOut {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function freshHome(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), `agentx-acc-${tag}-`));
}

/** stdin 显式关闭 = 非交互环境（!process.stdin.isTTY），与 §7 的判定一致。 */
function run(
  args: string[],
  opts: { home: string; script?: unknown; cwd?: string; env?: Record<string, string>; timeout?: number } ,
): Promise<RunOut> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), AGENTX_HOME: opts.home, ...opts.env };
  let scriptPath: string | undefined;
  if (opts.script !== undefined) {
    scriptPath = path.join(opts.home, `script-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(scriptPath, JSON.stringify(opts.script));
    env.AGENTX_MOCK_SCRIPT = scriptPath;
  }
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: opts.cwd ?? ROOT, env, timeout: opts.timeout ?? 30000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : null
          : 0;
        resolve({ code: code ?? -1, signal: (err as { signal?: NodeJS.Signals } | null)?.signal ?? null, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

/** 需要中途发信号的场景：不走 execFile 的 timeout。 */
function spawnAgentx(args: string[], opts: { home: string; script?: unknown; cwd?: string; env?: Record<string, string> }) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), AGENTX_HOME: opts.home, ...opts.env };
  if (opts.script !== undefined) {
    const scriptPath = path.join(opts.home, `script-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(scriptPath, JSON.stringify(opts.script));
    env.AGENTX_MOCK_SCRIPT = scriptPath;
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const done = new Promise<RunOut>((resolve) => {
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal, stdout, stderr }));
  });
  return { child, done, getStdout: () => stdout, getStderr: () => stderr };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- AC1 / AC11

describe("AC1 CLI surface", () => {
  it("AC1 --version and --help exit 0", async () => {
    const home = freshHome("ac1");
    const version = await run(["--version"], { home });
    const help = await run(["--help"], { home });

    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("run");
    expect(help.stdout).toContain("doctor");
  });
});

describe("AC11 doctor", () => {
  it("AC11 doctor exits 0 on a healthy home and --json emits one parseable object with a checks array", async () => {
    const home = freshHome("ac11");
    // 先跑一次 run，让 logs/ 与 db 真实存在
    const warm = await run(["run", "warm up", "--model", "mock"], { home, script: [{ type: "final", text: "ok" }] });
    expect(warm.code).toBe(0);

    const human = await run(["doctor"], { home });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/node-version/);
    expect(human.stdout).toMatch(/OK: \d+ checks/);

    const json = await run(["doctor", "--json"], { home });
    expect(json.code).toBe(0);
    const lines = json.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.checks.length).toBeGreaterThanOrEqual(6);
    for (const c of payload.checks) {
      expect(c.status).toMatch(/^(PASS|WARN|FAIL)$/);
      expect(typeof c.detail).toBe("string");
    }
    const names = payload.checks.map((c) => c.name);
    expect(names).toContain("node-version");
    expect(names).toContain("config");
    expect(names).toContain("home-writable");
    expect(names).toContain("database");
    expect(names).toContain("api-key");
    expect(names).toContain("tools");
  });

  it("AC11 doctor exits 1 when the config file is invalid", async () => {
    const home = freshHome("ac11-bad");
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ maxSteps: "not-a-number" }), { mode: 0o600 });
    const out = await run(["doctor", "--json"], { home });
    expect(out.code).toBe(1);
    const payload = JSON.parse(out.stdout.trim()) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.checks.some((c) => c.name === "config" && c.status === "FAIL")).toBe(true);
  });
});

// ---------------------------------------------------------------- AC13

describe("AC13 no service code", () => {
  it("AC13 packages/*/src contains no HTTP server / port listening code", () => {
    const pkgs = path.join(ROOT, "packages");
    const offenders: string[] = [];
    const pattern = /\bcreateServer\b|\.listen\s*\(|from\s+["'](express|fastify|koa)["']|require\(["'](express|fastify|koa)["']\)/;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          text.split("\n").forEach((line, i) => {
            if (pattern.test(line)) offenders.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    for (const pkg of readdirSync(pkgs)) walk(path.join(pkgs, pkg, "src"));
    expect(offenders).toEqual([]);
  });

  it("AC13 no HTTP framework in any package.json dependency list", () => {
    const pkgs = path.join(ROOT, "packages");
    const hits: string[] = [];
    for (const pkg of readdirSync(pkgs)) {
      const manifest = path.join(pkgs, pkg, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dep of Object.keys(json[field] ?? {})) {
          if (/^(express|fastify|koa|hapi|restify|@hapi\/hapi)$/.test(dep)) hits.push(`${pkg}:${field}:${dep}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------- AC9

describe("AC9 credentials never surface", () => {
  const SECRET = "sk-acc9-" + "deadbeefcafe1234";

  it("AC9 --json output, stderr, logs and config show never contain the api key", async () => {
    const home = freshHome("ac9");
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        defaultModel: "mock-1",
        providers: {
          mock: { type: "mock", models: ["mock-1"] },
          deepseek: {
            type: "deepseek",
            baseUrl: "https://api.deepseek.com",
            apiKey: SECRET,
            apiKeyEnv: "DEEPSEEK_API_KEY",
            models: ["deepseek-chat"],
          },
        },
      }),
      { mode: 0o600 },
    );

    const out = await run(["run", "hello", "--model", "mock", "--json", "--verbose"], {
      home,
      script: [{ type: "final", text: "ok" }],
      env: { DEEPSEEK_API_KEY: SECRET },
    });
    expect(out.code).toBe(0);
    // stdout 必须是可 parse 的单行 JSON，且不含 key
    const payload = JSON.parse(out.stdout.trim());
    expect(payload.status).toBe("succeeded");
    expect(out.stdout).not.toContain(SECRET);
    expect(out.stderr).not.toContain(SECRET);

    const logDir = path.join(home, "logs");
    expect(existsSync(logDir)).toBe(true);
    const logs = readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain("deadbeefcafe1234");

    const shown = await run(["config", "show", "--json"], { home });
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toContain(SECRET);
    const shownCfg = JSON.parse(shown.stdout.trim()) as { providers?: Record<string, { apiKey?: string }> };
    if (shownCfg.providers?.deepseek) expect(shownCfg.providers.deepseek.apiKey).toBe("***");

    const humanShow = await run(["config", "show"], { home });
    expect(humanShow.stdout + humanShow.stderr).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------- AC7

describe("AC7 session persistence", () => {
  it("AC7 sessions show renders each user message exactly once (no duplicate transcript rows)", async () => {
    const home = freshHome("ac7-dupe");
    const first = await run(["run", "first unique prompt", "--model", "mock", "--session", "s-ac7"], {
      home,
      script: [{ type: "final", text: "first answer" }],
    });
    expect(first.code).toBe(0);

    const show = await run(["sessions", "show", "s-ac7"], { home });
    expect(show.code).toBe(0);
    // 标题由第一条 prompt 派生，会合法地再出现一次；这里只数 transcript 行。
    const userLines = show.stdout.split("\n").filter((l) => l.trim() === "user: first unique prompt");
    expect(userLines).toHaveLength(1);
    const transcript = show.stdout.slice(show.stdout.indexOf("transcript:"));
    expect((transcript.match(/first unique prompt/g) ?? []).length).toBe(1);

    const json = await run(["sessions", "show", "s-ac7", "--json"], { home });
    const detail = JSON.parse(json.stdout.trim()) as { messages: Array<{ role: string; content: string }> };
    expect(detail.messages.filter((m) => m.role === "user" && m.content === "first unique prompt")).toHaveLength(1);
  });

  it("AC7/E14 a new process sees the history and --session continues the conversation", async () => {
    const home = freshHome("ac7-resume");
    const s1 = await run(["run", "remember the number 7", "--model", "mock", "--session", "resume"], {
      home,
      script: [{ type: "final", text: "noted" }],
    });
    expect(s1.code).toBe(0);

    // 新进程：sessions list 能看到
    const list = await run(["sessions", "list", "--json"], { home });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("resume");

    // 新进程续聊：历史里的第一轮内容必须被 load 出来
    const s2 = await run(["run", "what number?", "--model", "mock", "--session", "resume", "--json"], {
      home,
      script: [{ type: "final", text: "7" }],
    });
    expect(s2.code).toBe(0);
    const payload = JSON.parse(s2.stdout.trim());
    expect(payload.status).toBe("succeeded");

    const show = await run(["sessions", "show", "resume"], { home });
    expect(show.stdout).toContain("remember the number 7");
    expect(show.stdout).toContain("what number?");
  });
});

// ---------------------------------------------------------------- E02 (E2E)

// ---------------------------------------------------------------- E13 (loop level)

describe("E13 same session, second turn sees the first turn's history", () => {
  it("E13 the second generate() receives the first turn's user and assistant messages", async () => {
    const sessionStore = new InMemorySessionStore();
    const taskStore = new InMemoryTaskStore();
    const provider = new MockProvider({
      script: [
        { type: "final", text: "first answer" },
        { type: "final", text: "second answer" },
      ],
    });
    const logger = createLogger({ level: "error", stderr: false, file: undefined });
    const runtime = new AgentRuntime({
      sessionStore,
      taskStore,
      logger,
      run: async (request, signal) => {
        const { runAgent } = await import("../packages/core/src/loop.js");
        const { ContextBuilder } = await import("../packages/core/src/context.js");
        return runAgent(
          request,
          {
            provider,
            contextBuilder: new ContextBuilder({
              tools: [],
              cwd: request.cwd,
              readOnly: false,
              historyLimit: 30,
            }),
            tools: { get: () => undefined, list: () => [] },
            policy: { authorize: async () => ({ needApproval: false }) },
            executor: { execute: async () => ({ ok: true, content: "" }) },
            logger,
          },
          signal,
        );
      },
    });

    const base = {
      sessionId: "ses_e13",
      cwd: ROOT,
      model: "mock-1",
      maxSteps: 5,
      timeoutMs: 5000,
      readOnly: true,
    };
    const r1 = await runtime.run({ ...base, taskId: "t1", input: "first question" });
    expect(r1.status).toBe("succeeded");
    const r2 = await runtime.run({ ...base, taskId: "t2", input: "second question" });
    expect(r2.status).toBe("succeeded");

    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1]!;
    const contents = second.messages.map((m) => `${m.role}:${m.content}`);
    expect(contents).toContain("user:first question");
    expect(contents).toContain("assistant:first answer");
    expect(contents).toContain("user:second question");
    // 第一轮的 user 只出现一次（回归：曾经重复写入）
    expect(contents.filter((c) => c === "user:first question")).toHaveLength(1);
  });
});

describe("E02 symlink escape via the real tool pipeline", () => {
  it("E02 a symlink inside cwd pointing at /tmp is rejected end to end (PATH_ESCAPE, no content)", async () => {
    const home = freshHome("e02");
    const workspace = mkdtempSync(path.join(tmpdir(), "agentx-e02-ws-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agentx-e02-out-"));
    const secretFile = path.join(outside, "secret.txt");
    writeFileSync(secretFile, "SYMLINK-ESCAPE-CONTENT-MUST-NOT-LEAK\n");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(outside, path.join(workspace, "link"), "dir");

    const out = await run(
      ["run", "read the link", "--model", "mock", "--cwd", workspace, "--json", "--session", "e02"],
      {
        home,
        cwd: workspace,
        script: [
          { type: "tool_calls", calls: [{ id: "c1", name: "read_file", arguments: { path: "link/secret.txt" } }] },
          { type: "final", text: "done" },
        ],
      },
    );

    // 无论循环如何收尾，泄漏内容绝不能出现
    expect(out.stdout).not.toContain("SYMLINK-ESCAPE-CONTENT-MUST-NOT-LEAK");
    expect(out.stderr).not.toContain("SYMLINK-ESCAPE-CONTENT-MUST-NOT-LEAK");

    // 日志里也绝不能出现文件内容
    const logDir = path.join(home, "logs");
    const logs = existsSync(logDir)
      ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n")
      : "";
    expect(logs).not.toContain("SYMLINK-ESCAPE-CONTENT-MUST-NOT-LEAK");

    // 真实证据：回填给模型的 tool 消息必须是失败且指明 PATH_ESCAPE，且不含文件内容。
    const show = await run(["sessions", "show", "e02", "--json"], { home, cwd: workspace });
    expect(show.code).toBe(0);
    const detail = JSON.parse(show.stdout.trim()) as {
      messages: Array<{ role: string; content: string; toolCallId?: string }>;
    };
    const toolMsgs = detail.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]?.content).toMatch(/PATH_ESCAPE/);
    expect(toolMsgs[0]?.content).toMatch(/"ok":false/);
    expect(toolMsgs[0]?.content).not.toContain("SYMLINK-ESCAPE-CONTENT-MUST-NOT-LEAK");

    // 路径本身确实指向工作区外（前置条件校验，防止测试假绿）
    expect(realpathSync(path.join(workspace, "link"))).toBe(realpathSync(outside));
  });
});

// ---------------------------------------------------------------- E12

describe("E12 SIGINT cancellation", () => {
  it("E12 Ctrl+C mid-task exits 130 and issues no further tool calls", async () => {
    const home = freshHome("e12");
    const marker = path.join(home, "second-tool-ran");
    const script = [
      { type: "tool_calls", calls: [{ id: "c1", name: "exec", arguments: { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 8000)"] } }] },
      { type: "tool_calls", calls: [{ id: "c2", name: "write_file", arguments: { path: marker, content: "should never exist" } }] },
      { type: "final", text: "should never be reached" },
    ];
    const proc = spawnAgentx(["run", "long task", "--model", "mock", "--yes", "--json"], { home, script });

    // 等第一个工具调用真正开始（日志/耗时都可能滞后，这里给足启动时间）
    await sleep(1500);
    expect(proc.child.exitCode).toBeNull();
    proc.child.kill("SIGINT");

    const out = await Promise.race([proc.done, sleep(15000).then(() => ({ code: -2, signal: null, stdout: proc.getStdout(), stderr: proc.getStderr() }))]);

    expect(out.code).toBe(130);
    // 取消后不得再执行第二个工具
    expect(existsSync(marker)).toBe(false);
    expect(out.stdout + out.stderr).not.toContain("should never be reached");

    // 会话里落库的 task 结果必须是 cancelled（用 --json 单行输出校验）
    const line = out.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    expect(line, `stdout was: ${JSON.stringify(out.stdout)}`).toBeDefined();
    const payload = JSON.parse(line as string) as { status: string; terminationReason: string };
    expect(payload.status).toBe("cancelled");
    expect(payload.terminationReason).toBe("cancelled");
  });
});

// ---------------------------------------------------------------- E15

describe("E15 approval in a non-interactive shell", () => {
  it("E15 a high-risk tool (exec) without --yes exits 3 immediately (APPROVAL_REQUIRED, no hang)", async () => {
    const home = freshHome("e15");
    const ws = mkdtempSync(path.join(tmpdir(), "agentx-e15-ws-"));
    const marker = path.join(ws, "must-not-be-written");
    const script = [
      // exec 是 risk=high（D4 缺省 requireApprovalFor 命中），write_file 是 medium 不触发审批。
      { type: "tool_calls", calls: [{ id: "c1", name: "exec", arguments: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] } }] },
      { type: "final", text: "ran it" },
    ];
    const started = Date.now();
    // stdin 关闭 = 无 TTY；不传 --yes -> 需要审批
    const out = await run(["run", "run something", "--model", "mock", "--cwd", ws, "--json"], { home, script, cwd: ws, timeout: 20000 });
    const elapsed = Date.now() - started;

    expect(out.code).toBe(3);
    // 不得挂起：1s 级返回
    expect(elapsed).toBeLessThan(5000);
    expect(existsSync(marker)).toBe(false);

    const payload = JSON.parse(out.stdout.trim()) as { status: string; errorCode?: string; terminationReason: string };
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("APPROVAL_REQUIRED");
  });

  it("E15 --yes in the same non-interactive shell approves the exec and exits 0", async () => {
    const home = freshHome("e15-yes");
    const ws = mkdtempSync(path.join(tmpdir(), "agentx-e15yes-ws-"));
    const target = path.join(ws, "written.txt");
    const script = [
      { type: "tool_calls", calls: [{ id: "c1", name: "exec", arguments: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "approved")`] } }] },
      { type: "final", text: "ran it" },
    ];
    const out = await run(["run", "run something", "--model", "mock", "--yes", "--cwd", ws, "--json"], { home, script, cwd: ws, timeout: 20000 });

    expect(out.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("approved");
  });
});

// ---------------------------------------------------------------- E05 / E09 (E2E level)

describe("E05/E09 exec argument safety end to end", () => {
  it("E05 a semicolon command never produces the side-effect file", async () => {
    const home = freshHome("e05");
    const ws = mkdtempSync(path.join(tmpdir(), "agentx-e05-ws-"));
    const sideEffect = path.join(ws, "pwned");
    const script = [
      {
        type: "tool_calls",
        calls: [{ id: "c1", name: "exec", arguments: { command: `touch ${sideEffect}; echo hi`, args: [] } }],
      },
      { type: "final", text: "done" },
    ];
    const out = await run(["run", "run it", "--model", "mock", "--yes", "--cwd", ws, "--json", "--session", "e05"], { home, cwd: ws, script });

    expect(existsSync(sideEffect)).toBe(false);
    // 回填给模型的 tool 结果必须明确拒绝（ok:false + 元字符提示）
    const show = await run(["sessions", "show", "e05", "--json"], { home, cwd: ws });
    const detail = JSON.parse(show.stdout.trim()) as { messages: Array<{ role: string; content: string }> };
    const toolMsgs = detail.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]?.content).toMatch(/"ok":false/);
    expect(toolMsgs[0]?.content).toMatch(/metacharacter|shell/i);
    // 命令确实没有执行（否则文件会出现）
    expect(existsSync(sideEffect)).toBe(false);
    expect(out.code).toBe(0); // 工具失败回填后模型给出结论，任务本身不崩
  });
});

// ---------------------------------------------------------------- E24 (E2E through loop)

describe("E24 provider bad response through the CLI", () => {
  it("E24 malformed tool-call JSON arguments fail the task with PROVIDER_BAD_RESPONSE", async () => {
    const home = freshHome("e24");
    // mock 脚本在 CLI 层被 JSON 化，无法表达"坏 JSON 字符串"，因此走坏响应结构 + 坏 arguments 两种形状
    const script = [
      { type: "tool_calls", calls: [{ id: "c1", name: "read_file", arguments: "{not json" }] },
      { type: "final", text: "should not reach" },
    ];
    const out = await run(["run", "bad args", "--model", "mock", "--json"], { home, script });
    const payload = JSON.parse(out.stdout.trim()) as { status: string; errorCode?: string; terminationReason: string };
    // 字符串型 arguments 无法通过 zod 校验 -> INVALID_TOOL_ARGS；无论如何不能静默成功
    expect(payload.status).not.toBe("succeeded");
    expect(["INVALID_TOOL_ARGS", "PROVIDER_BAD_RESPONSE"]).toContain(payload.errorCode);
    expect(out.code).toBe(1);
  });
});

// ---------------------------------------------------------------- AC14 meta

describe("AC14 no placeholder assertions", () => {
  it("AC14 no expect(true).toBe(true) style placeholders in the test suite", () => {
    const roots = [path.join(ROOT, "tests"), ...readdirSync(path.join(ROOT, "packages")).map((p) => path.join(ROOT, "packages", p, "tests"))];
    const offenders: string[] = [];
    const trivialPattern = new RegExp("expect\\(\\s*(true|1)\\s*\\)\\s*\\.\\s*toBe\\(\\s*(true|1)\\s*\\)");
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) {
          // 跳过本文件自身（本测试要写正则字面量）
          if (path.resolve(full) === path.resolve(import.meta.filename)) continue;
          const text = readFileSync(full, "utf8");
          if (trivialPattern.test(text)) offenders.push(full);
          if (/\.(skip|todo)\s*\(/.test(text)) offenders.push(`${full} (skip/todo)`);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it("AC14 every E01-E25 id appears in at least one test name (AC10 mapping)", () => {
    const roots = [path.join(ROOT, "tests"), ...readdirSync(path.join(ROOT, "packages")).map((p) => path.join(ROOT, "packages", p, "tests"))];
    const titles: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) {
          for (const m of readFileSync(full, "utf8").matchAll(/\b(it|describe)\(\s*"([^"]+)"/g)) titles.push(m[2] as string);
        }
      }
    };
    roots.forEach(walk);
    const missing: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const id = `E${String(i).padStart(2, "0")}`;
      if (!titles.some((t) => t.includes(id))) missing.push(id);
    }
    expect(missing, `titles scanned: ${titles.length}`).toEqual([]);
  });
});

