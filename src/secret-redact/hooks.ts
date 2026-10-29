/**
 * What secret-redact does at the two tool hooks, kept free of pi's runtime
 * so it can be tested.
 *
 * tool_result: every text block, structuredContent, and details of every
 * tool (nested codemode calls included) go through the redactor.
 *
 * tool_call:
 *   - write / edit / apply_patch: placeholders this process issued are put
 *     back into the file text. One it never issued (from an earlier session)
 *     cannot be, and would be written literally, so the call is refused once;
 *     the same call repeated goes through (the agent meant the text).
 *   - bash / powershell / MCP tools: a placeholder this process issued
 *     refuses the call. These never get values back: a command or a remote
 *     tool could send the value anywhere, and the literal placeholder would
 *     end up in a file or a request.
 */

import { PLACEHOLDER, type RedactOptions, type Redactor } from "./redactor.ts";

export interface ToolResultLike {
	toolName: string;
	content: { type: string; text?: string }[];
	structuredContent?: unknown;
	details?: unknown;
}

export interface ToolResultPatch {
	content: ToolResultLike["content"];
	structuredContent?: unknown;
	details?: unknown;
}

/** The redacted result, or undefined when nothing changed. */
export function redactToolResult(event: ToolResultLike, redactor: Redactor, options: RedactOptions): ToolResultPatch | undefined {
	let count = 0;
	const content = event.content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const result = redactor.redactText(block.text, options);
		count += result.count;
		return result.count > 0 ? { ...block, text: result.text } : block;
	});
	const structured = redactor.redactValue(event.structuredContent, options);
	count += structured.count;
	const details = redactor.redactValue(event.details, options);
	count += details.count;
	if (count === 0) return undefined;
	const patch: ToolResultPatch = { content };
	// pi drops structuredContent when a handler replaces content without it.
	if (event.structuredContent !== undefined) patch.structuredContent = structured.value;
	if (details.count > 0) patch.details = details.value;
	return patch;
}

export interface ToolCallLike {
	toolName: string;
	input: unknown;
}

export type ToolCallVerdict = { block: true; reason: string } | undefined;

const FILE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

function sendsOut(toolName: string): boolean {
	return COMMAND_TOOLS.has(toolName) || toolName.startsWith("mcp__");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The text fields of a file tool's input, as [object, key] pairs. */
function fileFields(toolName: string, input: Record<string, unknown>): [Record<string, unknown>, string][] {
	const fields: [Record<string, unknown>, string][] = [];
	const add = (holder: Record<string, unknown>, key: string) => {
		if (typeof holder[key] === "string") fields.push([holder, key]);
	};
	if (toolName === "write") add(input, "content");
	if (toolName === "apply_patch") add(input, "input");
	if (toolName === "edit") {
		add(input, "oldText");
		add(input, "newText");
		if (Array.isArray(input.edits)) {
			for (const edit of input.edits) {
				if (isObject(edit)) {
					add(edit, "oldText");
					add(edit, "newText");
				}
			}
		}
	}
	return fields;
}

function list(placeholders: string[]): string {
	const unique = [...new Set(placeholders)];
	const shown = unique.slice(0, 5).join(", ");
	return unique.length > 5 ? `${shown} and ${unique.length - 5} more` : shown;
}

/** Remembers file-tool calls refused for unknown placeholders, so a repeat goes through. */
export class RepeatMemory {
	private readonly seen: string[] = [];

	/** True when this exact call was refused before (and forgets it). */
	take(signature: string): boolean {
		const at = this.seen.indexOf(signature);
		if (at < 0) return false;
		this.seen.splice(at, 1);
		return true;
	}

	add(signature: string): void {
		this.seen.push(signature);
		if (this.seen.length > 20) this.seen.shift();
	}
}

/** Restore or refuse; mutates `event.input` when it restores. */
export function handleToolCall(event: ToolCallLike, redactor: Redactor, repeats: RepeatMemory): ToolCallVerdict {
	if (!isObject(event.input)) return undefined;
	if (FILE_TOOLS.has(event.toolName)) {
		const fields = fileFields(event.toolName, event.input);
		if (!fields.some(([holder, key]) => (holder[key] as string).includes("[REDACTED:"))) return undefined;
		const unknown = fields.flatMap(([holder, key]) => redactor.restore(holder[key] as string).unknown);
		if (unknown.length > 0) {
			const signature = `${event.toolName}\n${JSON.stringify(event.input)}`;
			if (!repeats.take(signature)) {
				repeats.add(signature);
				return {
					block: true,
					reason:
						`${list(unknown)} ${unknown.length === 1 ? "is not a placeholder" : "are not placeholders"} this pi process issued (it may come from an earlier session), so ` +
						"it cannot be turned back into the secret and would be written literally. Read the file again to get current placeholders, or ask the user for the value. " +
						"If you mean the literal text, repeat the same call unchanged.",
				};
			}
		}
		for (const [holder, key] of fields) holder[key] = redactor.restore(holder[key] as string).text;
		return undefined;
	}
	if (sendsOut(event.toolName)) {
		const text = JSON.stringify(event.input);
		if (!text.includes("[REDACTED:")) return undefined;
		const issued = redactor.issuedIn(text);
		if (issued.length === 0) return undefined;
		return {
			block: true,
			reason:
				`This call contains ${list(issued)}: placeholders for secrets you were not shown. Commands and remote tools never get the real value back, ` +
				"since they could send it anywhere, and the placeholder text itself would end up in a file or a request. Refer to the secret where it lives " +
				"instead (an environment variable, or read it from its file inside the command), or ask the user. write, edit, and apply_patch do put the real value back.",
		};
	}
	return undefined;
}

/** For tests and the status line: does `text` hold any placeholder? */
export function hasPlaceholder(text: string): boolean {
	PLACEHOLDER.lastIndex = 0;
	return PLACEHOLDER.test(text);
}
