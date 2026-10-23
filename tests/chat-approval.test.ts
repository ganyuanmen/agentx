import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * chat 审批回归（E23）：审批提示出现前必须先停掉 spinner。
 *
 * 缺陷：chat 每轮 `startSpinner("thinking")`，而 spinner 每 120ms 往 stderr 写
 * `\r⠋ thinking\x1b[K` —— 回车 + 清行。审批提示也写 stderr。两者抢同一行时，
 * 提示 "exec high 将执行：... [y/N]" 会被 spinner 用 \r 回车后擦掉，只剩 "⠋ thinking"。
 * 用户看不见提示、不知道要按键，任务就停在 waiting_approval，直到
 * `createInteractiveApprover` 里 10 分钟超时把空答案当拒绝 —— 感受就是「chat 卡住」。
 *
 * 断言用一个**确定性**信号而不是帧数：`Ui.stopSpinner()` 在真正停掉 timer 时会写
 * `\r\x1b[K`（回车+清行，随后换行）。所以「提示出现前是否出现过 \r\x1b[K」直接
 * 反映"有没有把 spinner 停掉"，不受 120ms 采样竞态影响。
 *
 * 双向实测（各跑 3 次，全部一致）：
 *   修复后 stopSequenceCount = 1
 *   回退修复 stopSequenceCount = 0
 *
 * 管道模式走不到这条路径（interactive=false 直接报 no approver），
 * `script(1)`（管道输入 + 内部 pty）也复现不出，故必须用 python3 分配真 pty。
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "packages", "cli", "bin", "agentx.js");

const PY_DRIVER = String.raw`
import os, pty, select, sys, time, json, subprocess

home, script, bin_path, root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
env = dict(os.environ)
env["AGENTX_HOME"] = home
env["AGENTX_MOCK_SCRIPT"] = script

master, slave = pty.openpty()
p = subprocess.Popen(["node", bin_path, "chat", "--model", "mock:mock-1"],
                     stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root, close_fds=True)
os.close(slave)

buf = b""
def drain(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                c = os.read(master, 65536)
            except OSError:
                return
            if not c:
                return
            buf += c

def wait(m, timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        drain(0.05)
        if m.encode() in buf:
            return True
        if p.poll() is not None:
            return m.encode() in buf
    return False

drain(1.5)
os.write(master, b"run the tool please\r")
saw_prompt = wait("[y/N]", 25)

idx = buf.find(b"[y/N]")
before = buf[:idx] if idx >= 0 else b""
# Ui.stopSpinner() 的确定性收尾序列（回车 + 清行）
stop_seq = before.count(b"\r\x1b[K")

if saw_prompt:
    os.write(master, b"y\r")
saw_output = wait("hello-from-exec", 25)

drain(0.8)
try:
    os.write(master, b"/exit\r")
except OSError:
    pass
drain(0.8)
if p.poll() is None:
    p.kill()
os.close(master)

print(json.dumps({
    "sawPrompt": saw_prompt,
    "stopSeqBeforePrompt": stop_seq,
    "sawOutput": saw_output,
    "tail": buf.decode("utf8", "replace")[-500:],
}))
`;

function havePtyDriver(): boolean {
  try {
    execFileSync("python3", ["-c", "import pty, select"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("chat approval (E23)", () => {
  it.skipIf(!havePtyDriver())("E23 stops the spinner before showing the approval prompt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agentx-e23-"));
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        defaultModel: "mock:mock-1",
        providers: { mock: { type: "mock", models: ["mock-1"] } },
        policy: { approval: "high" },
        tools: { allow: ["exec"] },
      }),
    );
    const scriptPath = path.join(home, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        {
          type: "tool_calls",
          calls: [{ id: "c1", name: "exec", arguments: { command: "echo", args: ["hello-from-exec"] } }],
        },
      ]),
    );

    const raw = execFileSync("python3", ["-c", PY_DRIVER, home, scriptPath, BIN, ROOT], {
      encoding: "utf8",
      timeout: 120000,
    });
    const r = JSON.parse(raw.trim().split("\n").pop() as string) as {
      sawPrompt: boolean;
      stopSeqBeforePrompt: number;
      sawOutput: boolean;
      tail: string;
    };

    expect(r.sawPrompt, `审批提示没出现；尾部：\n${r.tail}`).toBe(true);
    // 核心断言：提示之前必须已经停过 spinner（会写 \r\x1b[K 收尾），
    // 否则 spinner 会回车擦掉提示，用户看不到该按什么。
    expect(
      r.stopSeqBeforePrompt,
      `审批前没有停 spinner（提示会被 \r 擦掉）；尾部：\n${r.tail}`,
    ).toBeGreaterThan(0);
    // 输入 y 后工具必须真的执行
    expect(r.sawOutput, `exec 未执行；尾部：\n${r.tail}`).toBe(true);
  }, 150000);
});
