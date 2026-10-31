# bench

A benchmark for the preset: the same tasks run under plain pi, the installed preset, and this checkout, in fresh copies of a fixture, with objective checks and a blinded pairwise judge. It is how the working-style wording, the deferred tools, and the git-conventions changes were decided; the reports are in `reports/`.

```bash
node bench/setup.mjs                       # agents/{pure,old,new} from ~/.pi/agent (models + auth only), pinned Jinja clone
node bench/run.mjs --configs new --reps 2   # 11 tasks × 2 reps; results/<task>-<config>-<rep>.{jsonl,json,err}
node bench/judge.mjs --pairs old:new        # blinded pairwise, both orders; results/judge2.json
node bench/analyze.mjs > bench/results/summary.md
```

Needs `pi`, `uv` (the Jinja tasks), and credentials in `~/.pi/agent` for `anthropic-proxy/claude-opus-5-5` (change `MODEL` in `run.mjs` for another). `agents/`, `.cache/`, `work/`, and `results/` are ignored by git; `agents/` holds copies of your auth.json.

| | |
|---|---|
| `tasks.mjs` | The tasks: fixture, overlay or `mutate()`, prompt, objective `check()`. `base` is a 300-line Node ledger CLI with a fake key in `.env`; `jinja` is pallets/jinja at a pinned commit |
| `run.mjs` | Runs `pi --mode json -p` per task × config × rep, parses the event stream (turns, tools, tokens, cost at official rates), runs the check |
| `judge.mjs` | Same model, no tools, rubric of five 1–10 scores and a winner; `--model` for a second judge |
| `judge-docs.mjs` | Judges the onboarding documents the explore task writes to disk |
| `interactive.mjs` | Real `pi --mode rpc` sessions with a scripted user: answers `ask_user_question` dialogs and plain-text questions, sends slash commands (`--task ambiguous\|undo`) |
| `analyze.mjs` | Tables per task × config, behaviour counters (secrets in context, background bash, tool use), judge aggregates |
| `fixture/overlays/<name>` | Files copied over the base fixture for a task (planted bugs, a dirty tree, junk to clean up) |
| `fixture/hidden` | Tests the agent never sees, run by the checks |

Configs: `pure` (no packages), `old` (the preset installed in `~/.pi/agent`), `new` (this checkout as a local package), `nostyle` (`new` with `PI_PRESET_WORKING_STYLE=off`). Add one in `run.mjs` `CONFIGS` (an agent dir plus environment).

What `run.mjs` cannot see: anything interactive; `interactive.mjs` covers `ask_user_question` and slash commands over RPC, the status bar, compaction, and Termius stay untested. With two reps per cell the model's own variance is larger than most configuration effects, so read the behaviour counters and the objective checks before the judge tables.
