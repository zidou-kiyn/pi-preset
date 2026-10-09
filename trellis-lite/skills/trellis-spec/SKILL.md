---
name: trellis-spec
description: Record a rule that should still hold next week in .trellis/spec/ and link it from the matching index.md. Use after settling a convention, after fixing a bug whose cause could recur, or when the user asks to remember a rule.
---

# Write a spec rule

Specs are the project's durable rules: what code in an area must do, and why. They are read before editing that area, so every line costs future context. Write little, and only what is true.

## Is it worth a spec?

Write it only if all three hold:

1. It will still be true next week (not a one-off workaround, not the state of a branch).
2. Someone reading the code could not see it, or would plausibly get it wrong.
3. It is a rule, not a story. Narratives of what happened belong in the journal.

If one fails, say so and stop.

## Where it goes

- Specs live in `.trellis/spec/<layer>/` (monorepos: `.trellis/spec/<package>/<layer>/`); cross-cutting thinking guides in `.trellis/spec/guides/`.
- Read the layer's `index.md` first. Extend the file that already covers the topic; create a new file only for a new topic.
- Every spec file is linked from its layer `index.md` with one line saying when to read it. Add the line when you add a file.
- Edit the existing rule if the new knowledge replaces it. Never leave two versions of the same rule.

## How to write it

- One concrete rule per heading. State it as an instruction.
- Add **Why**: the failure it prevents, in one or two sentences.
- Add a short correct example and, when it is easy to get wrong, the wrong version next to it.
- When the rule is a contract, write the contract: function or command signature, required fields, error behavior, the test that guards it.
- Name real files and symbols so the reader can verify the rule.
- Match the language the existing specs are written in.

## Attach it to paths (optional)

A spec with `paths:` in its frontmatter is attached automatically when the agent reads or edits a matching file:

```markdown
---
description: one line shown when the spec is listed instead of attached
paths:
  - src/db/**
  - src/domain/models.py
---
```

Globs are relative to the repository root and use `/`: `*` stays inside one path segment, `?` is one character, a whole `**` segment spans any number of directories, and a trailing `/` means everything below. Keep globs narrow; a spec matched by half the repository is attached all the time.

## After a bug that could come back

Before writing, work out:

1. **Cause class**: what kind of mistake this was (wrong assumption about an API, missing state transition, unit mix-up, race, environment difference), not just the line that was wrong.
2. **Why earlier fixes failed**, if there were several attempts: what each one assumed.
3. **What would have stopped it**: a test, a type, an assertion, a lint rule, or a spec rule. Add the cheapest one that catches the whole class.
4. **Where else it can happen**: search for the same pattern and list or fix the other places.

Then record the rule from step 3 as above. The analysis itself goes in your reply or the journal; the spec keeps only the rule and its why.

## Finish

Show the user the diff of the spec and index changes. Do not commit unless the user asks.
