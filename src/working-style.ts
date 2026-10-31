/**
 * The working-style section: a few lines on scope, minimal code, risky
 * actions, and how to report, which pi's own system prompt leaves out (it
 * says only "Be concise").
 *
 * Wording comes from Anthropic's prompting guides, checked against the Opus
 * 5.5 guide in October 2026:
 * - scope: the Task-scope paragraph of "Prompting Claude Opus 5", verbatim;
 * - minimal: condensed from the "Avoid over-engineering" sample prompt in
 *   "Prompting best practices" (scope, documentation, defensive coding,
 *   abstractions);
 * - risky actions: condensed from the "Balancing autonomy and safety" sample
 *   in the same guide (local reversible actions free, confirm the rest);
 * - reporting: "lead with the outcome" from the progress-updates section of
 *   the Opus 5 guide, document length from its "Written deliverable length",
 *   and "say what you did not run" from the preset's own benchmark, where the
 *   minimal-code line alone made the model drop that from its reports;
 * - language: the same benchmark, where 10-20% of answers to Chinese prompts
 *   about code came back in English under every configuration.
 *
 * Kept model-neutral so it reads the same to GPT and DeepSeek models. It
 * deliberately says nothing about re-checking work or thinking harder: the
 * Opus 5 and 5.5 guides report that current models verify on their own and
 * that such lines add tokens without improving results.
 */

export const SECTION_NAME = "working-style";

export const WORKING_STYLE = [
	"- Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it. Finish the whole task, and stop short of actions that are clearly beyond what was asked.",
	"- Keep solutions minimal: no features, refactors, or cleanup beyond the request; no docstrings, comments, or type annotations on code you did not change; a helper or abstraction only once something uses it twice; error handling only for cases that can happen, validated at system boundaries. Change code directly rather than adding compatibility shims, match the surrounding code, and remove what your own change made unused.",
	"- Editing files and running tests need no confirmation. Deleting files or branches, force-pushes and history rewrites, pushing, posting, and changes on a remote host need the user's word: when the request includes them, do the clear cases and ask about the doubtful ones; otherwise ask first. When an obstacle blocks you, say what blocks you rather than removing it with a destructive action.",
	"- Answer in the language the user writes in. When you finish, lead with the outcome, then the detail, then what you did not run or verify. Size documents you write to what the task needs, without filler sections or repeated summaries.",
].join("\n");

/** `PI_PRESET_WORKING_STYLE=off` (or 0 / false) disables the section. */
export function workingStyleEnabled(value: string | undefined): boolean {
	return !/^(off|0|false|no)$/i.test(value?.trim() ?? "");
}
