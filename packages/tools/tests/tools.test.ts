import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { createLogger, ErrorCode, type AgentTool, type ToolContext } from "@agentx/core";
import { resolveInside, isInside, createDefaultTools, createToolRegistry, createPolicyEngine, createToolExecutor } from "../src/index.js";

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentx-tools-"));
  writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "sub", "b.txt"), "beta in sub\n");
  return dir;
}

function ctx(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: "t1",
    cwd,
    signal: new AbortController().signal,
    readOnly: false,
    approved: false,
    logger: createLogger({ level: "error", stderr: false }),
    env: {},
    ...over,
  };
}

function tool(name: string, cwd: string) {
  const found = createDefaultTools({ execTimeoutMs: 5000 }).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

describe("path safety", () => {
  it("E01 rejects traversal outside the workspace and reads nothing", async () => {
    const cwd = workspace();
    expect(() => resolveInside(cwd, "../../etc/passwd")).toThrow();
    const r = await tool("read_file", cwd).execute({ path: "../../etc/passwd" } as never, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(`${r.error}`).toMatch(/PATH_ESCAPE|outside|escape/i);
    expect(r.content).not.toContain("root:");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E02 rejects a symlink that points outside the workspace", async () => {
    const cwd = workspace();
    const outside = mkdtempSync(path.join(tmpdir(), "agentx-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(outside, path.join(cwd, "link"));
    try {
      expect(() => resolveInside(cwd, "link/secret.txt")).toThrow();
      const r = await tool("read_file", cwd).execute({ path: "link/secret.txt" } as never, ctx(cwd));
      expect(r.ok).toBe(false);
      expect(r.content).not.toContain("TOP SECRET");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("E03 rejects absolute paths outside the workspace", async () => {
    const cwd = workspace();
    const r = await tool("read_file", cwd).execute({ path: "/etc/passwd" } as never, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("root:");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("allows paths inside the workspace, including new nested files", () => {
    const cwd = workspace();
    const real = realpathSync(cwd);
    expect(resolveInside(cwd, "a.txt")).toBe(path.join(real, "a.txt"));
    expect(resolveInside(cwd, "sub/new/deep.txt")).toBe(path.join(real, "sub/new/deep.txt"));
    expect(isInside(real, path.join(real, "sub", "b.txt"))).toBe(true);
    expect(isInside(real, path.join(real, "..", "x"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("file tools", () => {
  it("reads a file with line numbers", async () => {
    const cwd = workspace();
    const r = await tool("read_file", cwd).execute({ path: "a.txt" } as never, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("alpha");
    expect(r.content).toContain("gamma");
    expect(r.content).toMatch(/1\|/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("truncates very large reads and flags it in metadata", async () => {
    const cwd = workspace();
    writeFileSync(path.join(cwd, "big.txt"), "x".repeat(300000));
    const r = await tool("read_file", cwd).execute({ path: "big.txt" } as never, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(r.metadata?.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(300000);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("makes read_file failures non-throwing and explanatory", async () => {
    const cwd = workspace();
    const r = await tool("read_file", cwd).execute({ path: "nope.txt" } as never, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/nope\.txt|not exist|ENOENT/i);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("lists directory entries and skips .git / node_modules", async () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, ".git"));
    mkdirSync(path.join(cwd, "node_modules"));
    const r = await tool("list_files", cwd).execute({ path: "." } as never, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt");
    expect(r.content).not.toContain(".git");
    expect(r.content).not.toContain("node_modules");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("searches text across the workspace", async () => {
    const cwd = workspace();
    const r = await tool("search_text", cwd).execute({ pattern: "beta" } as never, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt");
    expect(r.content).toContain("b.txt");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E19-ish: reports an invalid regex instead of throwing", async () => {
    const cwd = workspace();
    const r = await tool("search_text", cwd).execute({ pattern: "(", regex: true } as never, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/regex|pattern|invalid/i);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E04 writes nested new files and creates parents", async () => {
    const cwd = workspace();
    const r = await tool("write_file", cwd).execute({ path: "deep/dir/out.txt", content: "hello" } as never, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(cwd, "deep", "dir", "out.txt"), "utf8")).toBe("hello");
    expect(r.metadata?.bytes).toBe(5);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E23 refuses writes in read-only mode even when approved", async () => {
    const cwd = workspace();
    const r = await tool("write_file", cwd).execute(
      { path: "blocked.txt", content: "x" } as never,
      ctx(cwd, { readOnly: true, approved: true }),
    );
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("apply_patch replaces a unique occurrence and rejects ambiguous ones", async () => {
    const cwd = workspace();
    const t = tool("apply_patch", cwd);
    const good = await t.execute({ path: "a.txt", old_string: "beta", new_string: "BETA" } as never, ctx(cwd));
    expect(good.ok).toBe(true);
    expect(readFileSync(path.join(cwd, "a.txt"), "utf8")).toContain("BETA");

    writeFileSync(path.join(cwd, "dup.txt"), "x\nx\n");
    const ambiguous = await t.execute({ path: "dup.txt", old_string: "x", new_string: "y" } as never, ctx(cwd));
    expect(ambiguous.ok).toBe(false);
    expect(String(ambiguous.error)).toMatch(/2|ambiguous|multiple|unique/i);

    const missing = await t.execute({ path: "a.txt", old_string: "zzz", new_string: "q" } as never, ctx(cwd));
    expect(missing.ok).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("exec tool", () => {
  it("E05 refuses shell metacharacters and produces no side-effect file", async () => {
    const cwd = workspace();
    const r = await tool("exec", cwd).execute(
      { command: "echo hi; touch pwned.txt" } as never,
      ctx(cwd),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/metachar|shell|args/i);
    expect(existsSync(path.join(cwd, "pwned.txt"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runs an allowed command with an args array and reports the exit code", async () => {
    const cwd = workspace();
    const r = await tool("exec", cwd).execute(
      // os.EOL 之类的输出因平台而异，这里用 node 打印固定字符串
      { command: process.execPath, args: ["-e", "process.stdout.write('pong')"] } as never,
      ctx(cwd),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("pong");
    expect(r.metadata?.exitCode).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E06 truncates oversized output", async () => {
    const cwd = workspace();
    const t = createDefaultTools({ maxOutputBytes: 1000 }).find((x) => x.name === "exec")!;
    const r = await t.execute(
      { command: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(200000))"] } as never,
      ctx(cwd),
    );
    expect(r.metadata?.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(2000);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E07 kills the child on timeout", async () => {
    const cwd = workspace();
    const started = Date.now();
    const r = await tool("exec", cwd).execute(
      { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"], timeoutMs: 300 } as never,
      ctx(cwd),
    );
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);
    expect(r.metadata?.timedOut === true || /timeout/i.test(String(r.error))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("E16 does not leak credentials into the child environment", async () => {
    const cwd = workspace();
    // 关键：这些敏感变量必须同时在白名单内（envAllow 显式放行），
    // 才能证明"白名单不豁免敏感键"这条规则真的生效；
    // 否则它们会被白名单先挡掉，SENSITIVE_ENV_RE 根本没被执行。
    const t = createDefaultTools({
      execTimeoutMs: 5000,
      envAllow: ["DEEPSEEK_API_KEY", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD"],
    }).find((x) => x.name === "exec")!;
    // ctx.env 必须真的被 exec 采用：注入一个无害变量作为正对照，证明这条通道是通的，
    // 否则"没泄漏"可能只是因为这些变量压根没进子进程。
    const r = await t.execute(
      { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"] } as never,
      ctx(cwd, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANG: "C.UTF-8",
          DEEPSEEK_API_KEY: "sk-shouldnotleak123",
          AWS_SECRET_ACCESS_KEY: "aws-shouldnotleak456",
          DB_PASSWORD: "pw-shouldnotleak789",
          NOT_IN_ALLOWLIST: "should-not-appear",
        },
      }),
    );
    expect(r.ok).toBe(true);
    const childEnv = JSON.parse(r.content) as Record<string, string>;

    // 正对照：ctx.env 确实传到了子进程（LANG 在白名单内）
    expect(childEnv.LANG).toBe("C.UTF-8");
    // 白名单外的普通变量也不透传（默认最小环境）
    expect(childEnv.NOT_IN_ALLOWLIST).toBeUndefined();
    // 敏感键必须被剥离（键名与值都不能出现）
    expect(childEnv.DEEPSEEK_API_KEY).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.DB_PASSWORD).toBeUndefined();
    expect(r.content).not.toContain("sk-shouldnotleak123");
    expect(r.content).not.toContain("aws-shouldnotleak456");
    expect(r.content).not.toContain("pw-shouldnotleak789");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("honours an abort signal by killing the child", async () => {
    const cwd = workspace();
    const controller = new AbortController();
    const t = createDefaultTools({ execTimeoutMs: 20000 }).find((x) => x.name === "exec")!;
    const pending = t.execute(
      { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 20000)"] } as never,
      ctx(cwd, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 150);
    const r = await pending;
    expect(r.ok).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("PolicyEngine (PM_SPEC §7 / D4 ordering)", () => {
  const allowed = ["read_file", "write_file", "exec"];
  const mk = (over: Partial<AgentTool> = {}): AgentTool => ({
    name: "exec",
    description: "run",
    inputSchema: z.object({}),
    riskLevel: "high",
    readOnly: false,
    execute: async () => ({ ok: true, content: "" }),
    ...over,
  });
  const req = { taskId: "t", sessionId: "s", input: "x", cwd: "/w", model: "m", maxSteps: 1, timeoutMs: 1000, readOnly: false };

  it("AC5 denies a tool outside the allow-list, with no approval escape hatch", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "high", readOnly: false });
    await expect(policy.authorize({ request: req, tool: mk({ name: "rm_rf" }), input: {} })).rejects.toMatchObject({
      code: ErrorCode.POLICY_DENIED,
    });
  });

  it("E23 rejects side-effecting tools in read-only mode before approval is considered", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "none", readOnly: true });
    await expect(policy.authorize({ request: req, tool: mk(), input: {} })).rejects.toMatchObject({
      code: ErrorCode.READ_ONLY_VIOLATION,
    });
  });

  it("checks the allow-list before approval: a non-allowed tool is denied even with an eager approver", async () => {
    // 顺序固化：白名单必须先于审批。若实现把审批提到白名单之前，
    // 这里会因为 approver 恒返回 true 而放行，测试变红。
    const policy = createPolicyEngine({ allow: ["read_file"], approval: "all", readOnly: false });
    const highRisk = mk({ name: "exec", riskLevel: "high", readOnly: false });

    // 同一工具在"允许"时必须进入审批，说明审批条件本身是满足的；
    // 因此下面被拒绝只能归因于白名单先于审批。
    const allowed = createPolicyEngine({ allow: ["exec"], approval: "all", readOnly: false });
    const decision = await allowed.authorize({ request: req, tool: highRisk, input: {} });
    expect(decision.needApproval).toBe(true);

    await expect(policy.authorize({ request: req, tool: highRisk, input: {} })).rejects.toMatchObject({
      code: ErrorCode.POLICY_DENIED,
    });
  });

  it("checks read-only before approval: a side-effecting tool is rejected even under approval 'none'", async () => {
    const policy = createPolicyEngine({ allow: ["exec"], approval: "none", readOnly: true });
    await expect(policy.authorize({ request: req, tool: mk(), input: {} })).rejects.toMatchObject({
      code: ErrorCode.READ_ONLY_VIOLATION,
    });
  });

  it("requires approval for high-risk tools under the default policy", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "high", readOnly: false });
    const d = await policy.authorize({ request: req, tool: mk(), input: {} });
    expect(d.needApproval).toBe(true);
    expect(d.prompt).toContain("exec");
  });

  it("does not require approval for low-risk read-only tools under 'high'", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "high", readOnly: false });
    const d = await policy.authorize({ request: req, tool: mk({ name: "read_file", riskLevel: "low", readOnly: true }), input: {} });
    expect(d.needApproval).toBe(false);
  });

  it("'all' requires approval for every side-effecting tool", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "all", readOnly: false });
    const d = await policy.authorize({ request: req, tool: mk({ riskLevel: "medium" }), input: {} });
    expect(d.needApproval).toBe(true);
  });

  it("'none' never asks for approval", async () => {
    const policy = createPolicyEngine({ allow: allowed, approval: "none", readOnly: false });
    const d = await policy.authorize({ request: req, tool: mk(), input: {} });
    expect(d.needApproval).toBe(false);
  });
});

describe("registry and executor", () => {
  it("converts zod schemas into JSON-schema tool specs", () => {
    const reg = createToolRegistry(createDefaultTools({}));
    const specs = reg.toSpecs();
    const read = specs.find((s) => s.name === "read_file");
    expect(read).toBeDefined();
    expect((read!.parameters as { type?: string }).type).toBe("object");
    expect(JSON.stringify(read!.parameters)).toContain("path");
  });

  it("rejects duplicate tool registration", () => {
    const t = createDefaultTools({}).find((x) => x.name === "read_file")!;
    expect(() => createToolRegistry([t, t])).toThrow();
  });

  it("executor measures duration and converts thrown errors into structured results", async () => {
    const executor = createToolExecutor({ logger: createLogger({ level: "error", stderr: false }) });
    const boom: AgentTool = {
      name: "boom",
      description: "throws",
      inputSchema: z.object({}),
      riskLevel: "low",
      readOnly: true,
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const r = await executor.execute(boom, {}, ctx(process.cwd()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("kaboom");
    expect(r.metadata?.durationMs).toBeTypeOf("number");
  });
});
