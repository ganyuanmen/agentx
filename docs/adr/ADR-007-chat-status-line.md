# ADR-007：对话窗口采用「常驻状态栏 + 会话提示符」版式

日期：2026-10-22
状态：已采纳
上游：`docs/SPEC-007-chat-window.md`

## 背景

ADR-006 落地后，`chat` 每轮只在回答下面打一行灰色 metrics
（`2 step(s) · 4820 tokens · 4.1s`），与参考产品（Hermes）的对话窗口差距在于：

- 没有「常驻底栏」——那段信息读起来像日志尾巴，不像界面的一部分；
- 上下文占用（占了多少 / 还剩多少）完全不可见；
- 提示符是一个光秃秃的 `❯`，看不出当前在哪个会话。

## 决策

1. 每轮固定三段收尾：`回答 → 分隔线 → 状态栏 → 分隔线`。
2. 状态栏字段固定为 6 段（顺序不可变）：
   `⚕ model │ used/limit │ [bar] P% │ 本轮耗时 │ ⏲ 会话累计 │ ✓ 步数`，
   失败时末尾追加 `✗ ERROR_CODE`。
3. 提示符带上会话短 id（`ses_8e8a ❯`），`/new` 后必须刷新。
4. 启动横幅瘦身：去掉与提示符重复的 commands 整行。

## 关键实现约束（都是踩过的坑）

### 上下文占用必须取「最后一步」而不是本轮累加

`AgentResult.usage` 是整个任务的累加值。一个 3 步任务里每一步都会把完整历史再发一次，
累加值大约是真实上下文的 3 倍，拿它算占用会让进度条虚高一倍以上。

因此 `AgentLoop` 新增 `onStepEnd` 钩子，每步上报该步 usage，CLI 只保留最后一步。
这**没有**改动 `AgentResult` 的冻结签名（PM_SPEC §4）。

### `process.stdout.columns` 可能是 0，不是 undefined

真实终端里它有值，所以旧代码 `Math.max(40, Math.min(columns ?? 80, 100))` 一直没出问题。
但在 `pty.fork()` 出来、未设置窗口大小的会话里它是 **0**，`??` 不会拦截 0，
整块面板被压到 40 列下限——实测面板宽度只剩 42 列、状态栏被截成 `1ms │ ⏲ 67m…`。

现在统一走 `resolveColumns()`：0 / 负数 / NaN 一律视为「未知」，依次退回
`COLUMNS` 环境变量、再退回 80 列。这条路径**只有真实 PTY 能测出来**，
用 `spawn` + pipe 测不到（pipe 下 stdout 不是 TTY，直接走 silent 分支，
状态栏压根不渲染）——所以 TUI 改动的验收必须包含一次真实 PTY 跑。

### ANSI 截断不能按字符切

`truncateWidth` 原来逐字符遍历，会把 `\u001b[36m` 切成 `\u001b[3`，
终端里显示乱码且颜色不外泄。现在按转义序列整段保留，并在截断点补 `ANSI.reset`。

### 宽度不够时先丢进度条

窄终端里 `used/limit` 的比值已经表达了「用了多少」，进度条是冗余图形。
`statusLine` 超宽时先去掉进度条段再重试，最后才走 `truncateWidth`。

### 百分比不夹下限

`usedTokens: 0` 必须显示 `0%`。曾用 `Math.max(1, ...)` 保证「有一点点占用」也可见，
但那会让空上下文显示「1% 已用」——是编数据。现在只有比例 > 0 时进度条才点亮至少一格。

### TTY 下不再重复回显用户输入

`readline({terminal: true})` 自己已经把「提示符 + 输入」画在屏幕上，
再 `write(ui.userLine(line))` 就是两遍（真实 PTY 里肉眼可见的重复行）。
现在只有非 TTY 的 plain 模式才自己回显。

## 后果

- 新增 `formatTokens` / `formatDuration` / `progressBar` / `resolveColumns` /
  `Ui.statusLine()`（`packages/cli/src/ui.ts`）；
- `packages/core/src/loop.ts` 新增可选 `onStepEnd` 钩子（向后兼容，不传则无行为变化）；
- `packages/cli/src/main.ts` 新增 `promptFor()`、`sessionWorkMs()`；
- 新增测试 `packages/cli/tests/status-line.test.ts`（36 项），
  `ui.test.ts` 补 logo 54/53 列边界；
- 管道输出（silent）逐字节不变：`statusLine()` 在 non-TTY / `--json` 下返回空串。
