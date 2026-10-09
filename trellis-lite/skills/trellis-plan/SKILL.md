---
name: trellis-plan
description: Plan a multi-step task as files in .trellis/tasks/MM-DD-slug/ (prd.md, optional design.md and implement.md), and archive it when done. Use when the user wants a task planned before coding.
---

# Plan a task

A task is a directory of plain Markdown. There is no status field, no task tool, and nothing is injected automatically; the files exist so the plan survives the session and can be reviewed.

## 1. Gather facts first

Read the code, the relevant spec index, and recent journal entries before asking anything. Questions are for decisions only the user can make: scope, trade-offs, priorities. Never ask what you can look up.

## 2. Settle the decisions

Use the `grilling` skill for the interview: a few questions per round through `ask_user_question`, each with your recommendation first. Stop asking once every decision that changes the plan is made.

## 3. Write the files

Create `.trellis/tasks/<MM-DD>-<slug>/` (today's month and day, a short kebab-case slug):

- `prd.md` (always): the goal, who it is for, acceptance criteria the user can check, and what is explicitly out of scope.
- `design.md` (when there is a real design choice): the approach, alternatives rejected and why, data or interface changes, risks.
- `implement.md` (when the work has more than a few steps): ordered steps, the spec files to read for each, and the commands that verify it.
- Research material worth keeping goes in `research/` inside the task directory.

Keep each file as short as the task allows. Write in the user's language.

## 4. Stop

Summarize the plan and wait for the user's go-ahead before changing code. If the plan changes during the work, update the files.

## 5. Finish

When the work is done:

1. Move rules that should outlive the task into spec (`trellis-spec`).
2. Archive the directory: `git mv .trellis/tasks/<dir> .trellis/tasks/archive/<YYYY-MM>/<dir>` (`mv` when it is not tracked yet).
3. Offer a journal entry (`trellis-journal`).

Do not commit unless the user asks. Older tasks may contain `task.json` or `*.jsonl` files from Trellis; leave them as they are.
