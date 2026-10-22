import { describe, expect, it } from "vitest";
import {
  Ui,
  displayWidth,
  formatDuration,
  formatTokens,
  progressBar,
  resolveColumns,
  truncateWidth,
  type StatusLineInfo,
} from "../src/ui.js";
import { promptFor, sessionWorkMs } from "../src/main.js";

function makeUi(over: { isTTY?: boolean; columns?: number; json?: boolean; env?: Record<string, string> } = {}): Ui {
  return new Ui(
    {
      stdout: { write: () => true, isTTY: over.isTTY ?? true, columns: over.columns ?? 100 },
      stderr: { write: () => true, isTTY: over.isTTY ?? true },
      env: over.env ?? {},
    },
    over.json !== undefined ? { json: over.json } : {},
  );
}

/** 状态栏测试统一用 plain（无 ANSI），断言的是「给人看的内容」，不是颜色。 */
function plainLine(over: Partial<StatusLineInfo> = {}, columns = 100): string {
  const ui = makeUi({ columns, env: { NO_COLOR: "1" } });
  return ui.statusLine({
    model: "deepseek:deepseek-chat",
    usedTokens: 19240,
    contextLimit: 65536,
    turnMs: 15000,
    sessionMs: 2000,
    steps: 1,
    ...over,
  });
}

describe("formatTokens (AC4)", () => {
  it("keeps sub-thousand values exact so tiny usage does not read as 0.0K", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(999)).toBe("999");
  });

  it("switches to K at exactly 1000 and drops a trailing .0", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(19240)).toBe("19.2K");
    expect(formatTokens(65536)).toBe("65.5K");
  });

  it("drops the decimal past 100K and switches to M at 1e6", () => {
    expect(formatTokens(123456)).toBe("123K");
    expect(formatTokens(999999)).toBe("1000K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(12_500_000)).toBe("13M");
  });

  it("treats garbage as zero instead of printing NaN", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatDuration (AC4)", () => {
  it("uses ms below one second", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(920)).toBe("920ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("uses one decimal second below a minute", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(15000)).toBe("15.0s");
    expect(formatDuration(59949)).toBe("59.9s");
  });

  it("never prints 60.0s — the rounded value decides the unit", () => {
    // 59.96s 四舍五入到一位小数是 60.0s，那就该进位成 1m 00s
    expect(formatDuration(59960)).toBe("1m 00s");
    expect(formatDuration(60000)).toBe("1m 00s");
    expect(formatDuration(65000)).toBe("1m 05s");
    expect(formatDuration(3_600_000)).toBe("60m 00s");
  });
});

describe("progressBar (AC4)", () => {
  it("is always 12 columns wide", () => {
    for (const r of [0, 0.02, 0.5, 0.99, 1, 2, -1, Number.NaN]) {
      expect(displayWidth(progressBar(r))).toBe(12);
    }
  });

  it("lights at least one cell for any non-zero usage", () => {
    // 2% 若一格都不亮，用户会以为上下文是空的
    expect(progressBar(0.02)).toBe("[█░░░░░░░░░]");
    expect(progressBar(0.001)).toBe("[█░░░░░░░░░]");
    expect(progressBar(0)).toBe("[░░░░░░░░░░]");
  });

  it("clamps to full when usage exceeds the window", () => {
    expect(progressBar(2)).toBe("[██████████]");
    expect(progressBar(1)).toBe("[██████████]");
  });
});

describe("statusLine structure (AC1)", () => {
  it("renders the 7 documented segments in order", () => {
    const line = plainLine();
    expect(line).toBe("⚕ deepseek:deepseek-chat │ 19.2K/65.5K │ [███░░░░░░░] 29% │ 15.0s │ ⏲ 2.0s │ ✓ 1 step(s)");
    expect(line.split("│")).toHaveLength(6);
    expect(line.startsWith("⚕")).toBe(true);
  });

  it("keeps the percentage attached to the bar instead of a separate segment", () => {
    const line = plainLine();
    expect(line.match(/%/g)).toHaveLength(1);
    expect(line).toContain("[███░░░░░░░] 29%");
  });

  it("does not exceed the terminal width", () => {
    for (const columns of [40, 50, 60, 80, 100]) {
      const line = plainLine({}, columns);
      expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    }
  });

  it("drops the bar before truncating the hard numbers on narrow terminals", () => {
    const narrow = plainLine({}, 60);
    expect(narrow).not.toContain("[");
    // 模型与令牌数是最该保住的信息，窄终端下必须还在
    expect(narrow).toContain("deepseek:deepseek-chat");
    expect(narrow).toContain("19.2K/65.5K");
  });

  it("survives CJK in the model field without breaking the width budget", () => {
    const line = plainLine({ model: "本地模型:千问3" }, 60);
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });
});

describe("statusLine edge cases (AC5)", () => {
  it("omits limit, bar and percentage when contextLimit is unknown", () => {
    const line = plainLine({ contextLimit: undefined });
    expect(line).toContain("19.2K tok");
    expect(line).not.toContain("%");
    expect(line).not.toContain("[");
    expect(line).not.toContain("/");
  });

  it("clamps the percentage at 100% when usage exceeds the window", () => {
    const line = plainLine({ usedTokens: 900000, contextLimit: 65536 });
    expect(line).toContain("900K/65.5K");
    expect(line).toContain("100%");
    expect(line).toContain("[██████████]");
  });

  it("shows zero-duration turns without NaN", () => {
    const line = plainLine({ usedTokens: 0, turnMs: 0, sessionMs: 0, steps: 0 });
    expect(line).not.toContain("NaN");
    expect(line).toContain("0/65.5K");
    // 0 令牌必须是 0%，不能靠下限夹紧成 1%
    expect(line).toContain("[░░░░░░░░░░] 0%");
    expect(line).toContain("⏲ 0ms");
  });
});

describe("statusLine failure state (AC3)", () => {
  it("appends the error code after the success segments", () => {
    const line = plainLine({ errorCode: "PROVIDER_FAILED" });
    expect(line.endsWith("✗ PROVIDER_FAILED")).toBe(true);
    expect(line).toContain("✓ 1 step(s)");
  });
});

describe("statusLine mode handling (AC8)", () => {
  it("returns an empty string in silent mode so pipes stay clean", () => {
    const ui = makeUi({ isTTY: false });
    expect(ui.mode).toBe("silent");
    expect(ui.statusLine({ model: "x", usedTokens: 1, contextLimit: 10, turnMs: 1, sessionMs: 1, steps: 1 })).toBe("");
  });

  it("returns an empty string in --json mode", () => {
    const ui = makeUi({ json: true });
    expect(ui.statusLine({ model: "x", usedTokens: 1, contextLimit: 10, turnMs: 1, sessionMs: 1, steps: 1 })).toBe("");
  });

  it("emits no ANSI in plain mode but keeps the same content", () => {
    const line = plainLine();
    expect(line).not.toContain("\u001b[");
    expect(line).toContain("⚕");
  });

  it("emits ANSI in tui mode", () => {
    const ui = makeUi({ env: {} });
    const line = ui.statusLine({ model: "m", usedTokens: 1, contextLimit: 10, turnMs: 1, sessionMs: 1, steps: 1 });
    expect(line).toContain("\u001b[");
  });
});

describe("truncateWidth keeps ANSI intact", () => {
  it("never cuts an escape sequence in half", () => {
    // 旧实现按字符切，会把 "\u001b[36m" 切成 "\u001b[3"，终端里直接显示乱码。
    const colored = "\u001b[36mdeepseek\u001b[0m \u001b[90m│\u001b[0m 19.2K/65.5K";
    const cut = truncateWidth(colored, 12);
    const stripped = cut.replace(/\u001b\[[0-9;]*m/g, "");
    expect(stripped).not.toContain("\u001b");
    // 残留的转义序列必须都能被完整匹配（即没有半截序列）
    expect(cut.match(/\u001b\[[0-9;]*m/g)?.length).toBeGreaterThan(0);
    expect(displayWidth(cut)).toBeLessThanOrEqual(12);
  });

  it("appends a reset when the closing reset falls outside the cut", () => {
    // 颜色开在截断点之前、reset 在之后：不补 reset 就会让后面的输出全是青色
    const colored = "\u001b[32m" + "x".repeat(50) + "\u001b[0m";
    const cut = truncateWidth(colored, 10);
    expect(cut.endsWith("\u001b[0m…")).toBe(true);
  });

  it("keeps plain truncation unchanged (no stray reset)", () => {
    expect(truncateWidth("abcdefghij", 5)).toBe("abcd…");
    expect(truncateWidth("short", 10)).toBe("short");
  });
});

describe("resolveColumns", () => {
  it("treats columns=0 as unknown instead of collapsing to the 40-column floor", () => {
    // 回归：pty.fork 里 process.stdout.columns 是 0 而不是 undefined，
    // 旧写法 `columns ?? 80` 会走进 0，把面板压成 42 列宽。
    expect(resolveColumns(0, {})).toBe(80);
    expect(resolveColumns(0, { COLUMNS: "110" })).toBe(100);
    expect(resolveColumns(-5, {})).toBe(80);
    expect(resolveColumns(Number.NaN, {})).toBe(80);
  });

  it("prefers the real stream width over the environment", () => {
    expect(resolveColumns(90, { COLUMNS: "60" })).toBe(90);
  });

  it("clamps to the supported 40..100 range", () => {
    expect(resolveColumns(20, {})).toBe(40);
    expect(resolveColumns(200, {})).toBe(100);
    expect(resolveColumns(undefined, { COLUMNS: "garbage" })).toBe(80);
  });
});

describe("promptFor (AC7)", () => {
  it("embeds the short session id", () => {
    const ui = makeUi({ env: { NO_COLOR: "1" } });
    expect(promptFor("ses_1a2b3c4d-9999", ui)).toBe("ses_1a2b> ");
  });

  it("uses the colour prompt on a TUI and a plain one otherwise", () => {
    const tui = makeUi({ env: {} });
    expect(promptFor("ses_1a2b3c4d", tui)).toContain("\u001b[96m");
    expect(promptFor("ses_1a2b3c4d", tui)).toContain("❯");
    const plain = makeUi({ env: { NO_COLOR: "1" } });
    expect(promptFor("ses_1a2b3c4d", plain)).not.toContain("\u001b[");
  });

  it("falls back to the stable pipe prompt in silent mode", () => {
    const silent = makeUi({ isTTY: false });
    expect(promptFor("ses_1a2b3c4d", silent)).toBe("agentx> ");
  });

  it("changes when the session changes, so /new can refresh it", () => {
    const ui = makeUi({ env: { NO_COLOR: "1" } });
    const before = promptFor("ses_aaaaaaaa-1", ui);
    const after = promptFor("ses_bbbbbbbb-2", ui);
    expect(before).not.toBe(after);
  });
});

describe("sessionWorkMs", () => {
  it("sums finished task durations instead of measuring wall-clock age", () => {
    // 关键语义：这是「agent 干了多久活」，不是「会话活了多久」。
    // 用 createdAt->now 会让状态栏数字随进程启动时刻漂移。
    const store = {
      listTasks: () => [
        { startedAt: "2026-10-22T10:00:00.000Z", finishedAt: "2026-10-22T10:00:02.000Z" },
        { startedAt: "2026-10-22T10:05:00.000Z", finishedAt: "2026-10-22T10:05:01.500Z" },
      ],
    };
    expect(sessionWorkMs(store, "ses_1")).toBe(3500);
  });

  it("counts an in-flight task up to now so a running turn is not reported as 0", () => {
    const started = "2026-10-22T10:00:00.000Z";
    const store = { listTasks: () => [{ startedAt: started }] };
    expect(sessionWorkMs(store, "ses_1", Date.parse(started) + 4000)).toBe(4000);
  });

  it("skips corrupt rows and never returns negative time", () => {
    const store = {
      listTasks: () => [
        { startedAt: "not-a-date", finishedAt: "2026-10-22T10:00:02.000Z" },
        { startedAt: "2026-10-22T10:00:05.000Z", finishedAt: "2026-10-22T10:00:01.000Z" },
      ],
    };
    expect(sessionWorkMs(store, "ses_1")).toBe(0);
  });

  it("survives a store that throws", () => {
    const broken = {
      listTasks: () => {
        throw new Error("db closed");
      },
    };
    expect(sessionWorkMs(broken, "ses_x")).toBe(0);
  });
});
