# The skill store

pi loads every skill in `~/.pi/agent/skills`, `~/.agents/skills`, and a project's `.agents/skills` into every session: each costs a line in the system prompt and shows up in every project, which is fine for two or three skills and wrong for a shelf of them. The store (`extensions/skills-store.ts`) keeps skills on disk but out of pi's sight, and reports only the enabled ones through `resources_discover`.

## Two layers

| Layer | Where | What |
|---|---|---|
| Bundled | `skills-store/<group>/<name>/` in the preset | Shipped with the preset, **not** listed in `package.json` `pi.skills`, so pi never loads them on its own |
| Local | `~/.pi/agent/pi-preset/skills/<name>/` | Installed from GitHub, created with the tool, or moved in from pi's own directories |

Same name: the local one wins.

## Groups

Every skill belongs to a group, and the menu shows the store group by group: bundled groups first (`pi-preset` on top), then one group per repository skills were installed from (`owner/repo`, read from the install record), then `local` for skills created with the tool or moved in from pi's directories. A group row shows how many of its skills are on; selecting it enables all of them at a level, turns them all off, checks or installs updates for the whole group, or removes it.

The bundled groups:

| Group | Skill | For |
|---|---|---|
| `pi-preset` | `skill-authoring` | How to write a pi skill and where to put it (skill vs prompt template, frontmatter, no environment details, `skills create`) |
| | `git-conventions` | House rules for git and GitHub: commit message format, one change per commit, branches and force-push rules, PR and issue templates, releases, the `gh` commands |
| | `grill-me` | A relentless interview about a plan, round by round through `ask_user_question` (`/skills use grill-me <plan>`); upstream's grill-me and grilling as one skill |
| | `handoff` | A handoff document for a fresh session (`/skills use handoff [focus]`) |
| `humanizer` | `humanizer-zh`, `humanizer` | Remove AI-writing tells from Chinese / English text (op7418/Humanizer-zh, blader/humanizer; MIT) |
| `anthropics` | `frontend-design`, `mcp-builder`, `skill-creator`, `webapp-testing` | From anthropics/skills (Apache-2.0): distinctive web UI, building MCP servers, designing larger skills, Playwright testing of a local web app |

The vendored groups are recorded in `vendor/UPSTREAM.json` with their upstream commit and followed with `npm run upstream -- status | diff | pull` like the extensions. Anthropic's docx/xlsx/pptx/pdf skills are under a proprietary license and cannot be redistributed here; they are on the recommended list instead.

`skill-authoring` and `git-conventions` are **enabled always** by default: they are short, and their value is that every session follows the same rules. Turn either off from `/skills`; the choice sticks (a default added by a later version is enabled once, then left to you).

Skills about your own machines do not belong in a public preset even without addresses in them: the procedures alone describe the setup. Keep those in a private repository and install them into the local store (`/skills install git@github.com:you/ops-skills.git`); that is what the store is for.

## Levels

A skill is off, or enabled at exactly one level:

| Level | Lasts | Stored in |
|---|---|---|
| session | until pi exits (kept across `/new`) | `~/.pi/agent/pi-preset/skills-session-<pid>.json`, removed on quit; stale files are swept at startup |
| project | every session started in this directory | `~/.pi/agent/pi-preset/skills-state.json`, keyed by directory (nothing is written into the project) |
| always | every session | the same file |

Enabling from `/skills` reloads at once, so the skill is listed for the model and `/skill:name` works. Turning off takes effect at the next reload too.

## `/skills`

The menu lists the store, enabled skills first (session, project, always) and the rest by name, each with its level; typing filters the list. Then: let the agent find one, install from GitHub or a path, recommended skills, search skills.sh, check updates (when something was installed from a repository), and move skills out of pi's directories (when they hold any). A skill's own menu: **use now**, enable at a level, turn off, show SKILL.md, check for an update / update, remove (local skills only).

- **Let the agent find one** is for needs you cannot name: describe the task in your own words and the agent derives the search queries, checks the store and the recommended list before skills.sh, and comes back with up to five candidates and one recommendation. It installs nothing until you answer. (`/skills find <what you need>` does the same.)

- **Use now** sends the skill into the conversation the way `/skill:name` does, without a reload. For a one-off task.
- **Install** takes `owner/repo`, `owner/repo@skill`, a GitHub URL (`/tree/<ref>/<path>` included), any git URL, or a local directory. The repository is cloned shallowly to a temp directory, the skill directories are listed, and the chosen one is copied into the local store with a `.pi-preset-source.json` (source, path, commit). Nothing from the download is executed. When a source holds several skills and no `@name` is given, the menu asks which.
- **Recommended** is a short curated list (`CURATED` in `src/skills-store/catalog.ts`) of skills that are not bundled: officecli (the officecli binary's own skill; it installs the binary on first use), Anthropic's docx/xlsx/pptx/pdf (proprietary license), superpowers' systematic-debugging and brainstorming, and Vercel's React best practices. "All n" installs the whole list with one clone per repository.
- **Search skills.sh** queries the registry `npx skills find` uses (its JSON endpoint; the CLI as a fallback) and shows install counts.
- **Check updates** runs one `git ls-remote` per installed skill and compares with the recorded commit. Nothing is checked at startup.
- The first time `/skills` opens and `~/.pi/agent/skills` or `~/.agents/skills` hold skills, it offers to move them into the store (copied in, originals go to `~/.pi/agent/pi-preset/skills-import-backup/<stamp>/`). Declining is remembered; the item stays in the menu.

Typed forms: `/skills list`, `/skills use <name> [request]`, `/skills enable <name> [session|project|always]`, `/skills off <name>`, `/skills install <source>`, `/skills search <query>`, `/skills find <what you need>`.

## The `skills` tool

The model gets the same store as a tool, so "find me a skill for X" works end to end:

| Action | Does |
|---|---|
| `list` | the store with levels, plus recommended skills not yet installed |
| `search` | the store, the recommended list, and skills.sh, in that order |
| `use` | returns a skill's instructions and directory, no state change |
| `enable` | marks it enabled (session by default; never demotes) and returns the instructions |
| `install` | fetches a source; **asks you to confirm** each skill before copying |
| `create` | validates a SKILL.md (frontmatter, name rule, description length) and writes it into the local store |

A tool cannot reload pi, so a skill enabled by the model is in effect for the task at once but appears in the system prompt's skill list only after the next `/reload`. The status bar shows a `*` on the skills count while that is the case.

## Status bar

A `⬢ n` segment appears while `n` skills are enabled for the session (`n*` when one waits for a reload). Project and always-on skills are steady state and are not shown.

## Files

| | |
|---|---|
| `extensions/skills-store.ts` | the command, the tool, `resources_discover`, the footer snapshot |
| `src/skills-store/catalog.ts` | store layout, frontmatter, validation, the curated list |
| `src/skills-store/state.ts` | levels, the state and session files |
| `src/skills-store/install.ts` | sources, clone, candidates, install records, update checks, create |
| `src/skills-store/search.ts` | store/curated matching, the skills.sh endpoint and CLI parsing |
| `src/skills-store/import.ts` | moving skills out of pi's directories |
| `src/skills-store/use.ts` | the `/skill:name` message shape |
| `skills-store/` | the bundled skills |
