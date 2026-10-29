---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the OS temporary directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows), not the current workspace, under a name that says what the work is, e.g. `pi-handoff-<topic>-<YYYYMMDD-HHMM>.md`.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the document to it.

What goes in:

- The goal, what is done, what is in flight, and the next steps, with the reasons that bear on them.
- Decisions already settled with the user, so the next agent does not ask again.
- A "suggested skills" section naming the skills the next agent should load (by name, from its available skills list).

Keep it short:

- Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs, `.trellis/` specs, journal and task plans). Reference them by path or URL instead.
- The next agent trusts this document and will not re-check it. State as fact only what this session verified; mark anything assumed or untested as such.
- Redact any sensitive information, such as API keys, passwords, tokens, or personally identifiable information.

When the file is written, reply with its absolute path and how to continue:

- New session, same directory: run `/new`, then send `Read <path> and continue the work it describes.`
- Somewhere else (another directory, harness, or person): copy the file somewhere durable first, since temporary directories get cleared.
- A side task while this session keeps going: start it with `agent_bg`, pointing the prompt at the file instead of pasting its content.
