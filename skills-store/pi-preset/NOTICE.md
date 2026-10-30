# Skills

These are adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills). They are maintained here
and are not synced from upstream automatically; compare against upstream by hand when it changes.

| Here | Upstream path(s) | Commit |
|---|---|---|
| `grill-me` | `skills/productivity/grill-me`, `skills/productivity/grilling` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` (2026-10-27) |
| `handoff` | `skills/productivity/handoff` | `59db609eb1e18aaf59b63284d0e52255aff0c63c` (2026-10-27) |
| `codebase-design` | `skills/engineering/codebase-design` | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (2026-10-29) |
| `diagnosing-bugs` | `skills/engineering/diagnosing-bugs` | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (2026-10-29) |
| `skill-authoring/references/writing-for-agents.md` | `skills/productivity/writing-for-agents` | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (2026-10-29) |

Changes from upstream in `grill-me` (upstream's `grill-me` + `grilling`):

- The two are one skill here: upstream's `grill-me` only loaded `grilling` through a `Skill` tool pi does not
  have, so `grill-me` carries the `grilling` instructions itself and the model may also load it on its own.
- It asks each round through the `ask_user_question` tool (at most 4 questions per call, the
  recommended answer as the first option) and keeps the numbered text format only as a fallback.
- Fact finding uses the agent's own tools or `agent_bg` instead of a sub-agent tool.
- The session ends with a summary of the settled decisions before asking for confirmation.

Changes from upstream in `handoff`:

- Suggested skills are named for the next agent to load from its skills list, since pi has no `Skill` tool.
  The `argument-hint` field is dropped; arguments after `/skill:handoff` reach the skill as the user's request.
- The file name says what the work is, and `.trellis/` specs, journal, and task plans count as artifacts to reference.
- Claims the session did not verify are marked as assumptions (upstream gives this advice in its docs).
- The reply ends with the path and how to continue in pi: `/new` plus a read instruction, a durable copy for
  another place, or `agent_bg` for a side task.

Changes from upstream in `codebase-design`:

- The description lists the situations that should trigger it (new structure, refactoring, seams, testability,
  shallow pass-through layers) instead of naming other skills, since pi has no `Skill` tool for skills to call each other.
- `GLOSSARY.md` becomes the project's own domain terms wherever it documents them.
- `DESIGN-IT-TWICE.md`: the parallel sub-agents are `agent_bg` runs, each answering in its final reply. `DEEPENING.md`
  is unchanged. The `agents/openai.yaml` file is dropped.

Changes from upstream in `diagnosing-bugs`:

- The description says what the skill does as well as when to use it.
- The human-in-the-loop step uses `ask_user_question` rounds instead of `scripts/hitl-loop.template.sh`: pi's `bash`
  has no terminal the user can type into, so the script would hang. The script and `agents/openai.yaml` are dropped.
- The ranked hypotheses go into the reply and the work carries on; upstream waits unless the user is away, which the
  agent cannot tell.
- Long reproduction loops run in the background; the confirmed hypothesis goes into the final reply when nothing is committed.

Changes from upstream in `writing-for-agents` (a reference of `skill-authoring`, not a skill of its own):

- The frontmatter is dropped, and upstream's `SKILL-MECHANICS.md` is replaced by a closing section on how a skill reaches
  the agent in pi: listed, off in the store but named by a pointer, or user-invoked. Router skills are left out.

Upstream license:

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
