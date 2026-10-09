# trellis-lite design

> Status: implemented (commits `cbb054a`..). Decisions confirmed with the user are listed in §15.
> Baseline: Trellis `v0.7.0-beta.4` (`be9e19b`), compared with `v0.6.17` (`833a584`), `main` (`f089cb3`), and mini-trellis `main` (`74f2dfa`).
> License: pi-preset stays MIT. This document and the implementation are clean-room: upstream was read only to learn behavior, directory layout, and file formats. The behavior is specified here in our own words, and the code was written from this specification, not translated from upstream sources.

## 0. Name

`trellis-lite`: the name says that it works with existing `.trellis/` data. The README states that it is not a Mindfold product. Commands are `/trellis-lite` and `/trellis-lite-migrate`; skills use the `trellis-` prefix; switches use `PI_PRESET_TRELLIS*`.

## 1. Research findings

### 1.1 Trellis

- **What beta.4 adds over 0.6.17** (`git diff --stat v0.6.17 v0.7.0-beta.4 -- packages/cli/src/templates`: 38 files, +3131/−134):
  1. **Path-scoped spec injection.** Implemented for Claude Code, Codex, and similar hosts by a PreToolUse hook, and for OpenCode by a plugin; configured by a `spec_injection` section in `config.yaml`. **The pi extension has none of it**: beta's pi extension changes only workflow-variant selection and fixes one UTF-8 truncation bug.
  2. **Workflow variants**: `.trellis/workflows/<id>.md`, picked per task, then per developer, then the project default, then `workflow.md`.
  3. Templates for the DSH host, Codex hooks, small session-start changes.
- **`main` after 0.6.17** has one template-related fix (`36292d64`: committing an archived task no longer stages the path it moved away from). Beta does not have it. It concerns automatic commits, which trellis-lite never makes.
- **Beta's injection model**: the first match injects the full spec; an unchanged spec stays silent inside a refresh window (45 minutes by default) and then gets a short reminder; a changed spec, `/clear`, or `/compact` brings back the full text. Budgets are in characters (9400 per spec, 9500 per event); past them a spec is listed by path and description.
- **Frontmatter and glob conventions** (interfaces, kept compatible): the block counts only when the first line is exactly `---`; the recognized keys are `paths`, `name`, and `description`; `paths` is a block list or `[a, b]`; globs are relative to the repository root and use `/`; `*` stays inside one segment, `?` is one character, a whole `**` segment spans zero or more segments, and a trailing `/` means `/**`; empty globs, a leading `/`, `..` segments, backslashes, and control characters are rejected; matching ignores case on macOS and Windows; when several specs match, more specific globs come first.

### 1.2 mini-trellis, checked against the user's assessment

| Assessment | Finding |
|---|---|
| The direction is right | Agreed: paths instead of bodies, and only the memory layer |
| Still carries a lot of Python | True: about 388 KB of Python in its templates (`task_store.py` 76 KB, `add_session.py` 57 KB, …), including `task_store.py` although it has no tasks |
| Supports four hosts | True: Claude Code, Codex, OpenCode, pi |
| Dropped task planning | True, and more: its `migrate` moves `.trellis/tasks/<x>/` into `.trellis/research/<x>/` and archives or deletes `prd.md`, `task.json`, `implement*`. That conflicts with keeping existing data unchanged, so trellis-lite does not do it |
| The pi extension computes from `process.cwd()` once at load | True. In addition, a `/resume` into another project's session gets the launch directory's content; it returns a whole `systemPrompt` on every turn (pi 1.1 recommends changing `systemPromptOptions.sections`, which pi records as deltas); and it notifies on every `session_start` |

Worth borrowing: an upper bound on the injected text (≤4000 characters), no repeated injection, a research directory of its own, and clear rules for when something is worth recording.

### 1.3 pi 1.1 capabilities that shape the design

- **Per-project skills**: the `resources_discover` event fires after each session's `session_start` with the session `cwd`; a handler returns `skillPaths` / `promptPaths`, which pi merges before rebuilding the system prompt. trellis-lite's skills are therefore not in `package.json` `pi.skills`; the extension returns them only when it finds `.trellis/`. Other projects' system prompts do not change by a single byte.
- **System prompt sections**: writing `event.systemPromptOptions.sections["<name>"]` in `before_agent_start` renders an XML-tagged section. pi appends a system message with the change only when a section's content differs, so writing the same bytes every turn keeps the cached prefix.
- **Tool results can be extended**: a `tool_result` handler may return new `content`. Calls made by another tool (a codemode script) carry `parentToolCallId`; their result goes to the script, not the model.
- **Lifecycle**: `session_compact` and `session_tree` signal that the context changed; `sessionManager.buildContextEntries()` returns the compaction-aware context of the current branch.

### 1.4 The weibi-bot project (read only)

- The hash table registers 155 files (`.claude` 52, `.trellis` 51, `.agents` 43, `.pi` 8, `AGENTS.md` 1); each hash is the sha256 of the file's raw bytes.
- Files whose bytes differ from their hash: `AGENTS.md`, `.trellis/workflow.md`, and 19 `.pyc` files. **The `.pyc` files are registered too**, so `__pycache__/` and `*.pyc` must be classified as runtime leftovers before hashes are compared.
- Written by Trellis but not registered: `.trellis/.gitignore`, `.developer`, `.version`, `.template-hashes.json`.
- `.pi/settings.json` is registered and unmodified: `enableSkillCommands: true` (pi's default), the extension entry `./extensions/trellis/index.ts`, and `./prompts` (pi discovers `.pi/prompts/` by itself).
- Stale references: none in the specs (`test_calculate_cost_from_task.py` is the expected false positive), but the project section of `AGENTS.md` outside the managed block mentions `add_session.py`, so the migration checks `AGENTS.md` too.
- The specs total about 163 KB; path-scoped injection needs budgets.

### 1.5 Fit with pi-preset

- Switches follow the existing patterns: pi's package resource filter (`pi config`, or `"extensions": ["!extensions/…"]`) and `PI_PRESET_<FEATURE>=off`.
- The existing `grilling` skill already runs decision interviews through `ask_user_question`; `trellis-plan` uses it instead of a second brainstorm procedure.
- The vendored `pi-workspace-history` is undo and snapshots, not cross-session search; it does not overlap with `trellis mem`.
- Tests use `node:test`; extension files start with a Why / Effect / Runtime / Command header.

## 2. Revised feature list

| Capability | Decision |
|---|---|
| Spec system | Kept: `spec/<layer>/index.md`, `spec/<pkg>/<layer>/index.md`, `guides/`, plus an optional top-level `spec/index.md` |
| update-spec | `trellis-spec` skill; break-loop is folded in as an "after a bug that could come back" section (one skill description fewer) |
| brainstorm + prd/design/implement | `trellis-plan` skill: files only, decisions through `grilling`, archive with `git mv`; no `task.json`, no jsonl |
| Journal and `.developer` | Compatible formats; written by a TypeScript script the skill runs (no tool, so no standing cost); never commits |
| Path-scoped specs | Implemented (§6): once per session, no time-based reminders, triggered by `read` / `edit` / `write` / `apply_patch` |
| Snapshot, budgets, safe truncation | Implemented; budgets in characters |
| `trellis mem` | Not implemented; the journal skill points at pi's session logs for grep |
| Research directory | Listed when `.trellis/research/` exists (up to 6 entries); tasks are not converted |
| spec-bootstrap, session-insight, meta, channel, check, before-dev | Not implemented; before-dev is replaced by the spec index in the section plus path-scoped specs |

## 3. Behavior

### 3.1 Trellis project and root

- From the session `cwd` (`event.cwd` in `resources_discover`, `ctx.cwd` elsewhere), walk up to the **first ancestor containing a `.trellis/` directory**. A directory containing `.git` is checked and ends the walk; `$HOME` and above are never considered.
- `.trellis/` must be a real directory (not a symlink) holding at least one of `spec/`, `workspace/`, `tasks/`, `.developer`.
- No root means **not a Trellis project**: no skills, no section, no `tool_result` changes, no notifications. Only the `/trellis-lite` commands exist (needed for `init`; commands cost no context).
- `process.cwd()` is never used.

### 3.2 Coexisting with old Trellis

Any of these in the project root means Trellis or mini-trellis pi assets are still active:

- `.pi/extensions/trellis/`, `.pi/extensions/mini-trellis/`
- `.agents/skills/trellis-*`, `.agents/skills/mini-trellis*`, `.pi/skills/trellis-*` (pi discovers both directories)
- `.pi/prompts/trellis-*.md`, `.pi/prompts/mini-trellis-*.md`

Then trellis-lite does nothing (no section, skills, or injection) and notifies once per session (warning): trellis-lite is paused, run `/trellis-lite-migrate`. Two active instruction sets would contradict each other.

### 3.3 The `project-memory` section

- Computed on the first `before_agent_start` of an extension instance and written back unchanged on every turn. `/reload`, `/new`, `/resume`, and `/fork` create a new instance and recompute it; if it differs, pi appends a delta instead of rewriting the prefix.
- Paths and counts only, each list capped with `(+N more)`:

| Item | Rule | Cap |
|---|---|---|
| Spec indexes | `spec/index.md`, then `spec/*/index.md`, then `spec/*/*/index.md` | 10 |
| Journal | newest `journal-N.md` of the developer, with session count and lines / limit; a hint to run `/trellis-lite init` when `.developer` is missing | 1 |
| Open tasks | directories in `tasks/` except `archive/`, newest name first, with the `prd` / `design` / `implement` files present | 5 |
| Research | top-level entries of `.trellis/research/`, without `archive/` and `README.md` | 6 |

- At most 1500 characters; past that, research, then tasks, then specs collapse to counts.
- Measured for weibi-bot: 498 characters.

### 3.4 Skills (only in Trellis projects, through `resources_discover`)

- **`trellis-spec`**: whether a rule deserves a spec (still true next week, not visible from the code, a rule rather than a story); where it goes and the index link; how to write it (one rule per heading, why, correct and wrong example, contracts as contracts, real file names); `paths:` frontmatter and glob syntax; the after-a-bug analysis (cause class, why earlier fixes failed, the cheapest guard for the whole class, other occurrences); no commit.
- **`trellis-journal`**: what an entry contains; the script call `node <skill-dir>/../../bin/trellis-lite.ts journal --title … [--commits …] [--task …] [--status …]` with the summary on stdin; what the script does; projects decide their own commit rules; pi's session logs for older detail.
- **`trellis-plan`**: facts before questions; decisions through `grilling`; `prd.md` always, `design.md` and `implement.md` when warranted, `research/` for material; stop for approval; on completion move rules to spec, `git mv` into `tasks/archive/YYYY-MM/`, offer a journal entry; leave old `task.json` / jsonl alone.

**Measured standing cost**: 629 tokens (Opus 5.5 tokenizer) for the section plus the three skill entries, against a 1k ceiling and a 600 target. Each skill entry carries its absolute `location`, about a third of its cost.

### 3.5 Commands

| Command | Effect |
|---|---|
| `/trellis-lite` (`status`) | root, legacy assets, the section as sent with its size, path-scoped spec count and frontmatter errors, specs in context this session |
| `/trellis-lite init` | create the missing skeleton (§8) |
| `/trellis-lite migrate` | the migration plan (dry run, read-only) |
| `/trellis-lite-migrate` | send the migration prompt to the agent, with the CLI's absolute path filled in (a plain prompt template cannot know where pi-preset is installed) |

## 4. Switches

| Scope | How |
|---|---|
| Everywhere | `PI_PRESET_TRELLIS=off`, or untick `extensions/trellis-lite.ts` in `pi config`, or `"extensions": ["!extensions/trellis-lite.ts"]` on the package entry |
| Path-scoped specs only | `PI_PRESET_TRELLIS_SPECS=off` |
| One project | pi's package filter in the project's `.pi/settings.json` |

## 5. Prompt cache

- The section is byte-stable within a session; path-scoped specs are appended to tool results, never to the system prompt.
- No per-turn injection, no rewritten tool calls, no tools (the journal is a script).
- The skill list is fixed when the session starts.

## 6. Path-scoped specs

**Trigger**: top-level (no `parentToolCallId`), successful `tool_result` of `read`, `edit`, `write`, `apply_patch`. Paths come from `input.path` (or `file_path`), and for `apply_patch` from the `*** Add File:`, `*** Update File:`, and `*** Move to:` lines of `input.input`. A leading `@` and `~/` are understood; paths resolve against `ctx.cwd`, then become NFC repo-relative POSIX paths. Files outside the root and inside `.trellis/` never trigger.

**Matching**: `.trellis/spec/**/*.md` heads (16 KB / 200 lines) are parsed and cached by mtime and size. A malformed frontmatter or glob skips that file or glob and shows in `/trellis-lite status`, without notifications. Sort order: no wildcard first, then more literal segments, fewer wildcards, longer literal text, then path.

**Once per session**: each attached spec is wrapped as `<spec path="…" sha="<12 hex of sha256>">…</spec>` inside `<spec-context file="…">`. What the context already holds is derived from the session: markers in the tool results of `buildContextEntries()` (after the last compaction's kept point), recomputed after `session_start`, `session_tree`, and `session_compact`. A spec with the same hash is skipped; a changed file is attached again. A spec that is in context only as a budget listing is not listed again. There are no time-based reminders.

**Budgets** (characters = UTF-16 code units, so CJK counts one per character; truncation never splits a surrogate pair):

| Scope | Limit | Beyond it |
|---|---|---|
| One spec body (frontmatter removed) | 6000 | cut, with `[truncated at 6000 characters; read <path> for the rest]` |
| One tool result | 8000 | further specs listed: `<spec path=… sha=… listed="budget">description</spec>` |
| Full bodies per session context | 40000 | listings only |

**Why on read**: the model almost always reads a file before editing it (pi's `edit` needs the exact old text), so the rule arrives before the change. A file written without a read gets its spec after the write, in time for the next step. Edits made through bash (`sed`, generators) do not trigger.

## 7. Root and snapshot strategy

- The root is resolved per event from that event's `cwd` and cached per `cwd`.
- The section is computed once per extension instance. Tasks or specs created mid-session do not change it; the model knows what it created, and `/reload` picks up the rest.

## 8. init

`/trellis-lite init` (idempotent, only fills gaps, asks for confirmation, never commits):

1. `.trellis/spec/index.md`, unless the project already has layer indexes: short guidance on layers and `paths:` frontmatter.
2. `.trellis/.developer` with `name=` and `initialized_at=`; the name is asked for, defaulting to `git config user.name` made directory-safe.
3. `.trellis/workspace/<dev>/journal-1.md` with the journal header.
4. `.trellis/.gitignore` containing `.developer` (the identity is per machine).

The root is the existing project root, else the git top level, else `cwd`.

## 9. Migrating from Trellis

### 9.1 Who does what

The user runs `/trellis-lite-migrate`; the agent carries out the migration in one session. **What is deleted and how files are edited is decided by the CLI** (deterministic and tested); the agent runs it, asks the user, and handles what needs judgment:

1. The agent runs the dry run, summarizes it, and asks with `ask_user_question`: apply / apply and remove other hosts' Trellis files / cancel.
2. On approval it runs `migrate --apply --yes`. The CLI deletes only templates proven unmodified by their hash and runtime leftovers, and makes the exact edits; needs-review files stay.
3. The agent then handles the needs-review files (§9.4).

Apply comes first because extracting project content writes `AGENTS.md` and `.pi/prompts/`; done first, that would make the tree dirty and the CLI would refuse, and `AGENTS.md` is edited by both. Applying on a clean tree keeps every later change visible and revertible in git. The CLI enforces its own rules: no apply outside git, none with uncommitted changes, none without `--yes`.

### 9.2 The CLI

`node <pi-preset>/trellis-lite/bin/trellis-lite.ts migrate [--json] [--apply --yes] [--remove-hosts claude,...]`. `/trellis-lite migrate` shows the same plan. The dry run prints to stdout and writes nothing (a plan file would make the tree dirty).

**Classification**, first match wins:

| # | Category | Rule | Action |
|---|---|---|---|
| 1 | User data | `.trellis/spec/**`, `workspace/**`, `tasks/**`, `research/**`, `.developer` | untouched (not even walked) |
| 2 | Runtime | any `__pycache__/` or `*.pyc`; `.trellis/.runtime/`, `.backup-*/`, `.current-task`, `.ralph-state.json`, `.version`, `.agent-log`, `.session-id`, `.plan-log` | delete (inside another host's directory: part of that host's group) |
| 3 | Shared | `AGENTS.md`, `.pi/settings.json`, `.trellis/.gitignore`, `.gitignore` | exact edit (§9.3) |
| 4 | Other host | registered files outside `.trellis`, `.pi`, `.agents` (`.claude/`, `.codex/`, …), and unregistered files in Trellis-owned paths there | kept unless `--remove-hosts`; then unmodified ones are deleted and the rest become needs-review |
| 5 | Unmodified template | registered, sha256 matches | delete |
| 6 | Modified template | registered, sha256 differs | kept, needs-review |
| 7 | Unregistered Trellis file | in a Trellis-owned path: `.trellis/{scripts,agents,workflows}/`, `.trellis/workflow.md`, `.trellis/config.yaml`, or any path segment named `trellis`, `trellis-*`, `mini-trellis*` | kept, needs-review |
| — | Anything else | | untouched, not listed |

- **`.trellis/.template-hashes.json`** is pruned rather than deleted while registered files remain (kept host files, review files), so later runs can still verify them; it is deleted once nothing it lists remains.
- Without a usable hash table (e.g. mini-trellis), categories 5 and 6 cannot be told apart: every file in a Trellis-owned path is needs-review; only categories 2 and 3 are acted on.
- Directories emptied by deletion are removed bottom-up.
- **After apply**: the missing skeleton pieces are created (§8); the report lists deletions, edits, files kept for review, and the former Trellis version (needed by §9.4, since `.version` is gone). Nothing is committed.
- **Idempotent**: a migrated, committed project reports "Nothing to do"; kept files of other hosts are informational.
- The JSON plan also carries `staleReferences`, `activeTasks`, and `pathHints` (§9.4).

### 9.3 Exact edits

- **`AGENTS.md`**: remove the lines from `<!-- TRELLIS:START -->` to `<!-- TRELLIS:END -->` and one blank line after them; every other byte is unchanged. Markers that are not exactly one pair, out of order, or not on their own lines make the file needs-review instead. A file left blank is deleted.
- **`.pi/settings.json`**: remove `extensions` entries under `extensions/trellis/` or `extensions/mini-trellis/`, the `./prompts` entry, and `trellis-*` skill or prompt entries; drop arrays that became empty; delete the file when nothing but pi defaults (`enableSkillCommands: true`) remains. Non-JSON content makes it needs-review.
- **`.trellis/.gitignore`**: remove the known Trellis runtime patterns (`.current-task`, `.runtime/`, `.ralph-state.json`, `.agents/`, `.agent-log`, `.session-id`, `.plan-log`, `*.tmp`, `.backup-*`, `*.new`, `**/__pycache__/`, `**/*.pyc`, `.version`, `.template-hashes.json`) and the comment lines directly above them; keep `.developer` and everything else.
- **Root `.gitignore`**: remove only `.trellis/<pattern>` lines for those patterns.

### 9.4 The agent's part (`trellis-lite/prompts/migrate.md`)

1. Dry run as JSON, summary, `ask_user_question`, apply (or stop and list uncommitted files; the agent never commits, stashes, or restores on its own).
2. Each needs-review file: `npm pack @mindfoldhq/trellis@<version>` in a temporary directory, diff against the original template, keep only what the project added. Procedures go into `.pi/prompts/<name>.md` with a `description:`; standing rules go into `AGENTS.md` unless already there; Trellis mechanics (phases, subagents, jsonl, platform lists, `task.py`) are dropped and named. Every file is shown and confirmed before it is written; the reviewed file is removed with `git rm` after confirmation.
3. Stale references in specs and `AGENTS.md` (word-bounded: no letter, digit, `_`, or `-` on either side of the term): propose replacements, change after confirmation.
4. Open tasks stay; `task.json` / jsonl stay until the task is archived.
5. `paths:` suggestions from `pathHints` (the repository directories a spec's text refers to most), suggestions only.
6. Dry run again: nothing left.
7. How to measure the first turn.
8. A commit message, committed only after approval.

## 10. Files

```
extensions/trellis-lite.ts                 wiring: resources_discover, before_agent_start, tool_result, session events, commands
src/trellis-lite/config.ts                 switches
src/trellis-lite/root.ts                   root, legacy detection, developer, journal facts
src/trellis-lite/snapshot.ts               the project-memory section
src/trellis-lite/frontmatter.ts            frontmatter parser
src/trellis-lite/glob.ts                   glob validation, compilation, specificity
src/trellis-lite/spec-inject.ts            spec index, matching, markers, budgets
src/trellis-lite/text.ts                   character truncation
src/trellis-lite/journal.ts                entries, numbering, rollover, index.md blocks
src/trellis-lite/init.ts                   skeleton
src/trellis-lite/migrate/edits.ts          AGENTS.md / settings / gitignore edits
src/trellis-lite/migrate/run.ts            classification, apply, stale references, path hints
src/trellis-lite/migrate/cli.ts            human report, CLI entry
trellis-lite/bin/trellis-lite.ts           CLI: journal, migrate
trellis-lite/skills/trellis-{spec,journal,plan}/SKILL.md
trellis-lite/prompts/migrate.md            the /trellis-lite-migrate prompt
trellis-lite/upstream.json                 upstream baselines and watched paths
.pi/prompts/trellis-lite-upstream.md       maintainer prompt, visible only in this repository
scripts/check-upstream-trellis.mjs         upstream check (read-only)
docs/trellis-lite-upstream.md              baselines, rules, decision log
test/trellis-lite-{core,specs,journal,migrate}.test.ts, test/trellis-lite-fixtures.ts
```

`package.json` `pi.skills` is unchanged; `pi.extensions` already loads `./extensions`.

## 11. Tests and verification

**Unit tests** (`node:test`): root walk (subdirectory, `.git` stop, `$HOME`, symlinked or empty `.trellis`); zero effect outside Trellis projects; legacy detection; the exact section bytes, caps, size fallback, and stability across turns; frontmatter forms and errors; every glob rule and specificity; injection budgets, CJK truncation, once per session, re-attach after a change or compaction, rebuilding from the transcript, `apply_patch` paths, nested and failed calls; journal numbering, rollover, index blocks, CLI; init idempotence; every migration category including `.pyc` noise and the no-hash-table fallback, `AGENTS.md` byte preservation and malformed markers, settings and gitignore edits, dirty tree and non-git refusal, convergence, later host removal, word-bounded stale references.

**End to end** on a copy of weibi-bot in `/tmp` (tracked files plus its ignored Trellis files; the original was only read), with an isolated `PI_CODING_AGENT_DIR` holding only pi-preset, using Opus 5.5:

| Case | First-turn input |
|---|---|
| Plain directory, trellis-lite on | 7,886 |
| Plain directory, `PI_PRESET_TRELLIS=off` | 7,886 (no effect outside Trellis projects) |
| Spec/workspace/tasks copy, no `AGENTS.md` | 8,515 (trellis-lite: +629) |
| weibi-bot copy with Trellis 0.6.17 | 15,070 |
| Same copy after `/trellis-lite-migrate` | 8,860 (−6,210, −41%) |

The migration ran with the real prompt (confirmations pre-granted for the rehearsal):
- spec, workspace, and tasks are byte-identical before and after;
- every registered template except the kept `.claude/` group is gone, and no path outside the Trellis areas changed;
- the release procedure is complete in `.pi/prompts/release.md` (all seven steps, adjusted to `git mv` and `trellis-journal`), and "no subagents, work on dev" remains in `AGENTS.md`;
- the second dry run reports "Nothing to do".

A live session confirmed that reading `src/domain/models.py` attached the database spec, truncated at 6000 characters, and that the journal skill appended session 35 and updated `index.md`.

The isolated environment has no user-level extensions, skills, or prompts, so its absolute numbers are lower than on the user's machine; the differences carry over.

## 12. Following upstream

See [`trellis-lite-upstream.md`](trellis-lite-upstream.md): baselines, watched paths, evaluation rules, decision log, `scripts/check-upstream-trellis.mjs`, and `/trellis-lite-upstream`. Baselines move only after the user confirms. Run monthly or after an upstream release; there is no scheduled job.

## 13. Not done, on purpose

- Multiple hosts, configurators, `init/update/migrations` version machinery; workflow variants; a `workflow.md` state machine; `task.py` and `task.json` status; jsonl manifests; review gates.
- Per-turn injection: breadcrumbs, runtime context, a repeated overview, first-reply notices, `<workflow-state>`.
- Subagent tools and agent definitions, channels, ablate/restore, bash rewriting, `TRELLIS_CONTEXT_ID`, Python per turn.
- Any Python.
- `trellis mem`, spec-bootstrap, session-insight, meta.
- Time-based spec reminders.
- Automatic commits (journal, archive, migration).
- Converting tasks into research topics.
- Any project-specific procedure (such as releases) built into the framework.

## 14. Implementation commits

1. `feat(trellis-lite): project root, project-memory section, project-scoped skills`
2. `feat(trellis-lite): path-scoped spec injection`
3. `feat(trellis-lite): journal script and init`
4. `feat(trellis-lite): migrate from Trellis`
5. `docs: trellis-lite upstream tracking`
6. `docs: trellis-lite in the README; design doc in English with measurements`

## 15. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Name | `trellis-lite` |
| 2 | Who runs the migration | The agent runs the CLI after confirming with `ask_user_question`; apply first, then the needs-review files |
| 3 | Path-scoped budgets and reminders | 6000 / 8000 / 40000 characters; each spec once per session, again only after a change or compaction |
| 4 | Document language | English, like the README |
| 5 | break-loop and brainstorm | Folded into `trellis-spec`; `trellis-plan` uses `grilling` |
| 6 | Research and `mem` | Research listed when present; no `mem` |
