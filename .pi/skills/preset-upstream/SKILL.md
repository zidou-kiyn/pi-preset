---
name: preset-upstream
description: Review upstream changes to everything pi-preset maintains (vendored extensions, termius-mcp, chrome-devtools-mcp pin, store skills, trellis-lite clean-room references) and carry over what the user picks. Use in the pi-preset repository when asked to check upstream, update vendored packages, bump chrome-devtools-mcp, sync ported skills, or follow Trellis/mini-trellis. Arguments narrow the scope - package names, mcp, skills, trellis; none means everything.
---

# preset-upstream

Everything here is our own maintained copy, often with local changes; nothing follows upstream automatically. Work one upstream change at a time: understand it, judge it against our copy, then take it, take it adapted, or skip it. Answer in the language the user writes in.

Scope: the arguments after the command (package names, `mcp`, `skills`, `trellis`); none means everything. Read only the references the scope needs.

| Kind | Read |
|---|---|
| Vendored packages and termius-mcp (`vendor/UPSTREAM.json`) | `references/vendored.md` |
| chrome-devtools-mcp version pin | `references/chrome-devtools-mcp.md` |
| Store skills (Pocock ports by hand, listed in `skills-store/pi-preset/NOTICE.md`; `skill-*` vendored) | `references/skills.md` |
| trellis-lite (AGPL upstream, clean room) | `references/trellis-lite.md` |

## Procedure

0. Run `git status`. If the tree is dirty, stop and ask.
1. **Check (read-only).** Follow the *Check* section of each reference in scope.
2. **Judge, report, ask.** For each upstream change, say in your own words what it does, then answer:
   - Which `localChanges` entry does it meet, if any? Does upstream now cover it, conflict with it, or leave it alone?
   - Does our copy have the defect it fixes?
   - Is it released? Unreleased work on a non-default branch is "wait", unless it fixes something we hit.
   - Is it security-relevant (secrets, host keys, redaction, network, permissions)? Say so explicitly.
   - trellis-lite: how does it fare under the evaluation rules?

   Report one table per kind with changes: change | what it does | meets local change | **take / take adapted (how) / skip (why) / wait**. Put the kinds without changes on one line. Then ask with `ask_user_question` (multi-select, recommended first). Change nothing before the user answers.
3. **Carry over what was chosen.** Follow the *Carry over* section of each affected reference.
4. **Verify.**
   - `npm test`, plus `npm run test:termius` if termius-mcp changed.
   - `grep -rn '^<<<<<<<\|^>>>>>>>' vendor skills-store` returns nothing.
5. **Finish.** Summarize what was taken, adapted, skipped, or deferred, with the test results. Propose commit messages, one per unrelated component (`chore(upstream): ...`, `feat(trellis-lite): ...`).

## Rules

- Never commit, push, tag, move a trellis-lite baseline, or release unless the user says so.
- Every skipped change gets a recorded reason (see the reference for where).
- If a reference and the repository disagree (a moved file, a renamed script), trust the repository and say so in the report.
