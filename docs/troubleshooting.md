# Troubleshooting

Start here:

```bash
agentx doctor
```

It checks Node version, config parsing, home writability, database migration, skills, tools, the
default provider's key state, and logs — and it never touches the network. Nine times out of ten
the failing row tells you what to fix.

Every scenario below is a real failure mode of this codebase, with the exact symptom, cause, and
fix.

---

## 1. API key not configured

**Symptom.** The task fails; with `--json` you see:

```json
{"status":"failed","terminationReason":"provider_failed","errorCode":"PROVIDER_FAILED", ...}
```

stderr typically contains `401` or `Unauthorized`. `agentx doctor` shows:

```
api-key        WARN    deepseek (deepseek) defaultModel=deepseek-chat: api key missing [env:DEEPSEEK_API_KEY (missing)]
```

**Cause.** The provider has neither `apiKey` in config nor a value in the variable named by
`apiKeyEnv`. Note two easy mistakes:

- The variable is exported in a *different shell* than the one running `agentx` (e.g. added to
  `~/.zshrc` but you're in `bash`, or exported after the process started).
- The provider reads **only** the exact name in `apiKeyEnv`. Setting `OPENAI_API_KEY` does nothing
  for a provider whose `apiKeyEnv` is `DEEPSEEK_API_KEY`.

**Fix.**

```bash
agentx models list          # which providers report "missing"?
export DEEPSEEK_API_KEY=sk-...   # must be non-empty and not whitespace
agentx doctor               # api-key row should now be PASS
```

Then confirm what agentx actually resolved (no secret is printed):

```bash
agentx config show 2>&1 | grep 'provider '
```

In CI, inject the variable as a pipeline secret. Do **not** put the key in `config.json` if you can
avoid it — use `apiKeyEnv` so the file holds only the variable name.

---

## 2. The model endpoint is unreachable or rejects the request

**Symptoms**, all surfaced as `PROVIDER_FAILED`:

| Observed | Meaning |
|---|---|
| `fetch failed`, `ECONNREFUSED`, `ENOTFOUND`, `getaddrinfo` | Wrong `baseUrl`, provider down, or no proxy/route from this host. |
| `401` / `403` | Key wrong, revoked, or not valid for that `baseUrl`. **Not retried** — it fails immediately. |
| `429` after retries | Rate limit. `maxRetries: 2` means 3 total attempts, then `PROVIDER_FAILED`. |
| `ETIMEDOUT` / timeout after N ms | `providers.<id>.timeoutMs` too small, or the model is slow. Raise it. |
| `PROVIDER_BAD_RESPONSE` | The endpoint answered, but not with a valid chat-completions payload (proxy HTML, missing `choices`, malformed tool-call `arguments`). |

**Cause.** Almost always `baseUrl` shape. For OpenAI-compatible servers the version segment must be
included:

```
✓ http://127.0.0.1:8000/v1
✗ http://127.0.0.1:8000
```

A local server (Ollama/vLLM/llama.cpp) that isn't running gives `ECONNREFUSED` on `127.0.0.1:8000`;
a containerised server is often not visible at `127.0.0.1` from the host.

**Fix.**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"local-model","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8000/v1/chat/completions
```

- `200` → the endpoint is fine; recheck `models` / `defaultModel` against what the server serves.
- `401` → key problem (see §1).
- connection refused → start the server or fix the host/port.
- `404` → the path is wrong; usually a missing or doubled `/v1`.

`agentx doctor` deliberately does **not** probe the network, so it will not catch this — the first
real request does. Use `agentx run --model mock:mock-1 "hello"` to confirm the CLI itself works
independently of any provider.

**Isolate with the mock provider.** If mock succeeds and the real provider fails, the problem is
config/network, not agentx:

```bash
agentx run --model mock:mock-1 "hello"
```

---

## 3. A tool is rejected by policy

**Symptom.** The task fails with `terminationReason: "policy_denied"` and:

```
errorCode: POLICY_DENIED
tool "exec" is not in the allow list (tools.allow)
```

**Cause.** `POLICY_DENIED` at step ① of the policy decision order means the tool name is not in
`tools.allow`, or you passed it to `--exclude-tools`. **Approval cannot override this** — `--yes`
will not help, by design.

**Fix.**

```bash
agentx tools list      # ALLOWED column tells you instantly
```

You'll see something like:

```
TOOL           RISK    SIDE EFFECTS  ALLOWED  APPROVAL
read_file      low     no            yes      -
write_file     medium  yes           no       -
exec           high    yes           no       required
```

Then either add the name back in `config.json`:

```json
{ "tools": { "allow": ["read_file", "list_files", "search_text", "write_file", "apply_patch", "exec", "memory_search"] } }
```

…or stop excluding it:

```bash
agentx run --exclude-tools write_file "..."     # ← drop this flag if you need write_file
```

Note the difference between the two denial codes:

- `POLICY_DENIED` — the tool isn't allowed at all (allow-list / exclusion).
- `READ_ONLY_VIOLATION` — the tool is allowed but the task is read-only (§4).

If `memory_search` is denied, check **both** `tools.allow` and `memory.enabled` — with
`memory.enabled: false` the tool is never registered, so listing it in `allow` is not enough.

---

## 4. Read-only mode blocks a write I expected to work

**Symptom.**

```
errorCode: READ_ONLY_VIOLATION
tool "write_file" has side effects but the task is read-only
```

`--read-only` (or `--yes`) did not help.

**Cause.** Read-only is on. It can come from three places:

1. `--read-only` on the command line,
2. `"readOnly": true` in `config.json`,
3. `AGENTX_READ_ONLY=1` / `true` / `yes` / `on` in the environment.

Read-only is checked **after** the allow-list and **before** approval, so no amount of
`--yes` gets past it. There is no per-tool read-only exception: `write_file`, `apply_patch`, and
`exec` are all denied because each has side effects.

**Fix.** Find which source is active:

```bash
echo "AGENTX_READ_ONLY=${AGENTX_READ_ONLY:-<unset>}"
agentx config show | grep -E '"readOnly"|"approval"'
agentx tools list | tail -1        # shows: read-only mode: on|off
```

Then remove the one you don't want — unset the variable, flip `readOnly` to `false` in
`config.json`, or drop the CLI flag. Remember `--read-only` is a one-way switch: a CLI flag can turn
read-only **on**, never off.

**If you actually intended read-only**, this is correct behaviour — ask the agent for a plan or a
diff description instead of a write, or run with `--exclude-tools exec` and let it use `write_file`
only.

---

## 5. Session database is corrupt

**Symptom.** Any command that touches storage fails:

```
agentx: database disk image is malformed
agentx: file is not a database
agentx: disk I/O error
SQLITE_CORRUPT
```

or `agentx doctor` reports:

```
database       FAIL    /root/.agentx/data/agentx.sqlite: ...
```

**Cause.** Interrupted writes, a full disk, an unclean shutdown, or a stray copy of another file
placed at `agentx.sqlite`. WAL mode makes this rare, but it is not impossible — and copying a
database while the `-wal` file is outstanding is a classic way to produce it.

**Diagnose.**

```bash
ls -la ~/.agentx/data/
# check free space first — a full disk looks like corruption
df -h ~/.agentx
```

**Fix (rebuild).** The SQLite file holds sessions, messages, and task records — all of it
regenerable. Your config, skills, and memory notes are *elsewhere* and are unaffected.

```bash
# 1. stop any running agentx (no background tasks / chat sessions)
# 2. move the broken files aside — never delete until you're sure
mkdir -p ~/.agentx/data/backup-$(date +%Y%m%d)
mv ~/.agentx/data/agentx.sqlite* ~/.agentx/data/backup-$(date +%Y%m%d)/

# 3. re-create an empty schema with migrations applied
agentx doctor          # the database row re-creates and migrates the file
agentx sessions list   # → "no sessions"
```

The database is recreated on demand, so step 3 needs no special command: `doctor` (or any `run`,
`chat`, or `sessions` call) opens the path, creates it, and applies migrations to
`PRAGMA user_version = 1`.

**If you want the old data back**, try recovering the backup before discarding it — with
`sqlite3` installed:

```bash
sqlite3 ~/.agentx/data/backup-*/agentx.sqlite ".recover" | sqlite3 ~/.agentx/data/agentx-recovered.sqlite
```

If that produces a readable file, point agentx at it by replacing `agentx.sqlite` with the
recovered copy while agentx is not running.

**Permission-related "corruption".** A `SQLITE_CANTOPEN` / `unable to open database file` is
usually an ownership or mode problem, not corruption:

```bash
ls -ld ~/.agentx ~/.agentx/data      # expect your user, data as drwx------
```

---

## 6. Approval required in a non-interactive shell

**Symptom.** In CI, a cron job, or any piped invocation, the task fails fast:

```
agentx: task failed (policy_denied, APPROVAL_REQUIRED)
agentx: approval required but no interactive terminal
```

Exit code **3**. `sessions delete` shows the same pattern:

```
agentx: refusing to delete session "ses_x" without confirmation (non-interactive; pass --yes)
```

**Cause.** A tool call needed approval (`exec` under the default `policy.approval: "high"`) but
there was no TTY to ask on. Rather than hanging forever on a prompt nobody will answer, agentx
fails immediately. This is intentional and is the single most important behaviour for automation.

**Fix — pick one, deliberately:**

```bash
# A. Explicitly trust this run: auto-approve tools that ask.
agentx run --yes "run the test suite"

# B. Don't let the agent run side-effecting tools at all.
agentx run --read-only "summarise the test failures"

# C. Narrow the blast radius instead of blanket-approving.
agentx run --exclude-tools exec,write_file "explain src/index.ts"

# D. Lower the global bar for a trusted environment (config.json).
#    "policy": { "approval": "none" }
```

`--yes` is the *only* thing that turns an approval-required call into an executed one. It replaces
the approver with an always-yes function; it does **not** bypass the allow-list (step ①) or
read-only mode (step ②). So `--yes --read-only` still cannot write — a useful belt-and-braces
combination for unattended runs where you want reads freely and writes never.

Avoid piping a `y` into stdin as a workaround: `agentx` treats a non-TTY as "no approver", so it
never reads that input.

---

## 7. Where are the logs?

**Location.** `<home>/logs/agentx-YYYY-MM-DD.log`, one file per UTC date, JSON lines:

```
~/.agentx/logs/agentx-2026-10-22.log
```

`<home>` is `$AGENTX_HOME` if set, else `~/.agentx`. `agentx doctor` prints the directory and the
newest file:

```
logs           PASS    /root/.agentx/logs; 3 file(s); latest agentx-2026-10-22.log (2026-10-22T09:14:03.221Z)
```

If the row says "has no log file yet", nothing has been logged at the current level yet — run
something with `--verbose`.

**What's in them.** Structured events: `task.created`, `model.start`/`model.end` (with `durationMs`
and token usage), `tool.start`/`tool.end` (name, status, duration), `task.waiting_approval`,
`task.termination` (with `reason`). Credentials are redacted at the writer: keys matching
`/(api[-_]?key|token|secret|password|authorization|cookie)/i` become `"***"`, and `sk-…` /
`Bearer …` fragments inside messages and stack traces are scrubbed. Log files are still sensitive —
they contain prompts, file contents, and command output.

**Reading them.**

```bash
# follow live, human-readable
tail -f ~/.agentx/logs/agentx-$(date -u +%F).log | jq -r '"\(.time) \(.level) \(.msg)"'

# just the terminations
jq -c 'select(.msg=="task.termination")' ~/.agentx/logs/*.log

# just tool failures
jq -c 'select(.msg=="tool.end" and .status!="ok")' ~/.agentx/logs/*.log

# everything about one task
jq -c --arg t task_abc123 'select(.taskId==$t)' ~/.agentx/logs/*.log
```

**Getting more.** `--verbose` (or `agentx config show` → `logging.level: "debug"`) writes
debug-level events, including which skills were selected. In `--json` mode stderr stays quiet by
default so stdout remains parseable; the file log is always written.

**Retention.** Old dated files are kept for `logging.retentionDays` (default 14). Clean up manually
if you set it high:

```bash
find ~/.agentx/logs -name 'agentx-*.log' -mtime +14 -delete
```

---

## 8. Quick reference: symptom → exit code → first command

| Exit | Likely cause | Run this first |
|---|---|---|
| `0` | Fine. | — |
| `1` | Task failed / timed out / a check failed | `agentx doctor`, then `tail -50 ~/.agentx/logs/agentx-$(date -u +%F).log` |
| `2` | Usage error: bad flag value, unknown model, invalid config | `agentx config show` (it validates and names the bad field) |
| `3` | Approval required, no TTY | `agentx tools list`, then add `--yes` or `--read-only` |
| `130` | You pressed Ctrl+C | Re-run; use `--timeout` for unattended work |

Other useful one-liners:

```bash
agentx run --model mock:mock-1 "hello"   # is the CLI itself healthy? (no network)
agentx models list                       # is a key configured, and for which provider?
agentx tools list                        # why was that tool denied?
AGENTX_HOME=$(mktemp -d) agentx doctor   # is my config/home the problem, or the install?
```

That last one runs doctor against a pristine temporary home — if it passes there but fails in your
real home, the problem is your `config.json` or `~/.agentx` state, not the installation.
