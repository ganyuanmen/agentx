# Configuration

agentx is configured by a single optional JSON file plus a handful of environment variables.
Everything has a default, so a fresh install with `DEEPSEEK_API_KEY` set works with no config file
at all.

---

## 1. Where config lives

| Path | Purpose |
|---|---|
| `<home>/config.json` | The config file. **Optional.** |
| `<home>` | `$AGENTX_HOME` if set, otherwise `~/.agentx`. |

Resolution order (later wins):

```
1. built-in defaults            (always present)
2. <home>/config.json           (if the file exists)
3. environment variables        (AGENTX_* — non-secret settings only)
4. command-line options         (--model, --cwd, --read-only, --verbose)
```

`agentx config show` prints which sources actually contributed:

```
home:    /root/.agentx
config:  /root/.agentx/config.json (not present)
sources: defaults
```

Create one from the shipped example:

```bash
mkdir -p ~/.agentx
cp config.example.json ~/.agentx/config.json
chmod 600 ~/.agentx/config.json
```

The directory layout agentx creates and uses inside `<home>`:

```
<home>/
├── config.json            optional, 0600
├── data/                  agentx.sqlite + -wal/-shm, dir 0700
├── logs/                  agentx-YYYY-MM-DD.log (JSON lines)
├── memory/                Markdown notes for the memory_search tool
└── skills/                your own SKILL.md directories
```

### Validation is strict

The file is parsed as JSON and validated with Zod. Two consequences worth knowing:

- **Unknown keys are rejected.** A typo like `maxStep` is an error, not a silently ignored field.
  `agentx` exits `2` with `CONFIG_INVALID` naming the field path, e.g.
  `providers.deepseek.maxRetries: Expected number, received string`.
- **Wrong types are rejected** rather than coerced. `"maxSteps": "12"` fails; use `12`.

---

## 2. Field reference

### Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultModel` | `string` | `"deepseek-chat"` | Model used when `--model` is absent. Either a bare model id or `providerId:modelId`. |
| `providers` | `object` | `deepseek`, `local`, `mock` | Map of provider id → provider config. See below. |
| `cwd` | `string` | `"."` | Working directory for tasks and tools. Relative paths resolve against the process CWD. `--cwd` overrides. |
| `readOnly` | `boolean` | `false` | Global read-only mode: denies every side-effecting tool. `--read-only` overrides (can only turn it on). |
| `maxSteps` | `integer` 1–100 | `12` | Maximum model turns per task. Hitting it ends the task with `MAX_STEPS_EXCEEDED`. `--max-steps` overrides. |
| `timeoutMs` | `integer` > 0 | `300000` | Wall-clock deadline for a whole task. `--timeout` overrides. |
| `maxTotalTokens` | `integer` >= 0 | `0` | Token budget summed across steps. `0` = unlimited. Exceeding it ends the task with `BUDGET_EXCEEDED`. |

### `providers.<id>`

The key is the provider id you use in `--model` (`deepseek:deepseek-chat`) and in
`agentx models list`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `"deepseek"` \| `"openai-compatible"` \| `"mock"` | *(required)* | Adapter to use. `mock` needs no network or key. |
| `baseUrl` | URL string | `deepseek`: `https://api.deepseek.com`; others: *(required for `openai-compatible`)* | API root. For OpenAI-compatible servers include the version segment, e.g. `http://127.0.0.1:8000/v1`. |
| `apiKey` | `string` | *(none)* | Inline credential. Avoid — prefer `apiKeyEnv`. |
| `apiKeyEnv` | `string` | *(none)* | Name of an environment variable holding the key. Takes effect only if `apiKey` is unset. |
| `models` | `string[]` (min 1) | *(required)* | Model ids this provider serves. The first entry is the provider's default model. |
| `maxRetries` | `integer` 0–10 | `2` | Retries for retryable failures (429, 5xx, network). 401/403 are never retried. |
| `timeoutMs` | `integer` > 0 | `120000` | Per-request timeout for a single model call. |

Resolution of `defaultModel` / `--model`:

1. Contains a colon → `providerId:modelId`, provider looked up by id.
2. Matches an entry in some provider's `models` → that provider.
3. Matches a provider id → that provider's first model.
4. Otherwise → the first configured provider, with the string passed through as the model id.

Unresolvable references fail before any request with exit code `2`.

### `policy`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `approval` | `"none"` \| `"high"` \| `"all"` | `"high"` | Which calls need confirmation. `none` = never ask. `high` = tools with `riskLevel: "high"` (currently `exec`). `all` = every tool with side effects. |
| `requireApprovalFor` | `string[]?` | *(unset)* | Reserved for naming additional tool names that always need approval. |

Approval only *asks*. It never overrides the allow-list or read-only checks — see
[architecture.md § Permission decision order](./architecture.md#5-permission-decision-order-d4).
In a non-interactive shell with no approver available, a call that needs approval fails the task
with `APPROVAL_REQUIRED` and exit code `3`. `--yes` supplies an always-yes approver.

### `tools`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `allow` | `string[]` | `read_file`, `list_files`, `search_text`, `write_file`, `apply_patch`, `exec`, `memory_search` | **The** list of tools the model may use. Anything absent is denied with `POLICY_DENIED` and cannot be approved. |
| `maxCallsPerTask` | `integer` >= 1 | `50` | Total tool calls allowed in one task; exceeding it ends the task with `TOOL_LIMIT_EXCEEDED`. |
| `tools.exec.defaultTimeoutMs` | `integer` > 0 | `30000` | Default timeout for a single `exec` call when the model doesn't specify one. |
| `tools.exec.maxOutputBytes` | `integer` > 0 | `100000` | Cap on combined stdout+stderr captured (and on file-read output). Excess is truncated and flagged in `metadata.truncated`. |
| `tools.exec.envAllow` | `string[]` | `[]` | Extra environment variable **names** passed to child processes, on top of the built-in base list. Names matching `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`/`APIKEY` are dropped regardless. |

Removing a tool from `allow` is the supported way to disable it globally; `--exclude-tools a,b`
does it for a single run.

### `context`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `historyMessages` | `integer` >= 0 | `30` | How many prior messages are carried into the next task. Trimming keeps the newest messages and never leaves an orphaned `tool` message without its `assistant` call. `0` disables history. |

### `skills`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dirs` | `string[]` | `[]` | Extra skill directories. Relative paths resolve against `cwd`. The built-in `<repo>/skills` directory is always scanned last. |
| `maxBytes` | `integer` > 0 | `262144` | Maximum SKILL.md size (256 KiB). Larger files are skipped with a warning. |
| `autoMatch` | `boolean` | `true` | If true, skills whose name/description/tags match the prompt are injected automatically. `--skill <name>` overrides and loads exactly the named skills. |

A skill is a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`,
optional `version`, `tags`, `whenToUse`). A malformed skill is skipped with a warning; it never
breaks discovery of the others. `agentx skills list` shows what was found.

### `memory`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | `boolean` | `true` | When false, the `memory_search` tool is not registered, even if it is in `tools.allow`. |
| `dir` | `string` \| `null` | `null` | Markdown memory directory. `null` means `<home>/memory`. |

### `logging`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Minimum level written. `--verbose` forces `debug` for that run. |
| `retentionDays` | `integer` >= 1 | `14` | How long dated log files are kept. |

Logs go to `<home>/logs/agentx-YYYY-MM-DD.log` as JSON lines. Values whose key matches
`/(api[-_]?key|token|secret|password|authorization|cookie)/i` are written as `"***"`, and
`sk-…` / `Bearer …` fragments inside strings and stack traces are scrubbed.

---

## 3. Environment variables

| Variable | Overrides | Notes |
|---|---|---|
| `AGENTX_HOME` | Config root directory | Default `~/.agentx`. The primary isolation mechanism for tests and CI — point it at a temp dir to get a clean state. |
| `AGENTX_MODEL` | `defaultModel` | Same syntax as `--model`. `--model` wins over it. |
| `AGENTX_CWD` | `cwd` | `--cwd` wins over it. |
| `AGENTX_READ_ONLY` | `readOnly` | `1/true/yes/on` or `0/false/no/off`. Any other value is a config error. Can only force read-only mode on. |
| `AGENTX_LOG_LEVEL` | `logging.level` | `debug`, `info`, `warn`, `error`. `--verbose` wins over it. |
| `DEEPSEEK_API_KEY` | — | Read by `providers.deepseek` via `apiKeyEnv`. |
| `LOCAL_API_KEY` | — | Read by `providers.local` via `apiKeyEnv`. |
| `AGENTX_MOCK_SCRIPT` | — | Test/automation only: path to a JSON file of scripted mock responses, used when the selected provider is `mock`. |
| `AGENTX_DEBUG` | — | If set, the CLI prints stack traces for crashes at startup. |

`<NAME>_API_KEY` style variables are never read implicitly — a provider only reads the exact name in
its `apiKeyEnv`. **No secret is ever overridable through an `AGENTX_*` variable**, so a leaked
`AGENTX_*` set can't smuggle in credentials.

Precedence summary: `--flag` > `AGENTX_*` env > `config.json` > defaults.

---

## 4. Credentials and redaction

There are three ways to supply a key, in decreasing order of preference:

1. **`apiKeyEnv`** (recommended) — the config file holds only a variable *name*; the secret lives
   in your shell, keychain, or CI secret store.
2. **Environment only** — no `apiKey`/`apiKeyEnv` in config; export the variable the provider
   expects.
3. **Inline `apiKey`** — works, but the secret sits in a file on disk. If you must, `chmod 600` it.

### What `config show` prints

`agentx config show` prints the **effective** config (defaults + file + env) after redaction:

| Situation | Output |
|---|---|
| `apiKey` set to any value | `"apiKey": "***"` |
| `apiKey` empty string | `"apiKey": "***"` (no hint whether it was set) |
| `apiKeyEnv` | Preserved as-is, e.g. `"apiKeyEnv": "DEEPSEEK_API_KEY"` — it is a variable *name*, not a secret |
| Any key matching `apiKey`, `accessKey`, `secret`, `token`, `password`, `authorization`, `cookie`, `credential` | value → `"***"` |
| `maxTotalTokens`, `promptTokens` etc. (usage fields) | Preserved — they contain "token" but are counters |
| `sk-…` or `Bearer …` appearing inside any string value | replaced with `***` |

`--json` applies the **same** redaction; there is no unredacted output path in any command.
Credential state is reported only as a boolean:

```
agentx: provider deepseek: api key configured (config)
agentx: provider local: api key missing (env:LOCAL_API_KEY (missing))
```

`agentx models list` shows `configured (config)`, `configured (env:NAME)`, `missing`, or
`not-required` (for `mock`) in its API KEY column. `agentx doctor` reports `configured` /
`missing` for the default provider. **The key value itself is never printed, logged, or included in
`--json` output** by any command.

Logs use the same policy: sensitive keys → `"***"`, and `sk-[A-Za-z0-9_-]{8,}` / `Bearer \S+` inside
messages and stack traces are scrubbed.

---

## 5. File permissions

| Path | Mode | Enforced by |
|---|---|---|
| `<home>/config.json` | `0600` recommended (not auto-changed) | You — use `chmod 600`. |
| `<home>/data/` | `0700` | Created by agentx (`ensureHomeLayout`, `openDatabase`). |
| `<home>/data/agentx.sqlite` | `0600` recommended; contains full transcripts | Umask; chmod if the box is shared. |
| `<home>/logs/` | `0700` | Created by agentx. |
| `<home>/memory/`, `<home>/skills/` | `0700` | Created by agentx. |

agentx sets `data/` to `0700` on every start and creates new directories with `0700`. It does
**not** rewrite the mode of an existing `config.json` — that file is yours. On a single-user
machine the defaults are fine; on a shared host run `chmod 600 ~/.agentx/config.json
~/.agentx/data/agentx.sqlite`.

---

## 6. Worked example

A minimal config that uses DeepSeek by default and a local vLLM/Ollama server as an alternative,
with a conservative tool set:

```json
{
  "defaultModel": "deepseek:deepseek-chat",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "maxRetries": 2,
      "timeoutMs": 120000
    },
    "local": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "models": ["qwen2.5-coder-32b-instruct"],
      "maxRetries": 0,
      "timeoutMs": 180000
    },
    "mock": { "type": "mock", "models": ["mock-1"] }
  },
  "maxSteps": 20,
  "timeoutMs": 600000,
  "policy": { "approval": "high" },
  "tools": {
    "allow": ["read_file", "list_files", "search_text", "write_file", "apply_patch", "exec"],
    "maxCallsPerTask": 50,
    "exec": { "defaultTimeoutMs": 30000, "maxOutputBytes": 100000, "envAllow": ["CARGO_HOME"] }
  },
  "context": { "historyMessages": 20 },
  "skills": { "dirs": ["./skills"], "autoMatch": true },
  "logging": { "level": "info" }
}
```

```bash
# preferred: keep the secret in a 0600 file, not in your shell environment
printf 'DEEPSEEK_API_KEY=sk-...\n' > ~/.agentx/.env
chmod 600 ~/.agentx/.env

agentx doctor                 # all checks should be PASS or an explained WARN
agentx models list            # deepseek * / local / mock
agentx config show            # note: apiKey / apiKeyEnv handling as described above
agentx run --model local "explain this repo"
```

Note that this example *removes* `memory_search` from `tools.allow`, which is the correct way to
disable the memory tool globally even though `memory.enabled` is still `true`.
