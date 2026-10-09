Migrate this project from Trellis (or mini-trellis) to trellis-lite. Go through the steps below in order. Show me each result, and wait for my confirmation wherever a step says so. Never commit until I approve the message in step 8.

The migration CLI is `node "{{CLI}}" migrate`. Run it from the project root. Deletion and the exact edits are decided by the CLI; your part is to run it, ask me, and handle what needs judgment.

1. **Plan and apply.** Run `node "{{CLI}}" migrate --json` and summarize it: what gets deleted (by group, not file by file), each exact edit, other hosts' Trellis files, files that need review, and `trellisVersion` (step 2 needs it; apply deletes `.trellis/.version`).
   - If `git.clean` is false, stop: list the uncommitted files and ask me to commit or stash them. Do not commit, stash, or restore anything yourself.
   - Otherwise ask me with `ask_user_question`: apply / apply and also delete the Trellis files of the other hosts (name them, e.g. `.claude/`) / cancel.
   - On approval run `node "{{CLI}}" migrate --apply --yes`, adding `--remove-hosts <names>` if I chose that, and show me the output.

2. **Files that need review** (`needsReview`). They were kept because the project changed them or Trellis did not register them. For each one:
   - Get the original: in a temporary directory run `npm pack @mindfoldhq/trellis@<trellisVersion>` and extract it. Templates are under `package/dist/templates/` (`.trellis/workflow.md` is `trellis/workflow.md`; search by file name for others). Diff the original against the project's file. Only what the project added matters.
   - Sort each addition:
     - a procedure someone runs on demand (release, deploy, review checklist) → a prompt template `.pi/prompts/<name>.md`, which becomes `/<name>`. Write it as self-contained instructions with the concrete commands, and give it a `description:` frontmatter line;
     - a standing rule (for example "never dispatch subagents", "work directly on the dev branch") → `AGENTS.md`, outside any managed block, unless it is already stated there;
     - Trellis mechanics (phase numbers, subagent dispatch, jsonl curation, platform lists, `task.py` commands) → drop it, and tell me what you dropped.
   - Show me every new or changed file in full and wait for my confirmation before writing it. Once the content has moved and I confirm, delete the reviewed file with `git rm`.

3. **Stale references** (`staleReferences`, in specs and `AGENTS.md`). For each, propose a replacement: journal entries through the `trellis-journal` skill, planning through `trellis-plan`, spec updates through `trellis-spec`; references to subagents, phases, or Trellis commands go. Change them only after I confirm.

4. **Open tasks** (`activeTasks`). Keep the directories. trellis-lite does not read their `task.json` or `*.jsonl` files; suggest leaving them until the task is archived.

5. **Path-scoped specs** (`pathHints`). Suggest `paths:` frontmatter for specs that clearly govern one area of the code, with the globs you would use. Explain that a matching spec is then attached when the agent reads or edits a file there. Only suggest; edit specs only if I ask.

6. **Check.** Run `node "{{CLI}}" migrate` again and confirm nothing is left to delete, edit, or review (kept files of other hosts are informational).

7. **Measure.** Tell me to run `/reload` or start a new session, so trellis-lite takes over. The first-turn input is the `usage` of the first assistant message (`input + cacheRead + cacheWrite`) in the newest session file under `~/.pi/agent/sessions/<cwd-slug>/`. If I give you the session files from before and after, compare them.

8. **Commit.** Propose one commit message for the whole migration and wait for my approval before committing.
