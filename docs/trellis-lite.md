# Project memory: trellis-lite

[`extensions/trellis-lite.ts`](../extensions/trellis-lite.ts) keeps the useful part of [Trellis](https://github.com/mindfold-ai/Trellis) — specs, the developer journal, and task notes in `.trellis/` — without its workflow machinery. It reads and writes the same files, so a Trellis project keeps its data as it is. The design draws on Trellis and [mini-trellis](https://github.com/Tiger-zzZ/mini-trellis); it is an independent implementation, not a Mindfold product, and shares no code with either (see [`docs/trellis-lite-design.md`](trellis-lite-design.md)).

It acts only in a Trellis project: the nearest directory above the session's working directory (up to the repository root) with a `.trellis/` holding `spec/`, `workspace/`, `tasks/`, or `.developer`. Anywhere else it adds nothing: no prompt text, no skills, no tool-result changes. In a Trellis project:

- **A `project-memory` system prompt section** lists the spec indexes, the journal (with its session and line count), open tasks, and research notes by path, never their contents. It is computed once per session and sent byte for byte on every turn, so the cached prefix holds.
- **Three skills**, offered only in Trellis projects (through pi's `resources_discover`): `trellis-spec` writes a rule that should still hold next week into `.trellis/spec/` and links it from the index (including the after-a-bug analysis), `trellis-journal` appends a session entry, `trellis-plan` plans a task as `prd.md` / `design.md` / `implement.md` in `.trellis/tasks/MM-DD-slug/` (decisions through `grilling`) and archives it to `tasks/archive/YYYY-MM/` when done.
- **Path-scoped specs.** A spec with `paths:` globs in its frontmatter is appended to the result of a `read`, `edit`, `write`, or `apply_patch` of a matching file, so the rule is in context before the change. Each spec is attached once per session; it comes back only when the spec file changed, after compaction, or on another `/tree` branch. Budgets: 6000 characters per spec (longer ones are cut with a pointer to the file), 8000 per tool result, 40000 per session; past them a spec is listed by path and description.
- **The journal** is written by a small script the skill runs (`node trellis-lite/bin/trellis-lite.ts journal`), in Trellis's journal format: numbering continues, a full file (2000 lines, or `max_journal_lines`) rolls over to the next `journal-N.md`, and the developer's `index.md` tables are refreshed. Nothing is ever committed.

There is no per-turn injection, no tool, no task state, no subagent, and no Python. On a copy of a real Trellis project (16 specs, 34 journal sessions, no open task), the first request went from 15,070 tokens with Trellis 0.6.17 to 8,860 after migrating; trellis-lite's own share is about 630 tokens (section and three skill entries).

```
/trellis-lite            menu: status on top (root, section size, path-scoped specs, frontmatter errors);
                         Initialize only when .trellis/ or .developer is missing, migrate items only
                         while old Trellis assets are installed, else "Show the project-memory section"
/trellis-lite status     the same status plus the section as sent, as one message
/trellis-lite init       create what is missing: .trellis/spec/index.md, .developer, the first journal, .gitignore entry
/trellis-lite migrate    dry-run plan for leaving Trellis (read-only)
/trellis-lite-migrate    let the agent carry out the migration, asking before each change
```

**Switches.** `PI_PRESET_TRELLIS=off` turns it off; `PI_PRESET_TRELLIS_SPECS=off` keeps everything except path-scoped specs. It is also an ordinary extension of this package: untick `extensions/trellis-lite.ts` in `pi config`, or exclude it in a project's `.pi/settings.json` package filter.

**Coming from Trellis.** While the project still has Trellis's (or mini-trellis's) pi assets — `.pi/extensions/trellis/`, `.agents/skills/trellis-*`, `.pi/prompts/trellis-*` — trellis-lite stays idle and says so once per session. `/trellis-lite-migrate` hands the agent a procedure:

1. The CLI classifies every file Trellis installed, using Trellis's own `.trellis/.template-hashes.json`: unmodified templates and runtime leftovers (`.runtime/`, `.backup-*`, `__pycache__`) are deleted; `AGENTS.md`, `.pi/settings.json`, and the `.gitignore` files lose only their Trellis parts; spec, workspace, and tasks are never touched; files of other hosts (`.claude/`) stay unless you choose to remove them; modified or unregistered Trellis files are kept for review. It refuses to apply outside git or with uncommitted changes, so `git` is the undo.
2. The agent diffs each kept file against the original template of your Trellis version and moves what the project added: procedures (a release flow) into `.pi/prompts/<name>.md`, standing rules into `AGENTS.md`; Trellis mechanics are dropped. Every write waits for your confirmation.
3. It lists references to removed machinery in specs and `AGENTS.md`, suggests `paths:` for specs, and proposes a commit message. Nothing is committed without your approval.

**Following upstream.** trellis-lite follows Trellis (beta and stable) and mini-trellis for behavior and format changes, not code: `node scripts/check-upstream-trellis.mjs` lists what changed on the watched paths since the recorded baselines, and [`docs/trellis-lite-upstream.md`](trellis-lite-upstream.md) holds the evaluation rules and the decision log. In this repository, `/preset-upstream trellis` has the agent review the changes under the clean-room rules. Run it monthly or after an upstream release.
