/**
 * TUI 渲染层（ADR-006）。
 *
 * 三档能力自动降级，不做配置开关：
 *   - tui    ：stdout 是 TTY、TERM 非 dumb、未设 NO_COLOR —— 完整界面（颜色 + 边框 + spinner）
 *   - plain  ：是 TTY 但禁用了颜色 —— 同样版面无 ANSI 颜色
 *   - silent ：stdout 不是 TTY 或 --json —— 只输出答案，绝不写装饰
 *
 * 目的：保持 `agentx run "..." | jq` 这类管道可用（PM_SPEC §5.2）。
 */

export type UiMode = "tui" | "plain" | "silent";

export interface UiStreams {
  stdout: { write(chunk: string): boolean | void; isTTY?: boolean; columns?: number };
  stderr: { write(chunk: string): boolean | void; isTTY?: boolean };
  env: Record<string, string | undefined>;
}

export interface UiOptions {
  json?: boolean;
  /** 强制降级（测试用）。 */
  forceMode?: UiMode;
}

// ---------------------------------------------------------------- 颜色

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  cyan: "\u001b[36m",
  brightCyan: "\u001b[96m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
} as const;

export type ColorName = keyof Omit<typeof ANSI, "reset">;

// ---------------------------------------------------------------- 宽字符

/**
 * 计算字符串在终端里占用的列数。
 * CJK（含中文、全角标点）与 emoji 占 2 列；ANSI 转义序列不计入。
 */
export function displayWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0) continue;
    if (isWide(cp)) width += 2;
    else if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    else width += 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  );
}

/** 按显示宽度右补空格（中文标签对齐用）。 */
export function padEndWidth(text: string, target: number): string {
  const pad = target - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** 按显示宽度折行（保留完整单词，尽量不切断英文单词）。 */
export function wrapByWidth(text: string, max: number): string[] {
  if (max <= 0) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    if (word === "") continue;
    const candidate = line === "" ? word.trimStart() : line + word;
    if (displayWidth(candidate) <= max) {
      line = candidate;
      continue;
    }
    if (line !== "") out.push(line.trimEnd());
    // 单词本身超长则硬切
    if (displayWidth(word) > max) {
      let chunk = "";
      for (const ch of word) {
        if (displayWidth(chunk + ch) > max) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    } else {
      line = word.trimStart();
    }
  }
  if (line !== "") out.push(line.trimEnd());
  return out.length > 0 ? out : [""];
}

/** 按显示宽度截断，超出加省略号。ANSI 转义序列整体保留，绝不会被切成半截。 */
export function truncateWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return "…";
  let out = "";
  let width = 0;
  // eslint-disable-next-line no-control-regex
  const tokens = text.match(/\u001b\[[0-9;]*m|[\s\S]/g) ?? [];
  for (const token of tokens) {
    // 转义序列宽度为 0：无条件写入，否则截断后颜色不会被 reset 关闭。
    if (token.startsWith("\u001b[")) {
      out += token;
      continue;
    }
    const w = displayWidth(token);
    if (width + w > max - 1) break;
    out += token;
    width += w;
  }
  // 截断可能把颜色段的 reset 也切掉了，末尾补一个 reset，否则颜色会渗到下一行。
  return `${out}${out.includes("\u001b[") ? ANSI.reset : ""}…`;
}

// ---------------------------------------------------------------- Logo

/** 大号 logo（ANSI Shadow 字体，宽度 58 列）；终端 < 60 列时不用。 */
export const LOGO_WIDE = [
  "█████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗  ██╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝╚██╗██╔╝",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║    ╚███╔╝ ",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║    ██╔██╗ ",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██╔╝ ██╗",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝",
] as const;

/**
 * 吉祥物：11 行 x 29 列的盲文点阵猫（U+2800 区），与参考产品的质感一致。
 *
 * 用 U+2800（BRAILLE PATTERN BLANK）而不是普通空格来补右侧留白：
 * 它在等宽字体里与其它盲文字符同宽，能保证 11 行严格对齐；
 * 渲染时整块用青/品红色系着色，因此右侧留白不会出现色带错位。
 */
export const MASCOT: readonly string[] = [
  "⠀⠀⠀⢀⣀⣀⣀⣀⣀⣀⡀⠀⠀⠀⠀⢀⣀⣀⣀⣀⣀⣀⡀⠀⠀⠀",
  "⠀⠀⣸⣿⣿⣿⣿⣿⣿⣿⣿⣷⣤⣤⣾⣿⣿⣿⣿⣿⣿⣿⣿⣇⠀⠀",
  "⠀⢰⣿⣿⡿⠛⠛⠛⠛⢻⣿⣿⣿⣿⣿⣿⡟⠛⠛⠛⠛⢿⣿⣿⡆⠀",
  "⠀⢸⣿⣿⡇⢠⣤⣤⡄⢸⣿⣿⣿⣿⣿⣿⡇⢠⣤⣤⡄⢸⣿⣿⡇⠀",
  "⠀⢸⣿⣿⡇⠘⠛⠛⠃⢸⣿⣿⣿⣿⣿⣿⡇⠘⠛⠛⠃⢸⣿⣿⡇⠀",
  "⠀⢸⣿⣿⣷⣦⣤⣤⣴⣾⣿⣿⣿⣿⣿⣿⣷⣦⣤⣤⣴⣾⣿⣿⡇⠀",
  "⠀⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀",
  "⠀⠀⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣴⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠀⠀",
  "⠀⠀⠀⠀⠈⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠁⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⡇⠀⠀⢸⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⡇⠀⠀⢸⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠘⠿⣿⠇⠀⠀⠸⣿⠿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀",
] as const;

/** 紧凑 logo：终端过窄时的单行替代，避免折行破坏版面。 */
export const LOGO_COMPACT = "▰▰ AGENTX ▰▰" as const;

/** 大号 logo 从 52 列的终端宽度起可用（52 列字形 + 两侧各 1 列留白），再窄就折行。 */
export const LOGO_WIDE_MIN_COLUMNS = 54;

// ---------------------------------------------------------------- 状态栏格式化

/**
 * 令牌数的人类可读形式：19240 -> "19.2K"，1200000 -> "1.2M"。
 * 小于 1000 不定单位（"512"），避免出现 "0.0K" 这种没有信息量的写法。
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = v / 1000;
    // 100K 以上不留小数（"123K" 比 "123.4K" 短且够用）
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = v / 1_000_000;
  return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}

/** 时长：<1s 用毫秒，<60s 用一位小数秒，更久用 "Xm YYs"。 */
export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (v < 1000) return `${Math.round(v)}ms`;
  // 用「四舍五入到 0.1 秒」作为判定依据：59.96s 若标成 60.0s 就自相矛盾了。
  const tenths = Math.round(v / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)}s`;
  const total = Math.round(v / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/**
 * 10 格进度条，返回 "▕░░░░░░░░░░▏" 形式（12 列）。
 * ratio 先夹到 [0,1]；>0 的极小值至少点亮 1 格，否则用户看不出「有占用」。
 */
export function progressBar(ratio: number): string {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = r <= 0 ? 0 : Math.max(1, Math.round(r * 10));
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

// ---------------------------------------------------------------- Ui

/**
 * 决定版面宽度（40..100 列）。
 *
 * `process.stdout.columns` 在 PTY 未设置窗口大小时是 **0**（不是 undefined），
 * 旧写法 `columns ?? 80` 遇到 0 会让整块面板塌到 40 列下限——实测在 pty.fork
 * 出来的会话里就是这样烂版的。所以 0/负数一律视为「未知」，退回环境变量
 * `COLUMNS`，再退回 80 列。
 */
export function resolveColumns(columns: number | undefined, env: Record<string, string | undefined>): number {
  const fromStream = typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? columns : undefined;
  const envRaw = env.COLUMNS ? Number.parseInt(env.COLUMNS, 10) : Number.NaN;
  const fromEnv = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : undefined;
  const width = fromStream ?? fromEnv ?? 80;
  return Math.max(40, Math.min(width, 100));
}

export class Ui {
  readonly mode: UiMode;
  readonly columns: number;
  readonly color: boolean;
  private readonly out: UiStreams["stdout"];
  private readonly err: UiStreams["stderr"];
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIndex = 0;
  private spinnerLabel = "";
  private readonly stderrIsTty: boolean;

  constructor(streams: UiStreams, options: UiOptions = {}) {
    this.out = streams.stdout;
    this.err = streams.stderr;
    const json = Boolean(options.json);
    if (options.forceMode) {
      this.mode = options.forceMode;
    } else if (json || !streams.stdout.isTTY) {
      this.mode = "silent";
    } else if (streams.env.NO_COLOR !== undefined || streams.env.TERM === "dumb") {
      this.mode = "plain";
    } else {
      this.mode = "tui";
    }
    this.color = this.mode === "tui";
    this.stderrIsTty = Boolean(streams.stderr.isTTY);
    this.columns = resolveColumns(streams.stdout.columns, streams.env);
  }

  /** silent 模式下所有装饰输出都被吞掉。 */
  private get decorative(): boolean {
    return this.mode !== "silent";
  }

  private paint(text: string, ...colors: ColorName[]): string {
    if (!this.color || colors.length === 0) return text;
    return colors.map((c) => ANSI[c]).join("") + text + ANSI.reset;
  }

  /** 直接写 stdout（装饰用；silent 下丢弃）。 */
  write(text: string): void {
    if (!this.decorative) return;
    this.out.write(text);
  }

  /** 写答案/结果（silent 下也写）。 */
  writeResult(text: string): void {
    this.out.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** 诊断信息一律写 stderr，绝不污染 stdout。 */
  warn(text: string): void {
    this.err.write(`${this.paint("! ", "yellow")}${text}\n`);
  }

  // ------------------------------------------------------------ 组件

  logo(): string {
    if (!this.decorative) return "";
    if (this.columns < LOGO_WIDE_MIN_COLUMNS) {
      return `${this.paint(LOGO_COMPACT, "brightCyan", "bold")}\n`;
    }
    return `${LOGO_WIDE.map((line) => this.paint(line, "brightCyan")).join("\n")}\n`;
  }

  /**
   * 圆角边框面板，标题嵌在上边框内（与参考产品的版面一致）。
   * 边界按 displayWidth 计算，中文/表情不会把右边框挤歪。
   */
  panel(title: string, body: string[], options: { titleRight?: string } = {}): string {
    if (!this.decorative) return "";
    const inner = this.columns - 2;
    const titleText = title ? ` ${title} ` : "";
    const rightText = options.titleRight ? ` ${options.titleRight} ` : "";
    const fill = Math.max(0, inner - 2 - displayWidth(titleText) - displayWidth(rightText));
    const top = `╭─${titleText}${"─".repeat(fill)}${rightText}─╮`;
    const bottom = `╰${"─".repeat(inner)}╯`;
    const lines = body.map((line) => {
      const fit = truncateWidth(line, inner - 2);
      return `│ ${padEndWidth(fit, inner - 2)} │`;
    });
    return [this.paint(top, "gray"), ...lines, this.paint(bottom, "gray")].join("\n") + "\n";
  }

  /**
   * 侧栏面板：左侧吉祥物（或任意侧栏行），右侧分组条目。
   * 对应参考产品的「Available Tools」版式——左边一张图，右边一排排条目。
   *
   * @param groups 每组的 { label, items }；items 会以 `label: a, b, c` 形式渲染。
   */
  sidebarPanel(
    title: string,
    groups: Array<{ label: string; items: string[] }>,
    options: { titleRight?: string; mascot?: readonly string[]; mascotColor?: ColorName } = {},
  ): string {
    if (!this.decorative) return "";
    const mascot = options.mascot ?? MASCOT;
    const mascotWidth = Math.max(...mascot.map((l) => displayWidth(l)));
    const gutter = 3;
    const inner = this.columns - 2;

    // 右侧可用宽度 = 内宽 - 左边栏 - 间隔
    const rightWidth = Math.max(10, inner - mascotWidth - gutter - 2);

    const rightLines: string[] = [];
    for (const group of groups) {
      if (group.items.length === 0) continue;
      const label = `${group.label}:`;
      const joined = group.items.join(", ");
      // 条目按右侧宽度折行，续行缩进到条目起点
      const wrapped = wrapByWidth(joined, Math.max(8, rightWidth - label.length - 1));
      // 分组标签用暗色，让工具名本身更突出（与参考产品的视觉层级一致）
      rightLines.push(this.paint(label, "gray") + " " + (wrapped[0] ?? ""));
      for (let i = 1; i < wrapped.length; i++) {
        rightLines.push(" ".repeat(label.length + 1) + (wrapped[i] ?? ""));
      }
    }

    const rows = Math.max(mascot.length, rightLines.length);
    const body: string[] = [];
    for (let i = 0; i < rows; i++) {
      const left = mascot[i] ?? "";
      const right = rightLines[i] ?? "";
      const leftCell = padEndWidth(this.paint(left, options.mascotColor ?? "magenta"), mascotWidth + gutter);
      body.push(`${leftCell}${truncateWidth(right, rightWidth)}`);
    }

    return this.panel(title, body, options.titleRight !== undefined ? { titleRight: options.titleRight } : {});
  }

  /** 键值行：键右对齐到固定宽度，值可着色。 */
  kv(key: string, value: string, keyWidth = 12, valueColor?: ColorName): string {
    const k = padEndWidth(key, keyWidth);
    return `${this.paint(k, "gray")} ${valueColor ? this.paint(value, valueColor) : value}`;
  }

  /** 状态徽标：ok/err/info/warn 四种语义色。 */
  badge(kind: "ok" | "err" | "info" | "warn" | "muted", text: string): string {
    const map: Record<string, ColorName> = {
      ok: "green",
      err: "red",
      info: "cyan",
      warn: "yellow",
      muted: "gray",
    };
    return this.paint(text, map[kind] ?? "white");
  }

  /** 用户输入回显行。 */
  userLine(text: string): string {
    return `${this.paint("❯", "brightCyan", "bold")} ${text}`;
  }

  /**
   * 助手回答：首行带 ⏺ 标记，后续行缩进对齐到标记之后。
   * 多行文本若只给首行加标记，续行会顶到列 0，视觉上像另一段独立内容。
   */
  assistantLine(text: string): string {
    // 模型常以换行开头；若把 ⏺ 画在空行上，标记会看不见且多出一个空行。
    const lines = text.replace(/\s+$/, "").replace(/^\n+/, "").split("\n");
    const gutter = "  ";
    return lines
      .map((line, i) => (i === 0 ? `${this.paint("⏺", "green")} ${line}` : `${gutter}${line}`))
      .join("\n");
  }

  /** 工具调用通知：`⏺ list_files({"path":"."})` + 结果摘要。 */
  toolLine(name: string, args: unknown, ok: boolean, durationMs?: number): string {
    const argText = compactArgs(args);
    const status = ok ? this.paint("ok", "green") : this.paint("failed", "red");
    const dur = typeof durationMs === "number" ? this.paint(` ${durationMs}ms`, "gray") : "";
    return `  ${this.paint("⏺", ok ? "green" : "red")} ${this.paint(name, "cyan")}${argText} → ${status}${dur}`;
  }

  /**
   * 启动 spinner（仅 tui 模式）。
   *
   * 只在按下述条件绘制：stderr 也是 TTY。若 stderr 被重定向到文件，
   * 每 80ms 一次的 \r 重绘会写进日志形成大量垃圾，因此直接跳过。
   */
  startSpinner(label = "thinking"): void {
    if (!this.decorative) return;
    this.spinnerLabel = label;
    if (this.mode !== "tui") return;
    if (!this.stderrIsTty) return;
    if (this.spinnerTimer) return; // 已在运行，避免叠加多个 interval
    this.spinnerIndex = 0;
    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length] ?? "⠋";
      this.spinnerIndex++;
      this.err.write(`\r${this.paint(frame, "brightCyan")} ${this.paint(this.spinnerLabel, "gray")}\u001b[K`);
    }, 120);
    // spinner 不能阻止进程退出
    this.spinnerTimer.unref?.();
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      // 必须换行收尾：spinner 写在 stderr，答案写在 stdout，
      // 两者共享终端同一行；只写 \r 会让答案覆盖到 spinner 那一行上。
      if (this.decorative && this.stderrIsTty) this.err.write("\r\u001b[K\n");
    }
  }

  /** 清屏并回到左上角（仅 tui；用于 chat 每轮重绘）。 */
  clear(): void {
    if (this.mode !== "tui") return;
    this.out.write("\u001b[2K\r");
  }

  /** 分隔线。 */
  rule(): string {
    return this.paint("─".repeat(this.columns), "gray");
  }

  /**
   * 每轮结束后的常驻状态栏（对齐 Hermes 对话窗口底栏）。
   *
   * 版式：`⚕ model │ used/limit │ [bar] P% │ 本轮耗时 │ ⏲ 会话时长 │ ✓ 步数`
   *
   * - `usedTokens` 是本轮上下文占用（最近一次请求的 prompt+completion），
   *   与 `sessionMs` 那类累计量语义不同，不能混用。
   * - `contextLimit` 缺省时省略 limit 段与进度条：没有上限却画进度条
   *   会给出错误的「快满了」暗示。
   * - silent（管道 / --json）返回空串，绝不污染 stdout。
   * - 超宽时先丢进度条再截断，保证 model/令牌/耗时这些硬信息优先保留。
   */
  statusLine(info: StatusLineInfo): string {
    if (!this.decorative) return "";
    const limit = typeof info.contextLimit === "number" && info.contextLimit > 0 ? info.contextLimit : undefined;
    const ratio = limit ? Math.min(1, info.usedTokens / limit) : undefined;
    const sep = ` ${this.paint("│", "gray")} `;

    const withBar = (): string => {
      const parts: string[] = [];
      parts.push(`${this.paint("⚕", "brightCyan")} ${this.paint(info.model, "cyan")}`);
      parts.push(limit ? `${formatTokens(info.usedTokens)}/${formatTokens(limit)}` : `${formatTokens(info.usedTokens)} tok`);
      if (ratio !== undefined) {
        const bar = progressBar(ratio);
        // 进度条与百分比合并成一段：两者说的是同一件事，分开成两列会被 │ 隔开读成两个指标。
        // 百分比不做下限夹紧：0 令牌就该显示 0%，显示 1% 是编数据。
        const pct = ratio <= 0 ? 0 : Math.max(1, Math.round(ratio * 100));
        parts.push(`${this.paint(bar, ratio >= 0.9 ? "red" : ratio >= 0.7 ? "yellow" : "gray")} ${pct}%`);
      }
      parts.push(this.paint(formatDuration(info.turnMs), "white"));
      parts.push(`${this.paint("⏲", "gray")} ${formatDuration(info.sessionMs)}`);
      parts.push(`${this.paint("✓", "green")} ${info.steps} step(s)`);
      if (info.errorCode) parts.push(`${this.paint("✗", "red")} ${this.paint(info.errorCode, "red")}`);
      return parts.join(sep);
    };

    const line = withBar();
    if (displayWidth(line) <= this.columns) return line;
    // 超宽时去掉进度条段（比例信息仍在 usedTokens/limit 里）再试：窄终端里
    // 「还剩多少上下文」比一根条子更重要，宁可丢图形也不丢数字。
    const compact = line
      .split(sep)
      .filter((_, i) => ratio === undefined || i !== 2)
      .join(sep);
    return displayWidth(compact) > this.columns ? truncateWidth(compact, this.columns) : compact;
  }
}

export interface StatusLineInfo {
  /** 模型引用，如 `deepseek:deepseek-chat`。 */
  model: string;
  /** 本轮上下文占用令牌（prompt + completion）。 */
  usedTokens: number;
  /** 模型上下文窗口；缺省表示未知。 */
  contextLimit?: number;
  /** 本轮任务耗时。 */
  turnMs: number;
  /** 本会话总时长（首条消息到现在），来自会话记录而非进程内累加。 */
  sessionMs: number;
  /** 本轮步数（模型调用次数）。 */
  steps: number;
  /** 失败时的错误码，成功不传。 */
  errorCode?: string;
}

/** 把工具参数压成一行短摘要，避免长 JSON 撑爆版面。 */
export function compactArgs(args: unknown, max = 48): string {
  if (args === undefined || args === null) return "";
  let text: string;
  if (typeof args === "object") {
    const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
    const parts = entries.map(([k, v]) => {
      const vs = typeof v === "string" ? `"${v}"` : JSON.stringify(v);
      return `${k}:${vs}`;
    });
    text = `{${parts.join(", ")}}`;
    if (Object.keys(args as Record<string, unknown>).length > 3) text = `${text.slice(0, -1)}, …}`;
  } else {
    text = String(args);
  }
  return displayWidth(text) > max ? `${truncateWidth(text, max)}` : text;
}
