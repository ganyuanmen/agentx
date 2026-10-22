import { describe, expect, it } from "vitest";
import { Ui, compactArgs, displayWidth, padEndWidth, truncateWidth, wrapByWidth, LOGO_WIDE, LOGO_COMPACT, LOGO_WIDE_MIN_COLUMNS, MASCOT } from "../src/ui.js";

interface Sink {
  text: string;
  write(chunk: string): boolean;
}

function sink(): Sink {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
      return true;
    },
  };
}

function makeUi(over: { isTTY?: boolean; columns?: number; json?: boolean; env?: Record<string, string> } = {}) {
  const out = sink();
  const err = sink();
  const ui = new Ui(
    {
      stdout: { write: (c: string) => out.write(c), isTTY: over.isTTY ?? true, columns: over.columns ?? 100 },
      stderr: { write: (c: string) => err.write(c), isTTY: over.isTTY ?? true },
      env: over.env ?? {},
    },
    over.json !== undefined ? { json: over.json } : {},
  );
  return { ui, out, err };
}

describe("mode detection (ADR-006)", () => {
  it("uses TUI mode on a colour-capable TTY", () => {
    expect(makeUi().ui.mode).toBe("tui");
    expect(makeUi().ui.color).toBe(true);
  });

  it("falls back to plain when NO_COLOR is set", () => {
    const { ui } = makeUi({ env: { NO_COLOR: "1" } });
    expect(ui.mode).toBe("plain");
    expect(ui.color).toBe(false);
  });

  it("falls back to plain when TERM=dumb", () => {
    expect(makeUi({ env: { TERM: "dumb" } }).ui.mode).toBe("plain");
  });

  it("is silent when stdout is not a TTY (pipe), so piping stays clean", () => {
    const { ui, out } = makeUi({ isTTY: false });
    expect(ui.mode).toBe("silent");
    out.text = "";
    ui.write(ui.logo());
    ui.write("decorative");
    expect(out.text).toBe("");
  });

  it("is silent in --json mode even on a TTY", () => {
    const { ui, out } = makeUi({ json: true });
    expect(ui.mode).toBe("silent");
    ui.write("decorative");
    expect(out.text).toBe("");
  });

  it("still writes the answer in silent mode", () => {
    const { ui, out } = makeUi({ isTTY: false });
    ui.writeResult("the answer");
    expect(out.text).toBe("the answer\n");
  });
});

describe("display width", () => {
  it("counts ASCII as one column and CJK as two", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("a中b")).toBe(4);
  });

  it("ignores ANSI escape sequences", () => {
    expect(displayWidth("\u001b[36mabc\u001b[0m")).toBe(3);
  });

  it("pads and truncates by display width, not code-unit length", () => {
    expect(padEndWidth("中", 4)).toBe("中  ");
    expect(displayWidth(padEndWidth("中", 5))).toBe(5);
    const cut = truncateWidth("中文字符串", 5);
    expect(displayWidth(cut)).toBeLessThanOrEqual(5);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("panel rendering", () => {
  it("draws a closed box whose lines all have the same display width", () => {
    const { ui } = makeUi({ columns: 60 });
    const panel = ui.panel("Title", ["alpha", "中文一行", ""]).trimEnd().split("\n");
    const widths = panel.map((l) => displayWidth(l));
    // 每一行（含边框）宽度必须完全一致，否则右边框会错位
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(60);
  });

  it("embeds the title in the top border and keeps the box closed", () => {
    // 用 plain 模式（无 ANSI），否则行首是转义序列而不是边框字符
    const { ui } = makeUi({ columns: 60, env: { NO_COLOR: "1" } });
    const first = ui.panel("Registered tools", ["x"]).split("\n")[0] ?? "";
    expect(first).toContain("Registered tools");
    expect(first.startsWith("╭")).toBe(true);
    expect(first.endsWith("╮")).toBe(true);
  });

  it("truncates over-long body lines instead of breaking the border", () => {
    const { ui } = makeUi({ columns: 40 });
    const long = "x".repeat(200);
    const lines = ui.panel("t", [long]).trimEnd().split("\n");
    expect(new Set(lines.map((l) => displayWidth(l))).size).toBe(1);
  });

  it("returns nothing in silent mode", () => {
    const { ui } = makeUi({ isTTY: false });
    expect(ui.panel("t", ["x"])).toBe("");
  });
});

describe("sidebar panel (mascot + grouped items)", () => {
  it("pads the mascot side to a fixed width so the columns stay aligned", () => {
    // 盲文点阵要求每行严格等宽，否则右边界会呈锯齿
    expect(new Set(MASCOT.map((l) => displayWidth(l))).size).toBe(1);
    expect(MASCOT.length).toBeGreaterThanOrEqual(8);
  });

  it("uses braille blank (U+2800) for mascot padding, not ASCII spaces", () => {
    // 混用普通空格会让部分字体的行宽不一致，从而破坏对齐
    for (const line of MASCOT) {
      expect(line).not.toMatch(/^ +| +$/);
      expect(line.length).toBe(displayWidth(line));
    }
  });

  it("keeps every rendered line at the panel width, mascot included", () => {
    const { ui } = makeUi({ columns: 100, env: { NO_COLOR: "1" } });
    const lines = ui
      .sidebarPanel("agentx", [
        { label: "low", items: ["read_file", "list_files"] },
        { label: "high", items: ["exec"] },
      ])
      .trimEnd()
      .split("\n");
    expect(new Set(lines.map((l) => displayWidth(l))).size).toBe(1);
  });

  it("shows the mascot and every group label", () => {
    const { ui } = makeUi({ columns: 100, env: { NO_COLOR: "1" } });
    const out = ui.sidebarPanel("agentx", [
      { label: "low", items: ["read_file"] },
      { label: "high", items: ["exec"] },
    ]);
    expect(out).toContain("low:");
    expect(out).toContain("high:");
    expect(out).toContain("read_file");
    // mascot 现在用盲文点阵绘制
    expect(out).toContain("⣿");
  });

  it("wraps long item lists instead of overflowing the border", () => {
    const { ui } = makeUi({ columns: 60, env: { NO_COLOR: "1" } });
    const many = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
    const lines = ui
      .sidebarPanel("t", [{ label: "low", items: many }])
      .trimEnd()
      .split("\n");
    expect(new Set(lines.map((l) => displayWidth(l))).size).toBe(1);
    expect(lines.join("\n")).toContain("tool_19");
  });

  it("renders nothing in silent mode", () => {
    const { ui } = makeUi({ isTTY: false });
    expect(ui.sidebarPanel("t", [{ label: "a", items: ["b"] }])).toBe("");
  });
});

describe("wrapByWidth", () => {
  it("keeps short text on one line", () => {
    expect(wrapByWidth("hello world", 40)).toEqual(["hello world"]);
  });

  it("never exceeds the requested display width", () => {
    const parts = wrapByWidth("alpha beta gamma delta epsilon zeta", 12);
    for (const p of parts) expect(displayWidth(p)).toBeLessThanOrEqual(12);
  });

  it("hard-splits a single word longer than the limit", () => {
    const parts = wrapByWidth("x".repeat(30), 10);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(displayWidth(p)).toBeLessThanOrEqual(10);
  });

  it("handles CJK text without overflowing", () => {
    const parts = wrapByWidth("中文内容需要折行处理", 6);
    for (const p of parts) expect(displayWidth(p)).toBeLessThanOrEqual(6);
  });
});

describe("logo", () => {
  it("uses the wide logo on normal terminals", () => {
    const { ui } = makeUi({ columns: 100 });
    expect(ui.logo()).toContain(LOGO_WIDE[0]);
  });

  it("falls back to the compact logo on narrow terminals", () => {
    const { ui } = makeUi({ columns: 45 });
    const logo = ui.logo();
    expect(logo).toContain(LOGO_COMPACT);
    expect(logo).not.toContain(LOGO_WIDE[0]);
  });

  it("switches at the real logo width boundary (54 wide, 53 compact)", () => {
    // 大号字形最宽 52 列；60 列以上才启用会白白浪费 54~59 列的空间。
    // 这里锁死边界，避免以后改阈值时没人发现窄终端退化了。
    const widest = Math.max(...LOGO_WIDE.map((l) => displayWidth(l)));
    expect(widest).toBe(52);
    expect(LOGO_WIDE_MIN_COLUMNS).toBeGreaterThan(widest);
    expect(makeUi({ columns: LOGO_WIDE_MIN_COLUMNS }).ui.logo()).toContain(LOGO_WIDE[0]);
    expect(makeUi({ columns: LOGO_WIDE_MIN_COLUMNS - 1 }).ui.logo()).toContain(LOGO_COMPACT);
  });

  it("never emits a logo line wider than the terminal", () => {
    for (const columns of [40, 53, 54, 60, 100]) {
      const ui = makeUi({ columns, env: { NO_COLOR: "1" } }).ui;
      for (const line of ui.logo().split("\n").filter((l) => l !== "")) {
        expect(displayWidth(line)).toBeLessThanOrEqual(Math.max(columns, displayWidth(LOGO_COMPACT)));
      }
    }
  });

  it("emits no ANSI when colour is disabled", () => {
    const { ui } = makeUi({ env: { NO_COLOR: "1" } });
    expect(ui.logo()).not.toContain("\u001b[");
  });
});

describe("multi-line answers", () => {
  it("does not put the marker on a leading blank line", () => {
    const { ui } = makeUi({ env: { NO_COLOR: "1" } });
    const rendered = ui.assistantLine("\n\nactual answer");
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("⏺ actual answer");
  });

  it("indents continuation lines under the marker", () => {
    const { ui } = makeUi();
    const rendered = ui.assistantLine("first\nsecond");
    const lines = rendered.split("\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toBe("  second");
  });
});

describe("compactArgs", () => {
  it("renders a short single-line summary", () => {
    expect(compactArgs({ path: ".", depth: 2 })).toBe('{path:".", depth:2}');
  });

  it("elides beyond three keys and truncates long values", () => {
    const out = compactArgs({ a: 1, b: 2, c: 3, d: 4 });
    expect(out).toContain("…");
    expect(displayWidth(compactArgs({ q: "x".repeat(200) }, 30))).toBeLessThanOrEqual(30);
  });

  it("handles primitive and empty inputs", () => {
    expect(compactArgs(undefined)).toBe("");
    expect(compactArgs("plain")).toBe("plain");
  });
});
