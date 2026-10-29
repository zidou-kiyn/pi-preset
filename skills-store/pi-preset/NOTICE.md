# Skills

`grill-me` and `handoff` are adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills)
(`skills/productivity/grill-me`, `skills/productivity/grilling`, and `skills/productivity/handoff`, commit
`59db609eb1e18aaf59b63284d0e52255aff0c63c`, 2026-10-27). They are maintained here and are not
synced from upstream automatically; compare against upstream by hand when it changes.

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
