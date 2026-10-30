---
name: skill-authoring
description: How to write a pi skill, prompt template, AGENTS.md, or any other prompt a model reads, and where to put it. Use when the user asks to save, turn into a skill, make reusable, or "remember how to do" a procedure, or asks to write or revise a prompt, template, command, or AGENTS.md - decide the form, write the text, and store it with the skills tool.
---

# Writing a skill for pi

## Skill or prompt template?

| The user wants | Make | Why |
|---|---|---|
| A procedure the model should know *when* to apply, with reference files or scripts | **Skill** (`SKILL.md` directory) | pi lists name + description in every session; the body loads only when used. Shown as a collapsed box. |
| A short text they will type by hand, with arguments, every time | Prompt template (`.pi/prompts/<name>.md`, `/name args`) | Expands into the message verbatim; no routing, no bundled files. |
| A rule that applies to every message in a project | A line in `AGENTS.md` | Always in context; keep it to one sentence. |

Default to a skill. A prompt template is right only when the whole value is a fixed wording the user triggers themselves.

## Where it goes

- **The store** (default): `skills create` with `name` and `content`. Lives in `~/.pi/agent/pi-preset/skills/<name>/`, loaded only when enabled (`skills enable`, or `/skills`). Put extra files under the directory the tool reports.
- **This project only**: `.pi/skills/<name>/SKILL.md` (or `.agents/skills/`). Loaded in every session in that project once the project is trusted. Use it when the skill is about this codebase.
- Never write into `~/.pi/agent/skills/` or `~/.agents/skills/`: everything there is loaded into every session.

## SKILL.md

```markdown
---
name: <directory-name>            # lowercase letters, digits, single hyphens; ≤ 64 chars
description: <what it does> - <when to use it>   # ≤ 1024 chars; this line alone decides routing
---

# <name>

<2-6 lines: what the skill assumes, what it never does, where environment details come from>

| Task | Read / run |
|---|---|
| ... | `references/<topic>.md` |
| ... | `scripts/<name>.sh <args>` |

## Rules
- ...
```

- The **description** is the only thing the model sees before loading: state the job *and* the trigger ("Use when asked to …"). Not "Helps with X".
- Keep `SKILL.md` to one screen (≈ 2–4 KB). Details go to `references/*.md`, one file per independent step; code to `scripts/`, each with a header comment: usage, prerequisites, what it changes. Assets (templates, configs) under `assets/`.
- Paths are relative to the skill directory; pi tells the model where the directory is.
- Write instructions, not narrative: imperative sentences, tables, hard rules. Say what to verify after each change.
- **No environment specifics**: no hostnames, IPs, account names, tokens, container names, personal paths. Say where they come from instead ("the user provides ENV.md; otherwise inventory first"). Parameterize scripts with environment variables that have sensible defaults.
- Language: whichever the user works in; the frontmatter `description` in English helps routing across tools.

## Writing the text (skills, templates, AGENTS.md, prompts)

- Every always-loaded line (a description, an AGENTS.md line, a tool guideline) costs on every turn: name the material and its distinct triggers, nothing else.
- Hunt no-ops: delete any sentence the model already obeys without being told. Strong models need fewer words, plain wording (no CRITICAL / MUST), and no "double-check your work" steps.
- State the behaviour you want; a prohibition alone makes the banned behaviour more likely. Keep "never" for hard guardrails, paired with what to do instead.
- Each meaning lives in one place. Do not restate what the agent can look up (`package.json`, configs, `--help`); write down what it cannot find: conventions, reasons, gotchas.
- End every step on a checkable completion criterion.

For anything longer than a few lines, read `references/writing-for-agents.md` (pointers, progressive disclosure, completion criteria, leading words, pruning, and how a skill is reached in pi).

## After writing

1. `skills create` validates the frontmatter and writes it; fix what it reports.
2. `skills enable <name>` (session) and try it on the real task; trim what was not needed.
3. Tell the user how to make it permanent: `/skills` → the skill → *Enable in this project* or *Enable always*. A skill needed only for one rare, sharp trigger can stay off and be named by a pointer instead (see the reference).

For a skill that will run often or whose triggering must be reliable, `skills use skill-creator` (Anthropic) for its test-case, evaluation, and description-optimization loop. Where the skill goes and how it is stored still follow this skill: `skills create`, no `.skill` packaging; its sub-agent runs map to `agent_bg`, and its Claude-only scripts (`claude -p`) are skipped.
