---
name: git-conventions
description: House rules for git and GitHub so every session works the same way - commit message format, what goes in one commit, branches and pull requests, issues, releases, and the gh commands to use. Use whenever asked to commit, push, open or review a PR, file or triage an issue, tag a release, or otherwise touch git or GitHub.
---

# git-conventions

Read the repository's own `CONTRIBUTING.md` / `docs/development.md` first; it wins over this file. Look at `git log --oneline -20` before the first commit in a repository and match what is there.

## Before committing

- `git status` and `git diff --stat`: know what is staged. Never `git add -A` blindly in a repository you did not just create; add the files you changed.
- Never commit secrets, `.env`, credentials, local config, or generated/large artifacts. When unsure, ask.
- Run the project's tests/lint when they exist; a commit that breaks them needs a reason in the message.
- Leave the user's unrelated uncommitted changes alone; do not stash or reset them.

## Commit messages

```
type(scope): what changed, as one lowercase line, imperative, no period

Why it changed, in prose: the problem, the decision, what was considered
and rejected. Facts and measurements over adjectives. Wrap at 72.
```

- `type`: `feat` `fix` `docs` `refactor` `perf` `test` `chore` `build` `ci` `style` `revert`. `scope` = the area (a package, command, or feature name); several as `a,b`. Omit the scope only when the change is repository-wide.
- Subject ≤ 72 characters, describes the effect, not the activity ("compact tool rows", not "update compact-tools.ts"). No "WIP", no emoji, no trailing period.
- Body for anything non-trivial. Explain *why* and what the user sees; the diff already shows *how*. Reference issues as `#123` or `Closes #123`; cite upstream issues/PRs with their URL or `(#5777)`.
- One logical change per commit. Formatting-only changes go in their own commit. Do not bundle "and also fixed a typo".
- `chore(upstream): <package> <version> (<one-line summary>)` for vendored updates.
- Breaking change: `!` after the scope (`feat(api)!: …`) and a `BREAKING CHANGE:` paragraph in the body.

## Branches and pushing

- Small, self-contained work on the default branch is fine for a personal repository. Anything that takes several commits or needs a review goes on a branch: `type/short-topic` (`feat/skill-store`, `fix/esc-over-ssh`).
- `git pull --rebase` before pushing; never merge the default branch into a topic branch, rebase onto it.
- Never force-push a shared branch. On a topic branch you own, `git push --force-with-lease` is fine after a rebase; say so when you do it.
- Never rewrite history that has been pushed to the default branch unless the user asks for exactly that (and then `--force-with-lease`, after confirming).
- Do not push unless asked, or the user's instructions for the task clearly include it. Say what was pushed where.

## Pull requests (`gh pr`)

- `gh pr create --title "<same format as a commit subject>" --body-file -` with this body:

```
## What
One paragraph: the change and its effect for the user.

## Why
The problem or request. `Closes #N` when it closes an issue.

## How to verify
Commands or steps a reviewer can run. Note what was not tested.
```

- Keep a PR to one topic; split otherwise. Squash fixup commits before marking ready (`git rebase -i`), keep meaningful commits separate.
- Draft (`--draft`) while work is incomplete. Reviewers only when the user names them.
- Reviewing: `gh pr view N --comments`, `gh pr diff N`. Comments state the problem and a concrete suggestion; approve or request changes explicitly, do not leave a review hanging.
- Merge only when asked: `gh pr merge N --squash --delete-branch` by default; `--merge` when the commits are meaningful on their own; never `--rebase` onto a protected branch without being told.

## Issues (`gh issue`)

- Search first: `gh issue list --search "<words>" --state all`. Comment on a duplicate instead of opening a new one.
- Title: the symptom or the request in one line, no "Bug:" prefix (labels do that).
- Body: what happened / what was expected / how to reproduce (versions, commands, minimal input) / what was already tried. Logs in a fenced block, trimmed to the relevant lines, secrets removed.
- Triage: `gh issue comment` with findings and a next step; close with `gh issue close N --comment "<why>"`; link the fixing PR with `Closes #N` in its body rather than closing by hand.

## Releases and tags

- Tags are `vX.Y.Z` (semver). Bump the version in the manifest in the same commit as the tag, subject `release: vX.Y.Z` unless the project has a release script (then run it).
- `gh release create vX.Y.Z --generate-notes`, then edit the notes into the sections *Added / Changed / Fixed / Removed*; keep upstream-vendored bumps in one line each.

## Reporting back

After git or GitHub work, give the user: the commit hashes and subjects (or the PR/issue URL), the branch, and whether anything was pushed. Nothing else.
