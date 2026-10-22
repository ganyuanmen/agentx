# agentx

A local, command-line AI agent framework for Node.js 22+. You give it a task in the terminal; it
builds context, calls a model, runs tools (files, search, shell), enforces a policy on every tool
call, and persists the conversation in SQLite.

**Scope: local CLI only.** agentx never starts a server, never listens on a port, and has no HTTP
API, Web UI, or message-channel integration. Its only network activity is outbound HTTPS to the
model provider you configure. See [Scope statement](#scope-statement).

---

## Features

- **Agent loop with explicit limits** — `maxSteps`, task `timeoutMs`, optional token budget, and a
  per-task tool-call cap. Every task ends with a `status`, a `terminationReason`, and an
  `AgentResult` that is also written to the database.
- **Providers behind one interface** — `deepseek`, `openai-compatible` (any `/v1/chat/completions`
  endpoint), and `mock` (deterministic, for tests). Non-streaming only: `generate() -> ModelResponse`.
- **Tools with policy** — `read_file`, `list_files`, `search_text`, `write_file`, `apply_patch`,
  `exec`, `memory_search`. Every call goes through an allow-list → read-only → approval decision
  before it executes.
- **Approval, not surprises** — `exec` is `riskLevel: high`, so it asks before running. In a
  non-interactive shell it fails fast with exit code `3` instead of hanging.
- **Persistent sessions** — SQLite (`node:sqlite`, no native build step) with versioned
  migrations; `sessions list|show|delete`.
- **Local skills** — Markdown `SKILL.md` files with YAML frontmatter, discovered from
  `<repo>/skills` plus any `skills.dirs`; matched by keyword or loaded explicitly with `--skill`.
- **Markdown memory** — notes under `~/.agentx/memory/`, searchable by the `memory_search` tool.
- **Credential hygiene** — `config show`, `models list`, `doctor`, and all logs report only
  *whether* a key is configured, never its value.
- **Self-diagnosis** — `agentx doctor` runs eight local checks and exits non-zero on failure.

---

## Requirements

- **Node.js >= 22** (uses built-in `node:sqlite` and `fetch`; agentx refuses to rely on older
  versions — `agentx doctor` fails if the major version is below 22).
- **pnpm 11** as the package manager for the monorepo.
- POSIX shell for the default `exec` tool (macOS, Linux, WSL).

---

## Install

```bash
pnpm install
pnpm build          # tsc -b across all packages
```

Run the CLI straight from the repo:

```bash
node packages/cli/bin/agentx.js --help
# or via the pnpm script
pnpm agentx --help
```

Optional: put it on your `PATH`.

This repo is a **pnpm workspace**: every package is `private` and depends on its siblings via
`workspace:*`, and `@agentx/cli` is not published to npm. That rules out the two obvious
approaches — `pnpm --filter ... link --global` fails with `Unknown option: 'recursive'`
(`pnpm link` accepts a single `<dir>`, never `--filter`), and linking the sub-package on its own
fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` because `workspace:*` cannot resolve outside the
workspace root.

Use one of these instead, from the repo root after `pnpm install && pnpm build`:

```bash
# 1) No install at all — just run the entry point (most reliable)
node packages/cli/bin/agentx.js --help
pnpm agentx --help                      # same thing, via the root script

# 2) A shell alias, keeps the working tree authoritative
alias agentx='node /absolute/path/to/agentx/packages/cli/bin/agentx.js'

# 3) Global `agentx` on PATH (npm resolves the workspace symlinks correctly)
cd packages/cli && npm link            # undo with: npm unlink -g @agentx/cli
```

Whichever you pick, `pnpm build` must have run first — `dist/` is not committed.

If you only want a binary on another machine, do **not** clone and build: use the offline
release tarball from `scripts/package-release.sh` instead (see `DEPLOY.md` inside it).

### First run

Put the key in `~/.agentx/.env` — it is read automatically, so the secret never has to live
in your shell environment or shell rc files:

```bash
mkdir -p ~/.agentx
cat > ~/.agentx/.env <<'EOF'
DEEPSEEK_API_KEY=sk-...
EOF
chmod 600 ~/.agentx/.env          # agentx warns if this file is readable by others

agentx doctor
```

Precedence: real process environment > `~/.agentx/.env` > `providers.<id>.apiKey` in
`config.json`. That means `export DEEPSEEK_API_KEY=...` in a single shell still overrides
the file for a one-off run, without editing anything on disk.

`doctor` tells you exactly what is missing before you spend a single token.

---

## Quick start

### One-shot task

```bash
node packages/cli/bin/agentx.js run "Summarise the TODOs in this repo's README"
```

```
agentx run "list every *.ts file under packages/core/src"
agentx run --model mock:mock-1 "hello"                      # no network, deterministic provider
agentx run --read-only "explain what packages/tools/src/exec.ts does"
agentx run --session ses_1234 "now refactor it"
agentx run --json "count the test files" | jq .status
```

Progress and debug output go to **stderr**; the final answer goes to **stdout**, so piping stays
clean. With `--json`, stdout is exactly one line of JSON.

### Interactive chat

```bash
agentx chat
```

```
█████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗  ██╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝╚██╗██╔╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║    ╚███╔╝
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║    ██╔██╗
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██╔╝ ██╗
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝
╭─ agentx v0.1.0 · local CLI agent ───────────────────────────── TUI ─╮
│   ▄█▀▀█▄  ▄█▀▀█▄     model: deepseek-chat, ~/work/api                │
│  ██▄▄▄▄████▄▄▄▄██    file: read_file, list_files, write_file, ...    │
│  ████████████████    search: search_text, memory_search              │
│  ██▀▀▀▀██▀▀▀▀██      exec: exec                                      │
│  ██ ██ ████ ██       session: ses_8e8a, read-write                   │
│  ██████████████      help: /help · commands                          │
│   ██ ██████ ██                                                      │
│    ██████████                                                       │
╰─────────────────────────────────────────────────────────────────────╯
ses_8e8a ❯ find all functions that call exec()
  ⏺ search_text{pattern:"exec("} → ok 12ms
⏺ Three call sites: src/runner.ts:88, src/tools/exec.ts:31, src/cli.ts:142
──────────────────────────────────────────────────────────────────────
⚕ deepseek-chat │ 4.8K/65.5K │ [█░░░░░░░░░] 7% │ 4.1s │ ⏲ 4.1s │ ✓ 2 step(s)
──────────────────────────────────────────────────────────────────────
```

Interface elements:

| Element | Meaning |
|---|---|
| Mascot + grouped list | tools grouped by function, current model, cwd, session, mode |
| `<ses_id> ❯` | your input — the prompt carries the session's short id |
| `⏺ tool{args} → ok 3ms` | a tool call that actually ran, with real duration |
| `⏺ answer` | the model's final answer |
| `─────` + status line | the persistent status bar under each turn (see below) |

The status bar is printed after every turn, between two rules:

```
⚕ deepseek:deepseek-chat │ 19.2K/65.5K │ [███░░░░░░░] 29% │ 15.0s │ ⏲ 2.0s │ ✓ 1 step(s)
```

| Segment | Meaning |
|---|---|
| `⚕ model` | the model reference for this session |
| `19.2K/65.5K` | context used by the last request vs. the model's window (`tok` instead when the window is unknown) |
| `[███░░░░░░░] 29%` | the same ratio as a 10-cell bar; dropped first when the terminal is too narrow |
| `15.0s` | wall-clock duration of this turn |
| `⏲ 2.0s` | time the agent has spent working in this session (sum of task durations) |
| `✓ 1 step(s)` | model calls in this turn |
| `✗ ERROR_CODE` | appended only when the turn failed |

All numbers come from the task record and the SQLite session — nothing is estimated. In a
non-TTY or `--json` run the status bar is not printed at all, so piping stays clean.

### `agentx agent <name> chat` / `agentx <name> chat`

Run as a **named agent**: a persistent identity (`SOUL.md`) plus its own skills.

```bash
agentx agent init reviewer        # scaffold ~/.agentx/agents/reviewer/
$EDITOR ~/.agentx/agents/reviewer/SOUL.md
agentx reviewer chat              # equivalent to: agentx agent chat reviewer
agentx reviewer run "review src/cli.ts"
```

An agent lives in `~/.agentx/agents/<name>/`:

```
~/.agentx/agents/reviewer/
├── SOUL.md            # required: YAML frontmatter + body
├── config.json        # optional: overrides the global config for this agent
└── skills/            # optional: one SKILL.md per subdirectory
```

`config.json` uses **exactly the same fields as `~/.agentx/config.json`** — write only what you
want to change:

```json
{
  "defaultModel": "deepseek:deepseek-chat",
  "policy": { "approval": "high" },
  "tools": { "allow": ["read_file", "list_files", "search_text"] },
  "maxSteps": 8
}
```

Precedence, highest first:

| Level | Source |
|---|---|
| 1 | command line (`--model`, `--read-only`, …) |
| 2 | environment variables (`AGENTX_MODEL`, …) |
| 3 | **`<agent>/config.json`** |
| 4 | `~/.agentx/config.json` |
| 5 | built-in defaults |

`agent init` writes a working `config.json` for you. `--force` never overwrites it — only
`SOUL.md` — because a tuned model/policy set is costlier to lose than the scaffold text.
`agentx agent show <name>` reports which config file is in effect.

`SOUL.md` frontmatter:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Must equal the directory name |
| `description` | yes | One-line summary for `agent list` |
| `model` | no | Overrides the default model for this agent |
| `skills` | no | Whitelist; when present only these skills load |

The body is the agent's identity and is injected **first** in the system prompt, ahead of the
framework description and the security rules — so a SOUL cannot weaken the safety constraints.

| Command | Meaning |
|---|---|
| `agentx agent list` | name, skill count, description; broken definitions show `INVALID` |
| `agentx agent show <name>` | full definition including the SOUL body |
| `agentx agent init <name>` | scaffold; refuses to overwrite without `--force` |
| `agentx agent chat <name>` | chat as the agent (also `agentx <name> chat`) |
| `agentx agent run <name> <prompt>` | one-shot task as the agent (also `agentx <name> run`) |

Agent names are restricted to letters, digits, `.`, `_` and `-`; path separators are rejected.
Extra agent directories can be added with `agents.dirs` in the config.

Slash commands: `/help` `/new` `/sessions` `/tools` `/exit` (also `/quit`, or Ctrl+D).

The interface adapts to where it runs, so scripting is never polluted (see
`docs/adr/ADR-006-tui-fallback.md`):

| Environment | Behaviour |
|---|---|
| real terminal | full UI: logo, mascot panel, colour, spinner |
| `NO_COLOR=1` or `TERM=dumb` | same layout, no ANSI colour, no spinner |
| piped / redirected / `--json` | **answer only** — `agentx chat < input.txt > answer.txt` stays clean |

Piping lines in works too — chat reads until EOF and exits, it never hangs waiting for a TTY.

### Inspect state

```bash
node packages/cli/bin/agentx.js doctor
node packages/cli/bin/agentx.js config show
node packages/cli/bin/agentx.js models list
node packages/cli/bin/agentx.js tools list
node packages/cli/bin/agentx.js sessions list
```

---

## Commands

Global options, accepted before or after the subcommand:

| Option | Meaning |
|---|---|
| `--json` | Emit a single machine-readable JSON line on stdout (progress stays on stderr). |
| `--verbose` | Debug-level logging to stderr and the log file. |
| `--version` / `-h, --help` | Print version / help and exit `0`. |

### `agentx run <prompt>`

Run one task and exit.

| Option | Meaning |
|---|---|
| `--model <model>` | Model reference, `providerId:modelId` or a bare model id (default: `defaultModel`). |
| `--session <id>` | Continue an existing session instead of creating one. |
| `--cwd <dir>` | Working directory for the task and its tools. |
| `--max-steps <n>` | Maximum agent loop steps (integer >= 1). |
| `--timeout <ms>` | Task timeout in milliseconds (integer >= 1). |
| `--yes` | Auto-approve tools that require approval (allow-list and read-only checks still apply). |
| `--read-only` | Deny any tool with side effects (`write_file`, `apply_patch`, `exec`). |
| `--exclude-tools <names>` | Comma-separated tool names to unregister for this run. |
| `--skill <name>` | Load a skill by name; repeatable. |
| `--json` | One JSON result line on stdout. |
| `--verbose` | Debug logging. |

### `agentx chat`

Interactive REPL, one task per line. Same options as `run` (plus `--json` = one JSON line **per
turn**), without the `<prompt>` argument.

### `agentx sessions list`

| Option | Meaning |
|---|---|
| `--limit <n>` | Maximum number of sessions (integer >= 0). |
| `--json` | Print a JSON array. |
| `--verbose` | Debug logging. |

### `agentx sessions show <id>`

| Option | Meaning |
|---|---|
| `--json` | Print the full session (metadata + messages) as JSON. |
| `--verbose` | Debug logging. |

### `agentx sessions delete <id>`

| Option | Meaning |
|---|---|
| `--yes` | Skip the confirmation prompt. |
| `--json` | Print a single JSON result line (`{deleted, id}`). |
| `--verbose` | Debug logging. |

Without `--yes` in a non-interactive shell the delete is refused with exit code `3` — nothing is
removed. In a terminal you get a `[y/N]` prompt.

### `agentx tools list`

Lists every registered tool with its risk level, whether it has side effects, whether it is in
`tools.allow`, and whether it needs approval under the current policy.

| Option | Meaning |
|---|---|
| `--json` | Print a JSON array. |
| `--verbose` | Debug logging. |

### `agentx skills list`

Scans the configured skill directories (plus the built-in `skills/` folder) and prints each
`SKILL.md`. Invalid skills are skipped with a warning on stderr; they never break the listing.

| Option | Meaning |
|---|---|
| `--json` | Print a JSON array. |
| `--verbose` | Debug logging. |

### `agentx config show`

Prints the **effective** configuration — defaults, then `~/.agentx/config.json`, then environment
overrides — with every credential-shaped value replaced by `"***"`. It also reports the config
path and which sources contributed.

| Option | Meaning |
|---|---|
| `--json` | Print `{config, home, sources}` as JSON (still redacted). |
| `--verbose` | Debug logging. |

### `agentx models list`

One row per provider in `config.providers`: id, type, default model, all models, and whether an
API key is configured (`configured (config)`, `configured (env:DEEPSEEK_API_KEY)`, `missing`, or
`not-required` for `mock`). `*` marks the provider serving `defaultModel`.

| Option | Meaning |
|---|---|
| `--json` | Print a JSON array. |
| `--verbose` | Debug logging. |

### `agentx doctor`

Runs eight local checks and prints a table (`CHECK` / `STATUS` / `DETAIL`):

| Check | What it verifies |
|---|---|
| `node-version` | `process.versions.node` major >= 22. |
| `config` | `config.json` parses and validates; prints path and sources (`defaults`, file, `env`). |
| `home-writable` | Writes a probe file under `<home>/logs/`, then deletes it. |
| `database` | Opens `<home>/data/agentx.sqlite`, runs migrations, reads `PRAGMA user_version`. |
| `skills` | Skill count and number of skipped-skill warnings. |
| `tools` | Registered tool count vs. `tools.allow` (names in `allow` that don't exist → `WARN`). |
| `api-key` | Default provider's key is `configured` or `missing` — the value is never printed. |
| `logs` | Log directory exists and the newest log file is reported. |

`PASS` = fine, `WARN` = works but you should look, `FAIL` = broken. Exit code `0` when no check
fails, `1` otherwise. `--json` emits `{ok, checks:[{name,status,detail}]}`.

**`doctor` makes no network requests.** It does not ping the model endpoint — that is what
`agentx run` is for.

---

## Configuration

Config lives at `~/.agentx/config.json` (override the directory with `AGENTX_HOME`). Everything is
optional; sensible defaults apply. The file is validated strictly by Zod and **unknown keys are
rejected** — a typo surfaces as a `CONFIG_INVALID` error naming the field.

```json
{
  "defaultModel": "deepseek-chat",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-chat"]
    }
  },
  "maxSteps": 12,
  "policy": { "approval": "high" },
  "tools": { "allow": ["read_file", "list_files", "search_text"] }
}
```

A complete starting point is in [`config.example.json`](./config.example.json):

```bash
mkdir -p ~/.agentx && cp config.example.json ~/.agentx/config.json && chmod 600 ~/.agentx/config.json
```

Prefer `apiKeyEnv` over inline `apiKey` — it keeps the secret out of the file entirely. Environment
overrides (`AGENTX_MODEL`, `AGENTX_CWD`, `AGENTX_READ_ONLY`, `AGENTX_LOG_LEVEL`, `AGENTX_HOME`)
apply only to non-secret settings.

Full field-by-field reference: **[docs/configuration.md](./docs/configuration.md)**.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (task succeeded, command completed, all doctor checks passed). |
| `1` | Failure — task failed/timed out, or a check/inspection command hit an error. |
| `2` | Usage error — bad option value, unknown model, invalid or unreadable config. |
| `3` | Approval required — a tool needed approval but no interactive terminal was available; `sessions delete` without `--yes` off a TTY. |
| `130` | Cancelled — Ctrl+C during a task. |

`--json` payloads carry `status`, `terminationReason` and, on failure, `errorCode` from the table in
[docs/architecture.md](./docs/architecture.md#error-codes), so scripts can branch on the cause
rather than parse prose.

---

## Repository layout

```
.
├── packages/
│   ├── core/       @agentx/core       protocols, error codes, agent loop, runtime, config, logger, mock provider
│   ├── providers/  @agentx/providers  OpenAI-compatible adapter + DeepSeek + provider factory
│   ├── tools/      @agentx/tools      tool registry, file/search tools, exec, PolicyEngine, executor
│   ├── store/      @agentx/store      SQLite session/task store, migrations, Markdown memory
│   ├── skills/     @agentx/skills     SKILL.md discovery and matching
│   └── cli/        @agentx/cli        commander command layer, src/wiring.ts, bin/agentx.js
├── skills/                            built-in skills (code-review, server-diagnostics, software-development)
├── tests/                             cross-package E2E (real processes)
├── docs/
│   ├── architecture.md                module boundaries, data protocols, state machine, error codes, ADRs
│   ├── configuration.md               every config field + env overrides
│   └── troubleshooting.md             common failures and fixes
├── config.example.json
└── package.json                       pnpm workspace root
```

Runtime data lives outside the repo, under `~/.agentx/`:

```
~/.agentx/
├── config.json      optional; 0600
├── data/            agentx.sqlite (+ -wal/-shm); 0700
├── logs/            agentx-YYYY-MM-DD.log (JSON lines)
├── memory/          Markdown notes for memory_search
└── skills/          your own skills
```

---

## Troubleshooting

Start with `agentx doctor`. Quick pointers:

| Symptom | Where to look |
|---|---|
| `PROVIDER_FAILED` / 401 / connection refused | Key not set, or endpoint unreachable → [troubleshooting §1](./docs/troubleshooting.md#1-api-key-not-configured) |
| `POLICY_DENIED` on a tool you need | Tool missing from `tools.allow` → [§3](./docs/troubleshooting.md#3-a-tool-is-rejected-by-policy) |
| `READ_ONLY_VIOLATION` | `--read-only` / `readOnly: true` is on → [§4](./docs/troubleshooting.md#4-read-only-mode-blocks-a-write-i-expected-to-work) |
| Exit code `3` in CI | Approval needed with no TTY → [§6](./docs/troubleshooting.md#6-approval-required-in-a-non-interactive-shell) |
| `database disk image is malformed` | Corrupt SQLite → [§5](./docs/troubleshooting.md#5-session-database-is-corrupt) |
| "Where are the logs?" | `<home>/logs/agentx-YYYY-MM-DD.log` → [§7](./docs/troubleshooting.md#7-where-are-the-logs) |

---

## Scope statement

agentx is a **local command-line tool**. By design:

- No HTTP server, no REST/SSE/WebSocket endpoint, no port listening (not even `127.0.0.1`).
- No web UI, no chat-platform integrations, no multi-tenant or billing features.
- No HTTP framework dependencies (`express`, `fastify`, `koa`, `hono`, `ws`, …). The dependency
  list is `commander`, `pino`, `zod`, plus workspace packages.
- No container sandbox: `exec` runs on the host under a policy, not in a sandbox.
- No streaming output: providers implement a single `generate()` call that returns a complete
  response.
- Network access happens in exactly one place — the provider adapter making an outbound HTTPS
  request to `baseUrl`.

This is verified mechanically; see [docs/architecture.md § Verification](./docs/architecture.md#ac13-verification-no-server-no-http).
