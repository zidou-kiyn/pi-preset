/**
 * The working-style section: a few lines on scope and minimal code that pi's
 * own system prompt leaves out (it says only "Be concise").
 *
 * Wording comes from Anthropic's prompting guides: the scope paragraph from
 * "Prompting Claude Opus 5" (Task scope), the minimal-code line condensed from
 * the "Avoid over-engineering" sample prompt. Kept model-neutral so it reads
 * the same to GPT and DeepSeek models. It deliberately says nothing about
 * re-checking work: current models verify on their own, and an explicit
 * instruction makes them over-verify (same guide).
 */

export const SECTION_NAME = "working-style";

export const WORKING_STYLE = [
	"- Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it. Finish the whole task, and stop short of actions that are clearly beyond what was asked.",
	"- Keep solutions minimal: a helper or abstraction only once something uses it twice, configurability only when asked for, error handling only for cases that can happen (validate at system boundaries), and change code directly instead of adding compatibility shims.",
	"- Follow the style and structure of the code around you. Leave code the task does not touch as it is, and remove what your own change made unused.",
].join("\n");

/** `PI_PRESET_WORKING_STYLE=off` (or 0 / false) disables the section. */
export function workingStyleEnabled(value: string | undefined): boolean {
	return !/^(off|0|false|no)$/i.test(value?.trim() ?? "");
}
