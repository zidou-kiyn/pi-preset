---
name: trellis-journal
description: Append a session entry to the developer journal in .trellis/workspace/. Use when the user asks to record the session, or after finishing a task.
---

# Record a journal entry

The journal is the project's memory of what happened: one entry per piece of finished work, read when picking the work up again.

## What to write

- **Title**: what was achieved, in a few words.
- **Summary**: what changed and why, the decisions made and their reasons, anything left open or to do next, and facts that were expensive to find out. Write for someone resuming this work in a month. Skip the play-by-play.
- Match the language of the existing entries.

## How to write it

Run the bundled script from this skill's directory (it lives at `../../bin/trellis-lite.ts` relative to this file) with the summary on stdin:

```bash
node <skill-dir>/../../bin/trellis-lite.ts journal --title "Short title" --commits abc1234,def5678 <<'EOF'
Summary in Markdown.
EOF
```

- `--commits` lists the commits of this work (omit when there are none). Their subjects are read from git.
- `--task <dir>` names the task directory when the work had one; the title is used otherwise.
- `--status` sets the status line (default `Completed`).
- Run it from inside the project. It numbers the session, starts a new `journal-N.md` when the current one is full, fills in the branch, and updates the session table in `.trellis/workspace/<developer>/index.md` when that file has one.
- It never commits. If the project's own instructions say how journal entries are committed, follow them; otherwise leave the change for the user.

If `.trellis/.developer` is missing, the script stops and says so; ask the user to run `/trellis-lite init`.

## Looking further back

Older entries are in the earlier `journal-N.md` files. The full conversations are pi session logs in `~/.pi/agent/sessions/`, one directory per working directory; search them with grep when the journal is not detailed enough.
