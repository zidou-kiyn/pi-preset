# Skills

`grill-me` and `grilling` are adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills)
(`skills/productivity/grill-me` and `skills/productivity/grilling`, commit
`49dd158d1076134a641b33efb035946536778336`, 2026-10-09). They are maintained here and are not
synced from upstream automatically; compare against upstream by hand when it changes.

Changes from upstream:

- `grill-me` loads `grilling` by reading its SKILL.md instead of calling a `Skill` tool, which pi does not have.
- `grilling` asks each round through the `ask_user_question` tool (at most 4 questions per call, the
  recommended answer as the first option) and keeps the numbered text format only as a fallback.
- Fact finding uses the agent's own tools or `agent_bg` instead of a sub-agent tool.
- The session ends with a summary of the settled decisions before asking for confirmation.

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
