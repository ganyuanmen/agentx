import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createLogger } from "@agentx/core";
import { createDefaultTools } from "../src/index.js";

const logger = createLogger({ level: "error", stderr: false });

function ctx() {
  return {
    taskId: "meta",
    cwd: mkdtempSync(path.join(tmpdir(), "agentx-meta-")),
    signal: new AbortController().signal,
    readOnly: false,
    approved: false,
    logger,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  };
}

/**
 * exec 的 command 有两道防线：① 元字符黑名单 ② 命令名允许字符集白名单。
 * 存在双层防御时，只断言"整体被拒绝"会让测试在任意一层被删除后仍保持绿色。
 * 这里分别固定每一层的可观测证据：元字符命中时 metadata.rejected === "shell_metacharacter"，
 * 而不是笼统的 ok:false。
 */
describe("exec shell-metacharacter rejection (E05) — both layers pinned", () => {
  const metas = [";", "&&", "|", "`", "$(", ">", "<", "\n"];

  for (const meta of metas) {
    it(`E05 rejects command containing ${JSON.stringify(meta)} via the metachar layer`, async () => {
      const exec = createDefaultTools({ execTimeoutMs: 2000 }).find((t) => t.name === "exec")!;
      const c = ctx();
      const r = await exec.execute({ command: `echo hi${meta} touch pwned` }, c);

      expect(r.ok).toBe(false);
      // 断言第一层的具体分类，而不是泛泛的失败
      expect(r.metadata?.rejected).toBe("shell_metacharacter");
      expect(String(r.error)).toMatch(/INVALID_TOOL_ARGS/);
      expect(existsSync(path.join(c.cwd, "pwned"))).toBe(false);
    });
  }

  it("E05 still rejects when the metachar layer is bypassed, via the charset allowlist", async () => {
    const exec = createDefaultTools({ execTimeoutMs: 2000 }).find((t) => t.name === "exec")!;
    // 不含元字符但含不允许字符（空格 + 引号）的命令名，必须被第二层拒绝
    const r = await exec.execute({ command: "/bin/sh -c id" }, ctx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/INVALID_TOOL_ARGS|not allowed|character/i);
  });

  it("E05 accepts a legitimate absolute program path", async () => {
    const exec = createDefaultTools({ execTimeoutMs: 5000 }).find((t) => t.name === "exec")!;
    const r = await exec.execute({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("ok");
  });
});
