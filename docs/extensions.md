# Extensions

Everything except the preset's own `extensions/` is vendored under [`vendor/`](../vendor): a copy of the upstream source at a recorded commit, loaded through `package.json` `pi.extensions`. [`vendor/UPSTREAM.json`](../vendor/UPSTREAM.json) records each package's repository, commit, license, and every local change.

| Vendored package | Upstream | What it adds | Local changes |
|---|---|---|---|
| `pi-patty-bg-tasks` 2.0.0 | [patty-io/pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (unreleased `main`) | `bash` override that slides long commands into the background (or starts them there with `run_in_background`), `jobs`, `monitor`, `agent_bg`, ctrl+shift+b | headless fix, 30s/60s foreground timing, live progress, check-ins past `expected_seconds` (see below), condensed prompt, no `bash_bg` |
| `pi-workspace-history` 0.5.2 | [wcldyx/pi-workspace-history](https://github.com/wcldyx/pi-workspace-history) | file snapshots per turn: `/undo`, `/redo`, `/diff`, `/checkpoint`, file restore on `/tree` | — |
| `pi-wtf` 0.3.0 | [travisp/pi-wtf](https://github.com/travisp/pi-wtf) | `/fuck` (`?`, `!`): abort, rewind to before the last prompt, put it back in the editor | lives in `vendor/pi-workspace-history/wtf` |
| `pi-better-compaction` 0.7.4 | [lll9p/pi-better-compaction](https://github.com/lll9p/pi-better-compaction) | provider-native compaction (see below) | — |
| `pi-fff` 0.11.0 | [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff) `packages/pi-fff` | `ffgrep` / `fffind`: frecency-ranked, git-aware search | condensed prompt; native library stays an npm dependency |
| `rpiv-todo` 2.15.0 | [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `todo` task list and overlay | condensed prompt |
| `rpiv-ask-user-question` 2.15.0 | same | `ask_user_question` structured questions (up to 4 per call) | condensed prompt |
| `pi-web-search` 1.7.0 + `main` `cc47d6f` | [ttttmr/pi-web-search](https://github.com/ttttmr/pi-web-search) | `web_search` through the current provider's native search; no extra API key | — |
| `pi-apply-patch` 0.1.4 | [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch) | Codex `apply_patch` for OpenAI models | `typebox` as a peer dependency |
| `pi-context-view` 0.8.1 | [dimk90/pi-context-view](https://github.com/dimk90/pi-context-view) | `/context`: what fills the context, including tool definitions and injections | — |
| `termius-mcp` 3.2.0 | [MiaM1ku/termius-mcp](https://github.com/MiaM1ku/termius-mcp) | Python MCP server: SSH into Termius hosts (see [SSH](mcp.md#ssh-the-termius-mcp-server)) | no secret-bearing tools, output redaction, pinned host keys, stdin login, per-host disabled hosts and routes (`policy.py`), `login-json` host list and connection test |

| `betterleaks-rules` 1.9.0 | [betterleaks/betterleaks](https://github.com/betterleaks/betterleaks) `config/betterleaks.toml` | the secret rule set `secret-redact` reads (see [Secrets in tool results](#secrets-in-tool-results-extensionssecret-redactts)) | — (read as is, converted at load) |

All of them are MIT-licensed except termius-mcp (BSD 3-clause, from the Termius CLI); each directory keeps its upstream LICENSE (or the repository's, for monorepo packages).

`/fuck` and workspace-history work together: the rewind goes through pi's tree navigation, which workspace-history intercepts to offer restoring the files to the same point. `/undo` does the same for the last finished turn and also puts the prompt back in the editor; `/fuck` additionally aborts a running turn.

## Condensed tool prompts

Four vendored packages have their model-facing text condensed: `ask_user_question`, `todo` (also without the `owner` / `metadata` fields, which a single agent never sets), the patty background tools (also without the duplicate `bash_bg`), and `ffgrep` / `fffind`. Upstream repeats the same advice across tools (how to wait without `sleep`, one notification vs. an event stream) and spells out limits the schema and validator already enforce. The condensed text keeps every rule that changes behavior; the tools' code is untouched. Measured with the same request, the fixed per-request context drops from about 9.9k to 8.1k tokens (system-prompt rules from 7.7k to 2.9k characters), and A/B runs of questionnaires, task lists, background builds, and monitors produced the same tool calls as before.

## Background commands: `pi-patty-bg-tasks`

Brings Claude Code's background-task flow to pi: a foreground `bash` command that runs past its timeout slides into the background and keeps running, **ctrl+shift+b** (or `/bg`) backgrounds it on demand, every finished job sends one `<task-notification>` the moment it exits, and `jobs` / `monitor` / `agent_bg` / `/bg-list` manage what is running. The vendored copy is the unreleased 2.0.0 from `main` (npm still has 1.1.6): no `job_decide` prompt any more, no ctrl+b binding (so no shortcut conflict with pi's cursor key), signal deaths reported as killed instead of completed. Background tasks are killed when the session ends, including `/reload`.

Six local changes (two replace the workaround extensions 0.1 shipped):

- **Headless `pi -p` no longer exits on the first `bash` call.** Upstream spawns the foreground command detached and `unref()`s it; in a headless process nothing else holds Node's event loop once stdin is drained, so Node exited 0 in the middle of the tool call (Trellis workers, `agent_bg` children, any `--mode json|text` driver). The foreground child now stays ref'd until it finishes or moves to the background.
- **Short foreground waits.** `timeout` is when a command moves to the background, not a kill deadline, but models pass hundreds of seconds to protect long builds and a hung command then held the session. Without a timeout a command moves after 30s (`PI_PRESET_BASH_BG_DEFAULT`), and any timeout is capped at 60s (`PI_PRESET_BASH_BG_CAP`); `off` restores upstream's 120s and no cap. The parameter description and a bash guideline tell the model that the command keeps running. A bare `sleep`, which is killed at the timeout instead, keeps the timeout it was given.
- **Live progress from the first moment.** pi's bash row shows a running `Elapsed` clock and the latest output lines, but only once the tool reports a partial result. Upstream reported nothing for the first 2s and then only when the log grew, so a quiet command (tests, builds, installs) showed neither the clock nor anything else until it ended. The command now reports at once and its log is polled every 250ms. The `(timeout Ns)` on the row is when it moves to the background.
- **Private job logs.** Upstream wrote every command's output to a shared, world-readable `/tmp/pi-bg`, which any other user on the machine could read, or create first and so receive the output. Logs now go to `<tmpdir>/pi-bg-<uid>` (mode 0700, checked to be a real directory owned by you) and each log is 0600.
- **Your shell, also on Windows.** Upstream ran every `bash` / `monitor` command as `bash -c` found on PATH, which ignored `shellPath` in settings.json. On Windows with WSL enabled, `C:\Windows\System32\bash.exe` (the WSL launcher) comes before Git Bash on PATH, and detached with its output going to a file it exits 1 with an empty log, so every command, even `echo hi`, returned `(no output yet)`. Commands now run in the shell pi's own bash tool uses (`getShellConfig`): `shellPath` from the session settings (project `.pi/settings.json` over `~/.pi/agent/settings.json`), then Git Bash in its install locations, then bash on PATH. Stopping a job on Windows kills its whole process tree (`taskkill /T`), not just the shell.
- **Check-ins for jobs that never end.** A job reports only when it exits, so a server or watcher that already printed what was needed, a command waiting for input that is not a y/n prompt, or a hung download left the agent waiting for a notification that never came, and a `jobs attach` on it held the turn until Esc. `bash` and `agent_bg` take `expected_seconds`, the model's estimate of the run time. Once a background job is still running past it, the agent gets a check-in (it wakes an idle agent) with the elapsed time, how long ago the output last changed, and the log tail, and decides whether to keep waiting or kill the job. Further check-ins come at 2x, 4x, ... the estimate, at least 30s apart. A `jobs attach` that follows the job returns with the check-in instead, and the job still reports when it ends. Without an estimate the first check-in comes after 300s (`PI_PRESET_BG_CHECK`, `off` disables them). `jobs attach` also keeps a headless `pi -p` alive while it waits; before, the process exited mid-attach and left the job running.
- **No `bash_bg`.** Upstream also registers `bash_bg`, which starts a command in the background right away. `bash` with `run_in_background: true` does exactly that, so the duplicate tool (and its schema in every request) is gone.

## Todo nudges: `extensions/todo-nudge.ts`

The todo guideline says to keep one task in_progress and complete it as soon as it is done, but models still leave a finished task open, or start the next one on top. todo-nudge watches the todo state (from the todo tool's own results, and the session branch on start) and speaks up only when that happens, inside a tool result the model is reading anyway:

- a task stays in_progress for 8 tool calls without any todo call: the 8th result ends with `[todo] #3 write tests is still in_progress after 8 tool calls without a todo update: mark it completed now if it is done.` The next reminder comes after 16 more calls, then 32, so a genuinely long task is not nagged.
- an update sets a task in_progress while another still is: that todo result gets a note to complete the other one or set it back to pending.

A codemode script counts as one call, and a todo call inside it counts as an update. Nothing is added to the system prompt or the tools, so a session that keeps its list tidy pays nothing. `PI_PRESET_TODO_NUDGE=off` disables it; a number changes the 8.

## Working style: `extensions/working-style.ts`

pi's own system prompt says nothing about scope or code shape beyond "Be concise". working-style adds a `<working-style>` section of three bullets (text in `src/working-style.ts`, about 200 tokens):

- deliver what was asked at the intended scope, make routine calls without asking, say so in a sentence when the request looks mistaken and carry on, stop short of work nobody asked for: Anthropic's Task-scope paragraph for Claude Opus 5, word for word;
- keep solutions minimal (an abstraction only once something uses it twice, no unrequested configurability, error handling only for cases that can happen, no compatibility shims): condensed from Anthropic's "Avoid over-engineering" sample prompt;
- follow the surrounding code, leave untouched code alone, remove what your own change made unused.

It says nothing about double-checking work: Anthropic's Opus 5 guide reports that current models verify on their own and over-verify when told to. The wording is model-neutral, so GPT and DeepSeek models get the same section. It is a prompt section rather than a file in `~/.pi/agent/AGENTS.md` so it updates with the preset and your own AGENTS.md stays yours. `PI_PRESET_WORKING_STYLE=off` disables it.

## Secrets in tool results: `extensions/secret-redact.ts`

Whatever a tool returns goes to the model provider and into the session file, and most leaks come from the agent's own tools: a `read` of `.env`, a `bash` that prints a config or `env`, an MCP tool echoing a token. secret-redact scans every tool result (nested codemode calls included, and `structuredContent` and `details` too) before the model sees it and replaces each secret with a placeholder such as `[REDACTED:github-pat-1]`. The files themselves are untouched. A secret is:

- anything the [Betterleaks](https://github.com/betterleaks/betterleaks) rule set recognizes (about 420 formats: cloud keys, API tokens, private keys, credentials in URLs). Betterleaks is the MIT successor of Gitleaks by the same author; its TOML is vendored unchanged and its Go RE2 patterns are converted to JavaScript at load. Each rule only runs when one of its keywords is in the text, so a typical result costs a few milliseconds; a rule that takes over 250 ms on one text is switched off for the session (JavaScript regexes backtrack where RE2 does not). Live validation, which would send candidate secrets to the provider, is not used.
- a value pi itself knows: environment variables named like secrets (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `DB_PASSWORD`, not paths such as `SSH_AUTH_SOCK`), and the keys in `auth.json`, `models.json`, and `mcp.json`. Rules miss internal tokens and plain passwords; exact values do not.
- optionally, a value whose name says secret (`password = ...`, `API_KEY: ...`, from Betterleaks' `generic-api-key` / `generic-password`). Off by default: it guesses, and also hides ordinary values the agent may need.

The same value keeps its placeholder for the life of the pi process (also across `/reload`), so the agent can tell secrets apart and see where one recurs; the values stay in memory only. `write`, `edit`, and `apply_patch` put the real value back, so editing a file that holds a secret keeps it intact, and their diffs are redacted again on the way out. A placeholder from an earlier session cannot be restored; such a write is refused once, and goes through as literal text if the agent repeats it. `bash`, `powershell`, and MCP tools refuse a call that contains a placeholder this process issued: they never get the value back, since a command could send it anywhere, and the placeholder text would end up in a file or a request.

Termius results also carry the termius server's own `[redacted:...]` markers for vault secrets, which are never restored ([details](mcp.md#ssh-the-termius-mcp-server)).

This hides secrets from accidental exposure; it is not a boundary. An agent that transforms output (`| base64`, `rev`) gets around it, as does a secret that matches no rule and is not known. What you type yourself is not redacted.

`/secret-redact` shows what was replaced this session, the rule and known-value counts, and switches redaction and the named-value rules (`/secret-redact on|off`, `named on|off`); the choice is saved in `<agent dir>/pi-preset/settings.json`. `PI_PRESET_SECRET_REDACT=off` disables it for one process.

## Tool rows: `extensions/compact-tools.ts`

pi's own renderers already collapse most tool rows (read shows nothing, bash 5 lines, write 10), but `edit` always draws the whole diff. compact-tools re-registers the built-in `edit` with only its renderers wrapped: a collapsed row shows the first 16 lines (`PI_PRESET_EDIT_LINES`, `off` to disable) and a ctrl+o hint, and expanding shows pi's full diff. The model's tool schema and results are pi's own. It replaces `pi-tool-display`, which also took over `read`/`grep`/`find`/`ls` (activating them next to fff) and wrote ANSI-colored "Thinking:" labels into the saved session.

## Native compaction

The vendored `pi-better-compaction` replaces pi's text summary with the provider's own server-side compaction where the API offers one, and falls back to pi's compaction whenever that fails:

- **OpenAI Responses** (`openai-responses`): native `/responses/compact`. The result is an opaque window that replays only for the provider and model that produced it.
- **Anthropic Messages** (`anthropic-messages`): on-demand compaction (beta `compact-2026-09-04`, Claude Sonnet 4.6 / Opus 4.6 and newer, not Haiku). The signed block replays for the same model; its text also becomes pi's summary, so other models can still read it.
- Everything else keeps pi's compaction.

Whether native compaction actually runs depends on the relay. CLIProxyAPI (verified on 8.0.8) passes the beta through but adds `context_management` to every thinking request, which Anthropic refuses next to `compaction`. pi always sends thinking for the preset's Anthropic models, so before 0.7.3 every Anthropic compaction through CLIProxyAPI fell back to pi's. Since 0.7.3 the package retries that one rejected request without thinking ([lll9p/pi-better-compaction#9](https://github.com/lll9p/pi-better-compaction/pull/9); thinking blocks already in the history are kept, later turns keep your thinking level). The old `git:github.com/zidou-kiyn/pi-better-compaction` fork entry is superseded like the npm one, so the sync removes it.

**Switching models after an OpenAI native compaction.** The new model cannot read the opaque window and continues from the kept messages only. The package warns when this happens ([#10](https://github.com/lll9p/pi-better-compaction/pull/10)). To give the new model the full history, use `/tree` to branch from the entry just before that compaction; pi rebuilds the context from the original messages and compacts again with the new model if it does not fit. Switching away from an Anthropic compaction is safe.

To check what happened, run `/compact` and look at the session's compaction entry: `details.strategy` is `anthropic-native-compact-v1` or `openai-native-compact-v*` for native compaction, and absent for pi's own. For the reason behind a fallback, set `"debug": true` in `~/.pi/agent/extensions/pi-better-compaction/config.json`.

## Reading the status bar

```
✧ ~/project · ⎇ main                                       provider · π model · ◆ high
▰▱▱▱▱▱ 58k/272k 21% · ↑ 1.2M ↓ 38k · ▤ 93% · ⧗ 47m ♨ 21:43 ×2 · ◈ $0.410 · ◷ 36m52s
⬡ 12 · ⧉ 2 cm ts · ☑ 1/3 · ▸ current task
```

One line per question: **where and who** (directory, branch, session name; provider, model, thinking level), **how much** (context, tokens, cache, cost, time), and **what is loaded** (extensions, MCP, open todos). The third line disappears when it has nothing to say. On a narrow terminal the provider goes first, then the path shortens; stats that do not fit continue on one more line.

Segments show icons only (`⬡` counts the package extensions that register tools or commands; a vendored package counts once). Set `PI_PRESET_FOOTER_LABELS=1` to bring back the word labels (`in`, `out`, `cache`, `ttl`, `warm`, `pkg`, `mcp`); they are then shown whenever the stats fit in two lines. The list below uses those label names.

- **Context**: the meter plus `used/window percent` of the current context. Its color turns warning above 70% and error above 90%.
- **in / out**: tokens sent and generated over the whole session, not the current context. `in` counts cached prompt tokens too, so it is what the turns actually read.
- **cache**: how much of the latest turn's prompt came from the cache; warning below 50%, error below 25%.
- **ttl / warm**: time left before the prompt-cache entry expires (warning-toned in the last 5 minutes), and when `idle-keepwarm` refreshes it next, with the number of refreshes since your last message. Once the refresh limit is reached, no next time is shown: the warm icon dims and keeps only the count (`♨ ×7`) while the TTL runs out. A dim note replaces both while warming is paused.
- **◈**: session cost, `$0.410` below a dollar and `$18.03` above (`sub` when the model runs on an OAuth subscription). Absent when the provider reports no price.
- **mcp**: MCP servers connected through pi's built-in MCP support. Servers that failed or need a sign-in are not counted; pi reports them after startup and in `/mcp`. A dim `0` means MCP support is loaded but no server is connected. `cm` / `ts` mark the built-in `codemode` / `tool_search` tools while they are active. The segment is hidden only when the built-in MCP extension is disabled.
- **☑ / ▸**: todo progress and the current task, while any task is open. A finished list leaves the bar.
- **⟲ snapshot failed**: [pi-workspace-history](https://www.npmjs.com/package/pi-workspace-history) could not take a snapshot, so `/undo` may not cover the last change (see `/history-status`). Nothing is shown while snapshots work.

## Prompt cache kept warm while idle

pi's own cache warmer (`cacheWarming`, default `"streaming"`) only refreshes during runs, and its `"idle"` mode stops 30 minutes after the last real request — before a 1h cache entry would first be refreshed at 54 minutes. `extensions/cache-retention.ts` turns on the 1h TTL, and `extensions/idle-keepwarm.ts` covers the idle gap:

- Every real Anthropic request is captured. While the agent is idle, at 90% of the TTL the same payload is re-sent with `max_tokens: 1`. Nothing enters the conversation; each refresh is a `pi-preset-keepwarm` custom entry in the session file, and the status bar shows the remaining TTL and the next refresh time (see [Reading the status bar](#reading-the-status-bar)).
- The TTL comes from the model's `promptCache` (the Anthropic templates declare `{ "short": 300, "long": 3600 }`) and the request's `cache_control` TTL.
- A refresh that would fire within 5s of expiry (after sleep) is skipped, and one that misses the cache stops warming with a warning: on a Claude subscription the cache write is the billed part. Model switch, compaction, and `/tree` navigation pause warming; the next message re-arms it.
- `PI_PRESET_KEEPWARM=off` disables it; `PI_PRESET_KEEPWARM_MAX_IDLE=3h` stops after that long without a real request (default: no limit), and `PI_PRESET_KEEPWARM_MAX_WARMS` caps the refreshes between two real requests (default `7`, about 7h20m idle at the 1h TTL; `off` for no limit). The next message resets both. `/keepwarm` lifts the refresh limit for the current session and runs again to restore it; while lifted the warm segment ends in `∞`. Only interactive sessions are warmed.

Behind a gateway that load-balances several accounts, enable session stickiness, or every refresh lands on an account without the entry and the miss guard stops warming.

The Anthropic templates set `cacheRead` to `0`, because Claude subscription gateways do not bill cache reads.

## `/new` inherits the current model

pi rebuilds every `/new` session from `settings.json` (`defaultModel`, `defaultThinkingLevel`) or the CLI flags it was started with, so a model picked with `/model` or ctrl+p is dropped the moment you start a fresh session. `/resume` and `/fork` restore the target session's own model and are not affected.

`inherit-model.ts` stashes the active provider / model id / thinking level on the `session_shutdown` that precedes a `/new`, and reapplies it on the paired `session_start`. The value is parked on `globalThis` because `/new` recreates the resource loader and every extension instance, so module state would not survive. It is consumed once and never leaks into a later `/new`. If the model has vanished from the registry or its provider has no auth configured, pi's default is left alone. To go back to stock behavior, run `pi config` and untick it, or add `"extensions": ["!extensions/inherit-model.ts"]` to the preset's `packages[]` entry.

## Esc over SSH: `extensions/escape-over-ssh.ts`

**Esc delay.** A lone ESC byte may be the start of a longer key sequence, so pi waits before taking it as the Esc key: 10 ms locally, 100 ms over SSH (`SSH_CONNECTION` / `SSH_TTY`), where the network can split a sequence. Inside tmux that wait is wasted, because tmux has already assembled the keys on the same machine and writes each one whole to the pane. So inside tmux the extension sets `PI_TUI_ESC_TIMEOUT=10` when it loads, before pi starts reading the terminal; Esc in every dialog goes from about 105 ms to 14 ms. A value you set yourself wins, and plain SSH without tmux keeps pi's 100 ms.

**Double Esc.** tmux 3.8 holds a lone ESC for at least 500 ms, whatever `escape-time` says, while a size query to the outer terminal is unanswered. When the terminal reports zero pixels and never answers `CSI 14t` (Termius desktop over SSH), that lasts the whole session ([tmux #5777](https://github.com/tmux/tmux/issues/5777)): every Esc is half a second late, and a second Esc inside that window is parsed together with the first as Meta+Escape. pi then gets one Alt+Esc: `\x1b[27;3u` with `extended-keys-format csi-u`, `\x1b[27;3;27~` with the xterm format, a bare `\x1b\x1b` without extended keys. pi binds nothing to Alt+Esc, so the double press did nothing: no interrupt, and `doubleEscapeAction` never opened `/tree`. The extension rewrites Alt+Esc to Esc and feeds a second Esc through stdin right after, so pi sees the two presses that were typed. Nothing is lost, since pi has no use for Alt+Esc. The 500 ms itself is tmux's; until #5777 is fixed, tmux 3.6a or 3.7 avoids it. To check whether you are affected, start the server log with `kill -USR2 <tmux server pid>`, press Esc, and look for `increasing delay (active query)` in `~/tmux-server-<pid>.log` (it records every key, so delete it afterwards).
