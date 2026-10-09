---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the frontier in one round, give your recommended answer for each question, then wait for the user's answers before the next round.

## Asking a round

Ask every round with the `ask_user_question` tool, one question per frontier decision:

- `question`: the full question, ending with a question mark. Put the context the user needs to decide into it.
- `header`: a short tag for the decision (16 characters at most).
- `options`: 2-4 concrete answers. Put your recommended answer first and end its label with "(Recommended)". Each option's `description` states what choosing it means or costs. The user can always type their own answer, so never add an "Other" option.
- `multiSelect: true` only when several answers can hold at once.

The tool takes at most 4 questions per call. When the frontier is larger, ask the 4 most fundamental decisions now, the ones the most other questions hang off. The rest stay on the frontier for the next round. Make exactly one `ask_user_question` call per round, then stop and wait.

A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

If `ask_user_question` is not available, ask the round as text instead: number each question (`**Q1** - **<title>**: <question>`), follow each with `➡️ <your recommended answer>`, and word each question so "yes" accepts your recommendation.

## Between rounds

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. Briefly restate what the last round settled before asking the next one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (files, tools, configuration, documentation), look it up yourself with your tools before asking. Delegate a long exploration to a background agent (`agent_bg`) when one is available, and don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for its report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Finishing

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Summarize the settled decisions as a list, then ask the user to confirm that you have reached a shared understanding. Do not act on the plan until they confirm.
