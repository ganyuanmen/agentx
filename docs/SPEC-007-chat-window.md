# SPEC-007：对话窗口对齐 Hermes（状态栏 / 启动横幅 / 输入提示符）

状态：待实现
日期：2026-10-22
上游需求：用户提供 Hermes 截图，要求 `agentx chat` 的对话窗口"类似 hermes"。

---

## 1. 目标

把 `agentx chat` 的 TUI 从「每轮只打一行 metrics」升级为「每轮结束后有一条常驻状态栏 + 启动横幅紧凑 + 提示符带会话名」，与 Hermes 的对话窗口视觉与信息层级一致：

```
> 你好

⚠️  Normalized model 'deepseek-flash' to 'deepseek-chat' for deepseek.
Initializing agent...
──────────── (分隔线)
─  ⚕ Hermes  ────────…
<回答正文>
──────…
⚕ deepseek-chat │ 19.2K/1M │ [░░░░░░░░░░] 2% │ 15s │ ⏲ 2s │ ✓ 0s
──────…
project-router ❯
```

### 非目标（本 SPEC 明确不做）

- 不做流式输出（PM_SPEC D3 冻结）、不改 provider 接口。
- 不引入任何新依赖（ink/blessed 等），不引入 HTTP。
- 不改 `--json` / 管道输出（silent 模式必须逐字节保持不变）。
- 不做 ⇅/⇆ 方向键历史浏览（readline 自带上下箭头已够用）。
- 不改 `run` 命令的 stdout 契约。
- 不做模型名归一化提示（那是用户所用产品的一句话，agentx 没有归一化逻辑）。

---

## 2. 用户角色

| 角色 | 关注点 |
|---|---|
| 本地交互用户（TTY） | 一眼看到：当前模型、上下文占用、本轮耗时、本会话累计耗时、结果状态 |
| 管道/脚本用户 | 输出不含任何装饰（silent 模式不变）→ 本 SPEC 不得触碰 |

## 3. 核心行为（TUI 模式）

### 3.1 每轮固定 5 段（顺序固定）

1. `❯ <用户输入>`（现有 userLine，不变）
2. 工具行（现有 toolLine，已有则照旧；无工具则跳过）
3. 回答正文（现有 assistantLine，不变；失败时现有 failed 徽标）
4. **分隔线**（`ui.rule()`，灰色，宽度 = columns）
5. **状态栏**（新 `ui.statusLine()`）+ 其下再一条分隔线

即：`回答 → ───── → 状态栏 → ─────`（Hermes 截图里的下边框 + 状态栏 + 上边框三段）。

### 3.2 状态栏字段（严格按此顺序，`│` 分隔）

| 段 | 内容 | 数据来源 |
|---|---|---|
| 1 | `⚕ <modelRef>` | `prep.modelRef`（已有） |
| 2 | `<已用>/<上限>` 令牌，如 `19.2K/64K` | 本轮 `usage.totalTokens` + 最近一步 `usage.promptTokens`+`usage.completionTokens` 作为上下文占用；上限取 `ModelInfo.contextLimit`，缺省 `?` |
| 3 | `[░░░░░░░░░░] 2%` 10 格进度条 | 上下文占用 / 上限，四舍五入到整数，下限 1 格（>0 时） |
| 4 | `<本轮耗时>` 如 `15s` | `result.durationMs` |
| 5 | `⏲ <会话累计>` | 本进程内 `Σ durationMs` |
| 6 | `✓ <空转/等待>` | 本进程内 `Σ (inter-turn gap)`；首轮为 `0s` |
| 7 | 失败时末尾追加 `✗ <errorCode>` | `result.errorCode`；成功不出现 ✓/✗ 冲突：成功段固定 ✓ |

- 时长格式化：`<1000ms` 显示 `xxms`，`<60s` 显示 `x.xs`，否则 `Xm YYs`。
- 令牌格式化：`<1000` 原样，`<1e6` 用 `19.2K`，否则 `1.2M`。
- 无颜色模式（plain）下同样输出该行，只是无 ANSI。

### 3.3 启动横幅（缩小）

- **宽度自适应**：`LOGO_WIDE` 实测最宽 52 列，但现在固定 `columns>=60` 才用；改为按 logo 实际宽度 + 2 决定（≥54 用大号），窄终端用 `LOGO_COMPACT`。
- **去掉重复的 commands 行**：`/help` 等命令已在 `rl.prompt()` 之前提示，面板最后一行改为 `tools` 数量汇总，节省一行高度。
- 面板内容顺序：model / cwd、tools 分组、session、mode（read-only|read-write）。

### 3.4 提示符

- TTY 下提示符为 `<sessionShort> ❯ `（如 `ses_1234 ❯ `），颜色青色；`plain` 下为 `<sessionShort>> `。
- `/new` 后提示符必须刷新为新会话短 id（当前实现 `prompt` 是 createInterface 时定死的，`/new` 后不会变 → 必须改成可变）。
- 非 TTY 保持 `agentx> `。

## 4. 状态转换

| 状态 | 触发 | 影响 |
|---|---|---|
| idle → running | 回车提交一行 | spinner 启动；`turnStartedAt` 记录 |
| running → rendered | 任务返回 | 输出 3.1 的第 3-5 段；累计 `sessionDuration` 与 `turnGap` 更新 |
| running → failed | 任务失败 | 追加 `✗ errorCode`，退出码语义不变 |
| session 切换 | `/new` | 重置 `turns`、`sessionDuration`、`turnGap`，刷新提示符 |
| 退出 | `/exit`、Ctrl+D、EOF | 现有 footer 不变 |

## 5. 权限规则

无变化。状态栏只读渲染，不新增任何工具调用或网络请求。

## 6. 边界情况

| 编号 | 场景 | 期望 |
|---|---|---|
| E1 | `columns` < 54 | 用紧凑 logo；状态栏超宽时按 `displayWidth` 截断，不折行、不撑破边框 |
| E2 | 中文/emoji 出现在状态栏字段（如 cwd 含中文） | 用 `displayWidth` 计算；不出现错位 |
| E3 | `contextLimit` 缺省 | 显示 `19.2K/?`，进度条与百分比段直接省略（只留令牌数） |
| E4 | 上下文占用 > 上限 | 百分比夹到 100%，进度条全满 `██████████` |
| E5 | 首轮 | `⏲ 0s`、`✓ 0s`；不出现 `NaN` |
| E6 | `NO_COLOR=1` / `TERM=dumb` | 输出同样 5 段，无 ANSI；无 spinner |
| E7 | 管道 `printf 'hi\n/exit\n' \| agentx chat` | 与改动前逐字节一致（只输出答案 + 尾行提示不存在） |
| E8 | `--json` | 每轮一行 JSON，不含任何状态栏 |
| E9 | 任务失败 | 状态栏末尾有 `✗ <code>`，且原有 failed 徽标与 stderr 摘要仍在 |
| E10 | `/new` 后 | 提示符 id 变化；`⏲`/`✓` 归零 |
| E11 | 非 TTY 的 chat | 提示符仍为 `agentx> `，不打横幅、不打状态栏 |

## 7. 验收标准（AC）

- **AC1** `ui.statusLine()` 存在，输入 `{model, usedTokens, contextLimit, progress?}` 与本轮/累计时长，输出单行、以 `│` 分隔、含 `⚕` 与 7 段结构；纯函数级可断言。
- **AC2** 成功轮在 TUI 下输出顺序恰为：userLine → 可能的 toolLine → assistantLine → rule → statusLine → rule（用字符串断言轮次之间的相对位置）。
- **AC3** 失败轮的状态栏包含 `✗` 与该轮 `errorCode`。
- **AC4** `formatTokens(19240) === "19.2K"`、`formatDuration(920) === "920ms"`、`formatDuration(15000) === "15s"`、`formatDuration(65000) === "1m 05s"`；进度条 `progressBar(0.02)` 长度为 12（10 格 + 方括号）。
- **AC5** `contextLimit` 缺失时不出现 `%` 段与进度条。
- **AC6** `columns=50` 时 `ui.logo()` 返回紧凑版单行；`columns=100` 返回 6 行大号。
- **AC7** 提示符在 `/new` 前后不同（用导出的 `promptFor(sessionId, ui)` 断言）。
- **AC8** silent 模式：`ui.statusLine(...)` 返回空串；`ui.rule()` 已返回空串（现状保持）。
- **AC9** 全量 `pnpm verify`（build + typecheck + test-gate）通过；`tests/acceptance.test.ts` 与 E2E 不回归。
- **AC10** 管道 E2E 实测：`printf 'hi\n' | node packages/cli/bin/agentx.js chat --model mock:mock-1` 的 stdout 只有答案行。

## 8. 预期测试

新增 `packages/cli/tests/status-line.test.ts`：

1. `formatTokens` / `formatDuration` / `progressBar` 纯函数表格（含 0、边界 999/1000、59.9s、60s、1e6）。
2. `ui.statusLine` 7 段结构与 `│` 计数；CJK 场景宽度不超 columns。
3. `statusLine` 在 `silent` 模式下返回 `""`；`plain` 无 ANSI。
4. `contextLimit` 缺失 / 超限夹紧。
5. 失败态追加 `✗`。

扩展 `packages/cli/tests/ui.test.ts`：logo 宽度分支改按 54 列断言（原 60 列的用例需同步更新，并补 `columns=54/53` 边界）。

人工/E2E：`tests/e2e-run.test.ts` 增加 chat 管道断言（若已有 chat 管道用例则复用）。
