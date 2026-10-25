/**
 * Todo nudges: models start a task (in_progress) and forget to close it, or
 * start a second one on top. The todo guideline already says "one at a time,
 * complete it as soon as it is done"; this notices when that slipped and says
 * so in a tool result the model is reading anyway. Nothing is added to the
 * system prompt, so a session that keeps its list tidy pays nothing.
 *
 *   - stale: a task stays in_progress while `threshold` top-level tool calls
 *     pass without any todo call; the result of the last one gets a one-line
 *     reminder. Then the gap doubles (8, 16, 32 …) so a genuinely long task
 *     is not nagged every few calls.
 *   - double start: an update that sets a task in_progress while another is
 *     still in_progress gets a note on its own result.
 *
 * Calls a codemode script makes (parentToolCallId) count once, through the
 * script's own result; a todo call inside a script counts as a todo update.
 */

export interface NudgeTask {
	id: number;
	subject: string;
	status: string;
}

export const DEFAULT_THRESHOLD = 8;
const TODO_TOOL = "todo";
const STATE_ENTRY = "rpiv-todo-state";

/** The `tasks` of an rpiv-todo details snapshot, or undefined for anything else. */
export function tasksOf(details: unknown): NudgeTask[] | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const tasks = (details as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return undefined;
	return tasks.filter(
		(task): task is NudgeTask =>
			typeof task === "object" && task !== null && typeof task.id === "number" && typeof task.subject === "string" && typeof task.status === "string",
	);
}

/** The latest todo snapshot on a session branch (state entries win over tool results, as in rpiv-todo's replay). */
export function tasksFromBranch(entries: Iterable<unknown>): NudgeTask[] | undefined {
	let fromEntries: NudgeTask[] | undefined;
	let fromResults: NudgeTask[] | undefined;
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type === "custom" && e.customType === STATE_ENTRY) fromEntries = tasksOf(e.data) ?? fromEntries;
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === TODO_TOOL) {
			fromResults = tasksOf(e.message.details) ?? fromResults;
		}
	}
	return fromEntries ?? fromResults;
}

/** "PI_PRESET_TODO_NUDGE": unset = 8 calls, "off"/"0" = disabled, a number = that many calls. */
export function readThreshold(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return DEFAULT_THRESHOLD;
	if (/^(off|false|no)$/i.test(value.trim())) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) return DEFAULT_THRESHOLD;
	return n === 0 ? undefined : n;
}

const label = (task: NudgeTask) => `#${task.id} ${task.subject}`;

export interface ToolResultInfo {
	toolName: string;
	toolCallId: string;
	parentToolCallId?: string;
	details?: unknown;
	input?: Record<string, unknown>;
}

export class TodoNudge {
	readonly threshold: number;
	tasks: NudgeTask[] = [];
	/** Top-level non-todo results since the last todo call. */
	sinceTodo = 0;
	#gap: number;
	#nextAt: number;
	/** Scripts that made a todo call; their own result counts as a todo update. */
	#todoParents = new Set<string>();

	constructor(threshold = DEFAULT_THRESHOLD) {
		this.threshold = threshold;
		this.#gap = threshold;
		this.#nextAt = threshold;
	}

	/** New session or branch: take its todo state, start counting afresh. */
	reset(tasks: NudgeTask[] | undefined): void {
		this.tasks = tasks ?? [];
		this.#todoUpdate();
		this.#todoParents.clear();
	}

	#todoUpdate(): void {
		this.sinceTodo = 0;
		this.#gap = this.threshold;
		this.#nextAt = this.threshold;
	}

	inProgress(): NudgeTask[] {
		return this.tasks.filter((task) => task.status === "in_progress");
	}

	/** Feed one tool result; returns a line to append to it, if any. */
	onResult(result: ToolResultInfo): string | undefined {
		if (result.toolName === TODO_TOOL) return this.#onTodo(result);
		if (result.parentToolCallId !== undefined) return undefined;
		if (this.#todoParents.delete(result.toolCallId)) {
			this.#todoUpdate();
			return undefined;
		}
		const open = this.inProgress();
		if (open.length === 0) {
			this.sinceTodo = 0;
			return undefined;
		}
		this.sinceTodo++;
		if (this.sinceTodo < this.#nextAt) return undefined;
		this.#gap *= 2;
		this.#nextAt = this.sinceTodo + this.#gap;
		const which = open.length === 1 ? `${label(open[0]!)} is` : `${open.map(label).join(", ")} are`;
		return `[todo] ${which} still in_progress after ${this.sinceTodo} tool calls without a todo update: mark it completed now if it is done.`;
	}

	#onTodo(result: ToolResultInfo): string | undefined {
		if (result.parentToolCallId !== undefined) this.#todoParents.add(result.parentToolCallId);
		this.#todoUpdate();
		const tasks = tasksOf(result.details);
		if (!tasks) return undefined;
		this.tasks = tasks;
		const params = (result.details as { params?: Record<string, unknown> }).params ?? result.input ?? {};
		if (params.status !== "in_progress") return undefined;
		const others = this.inProgress().filter((task) => task.id !== params.id);
		if (others.length === 0) return undefined;
		return `[todo] ${others.map(label).join(", ")} ${others.length === 1 ? "is" : "are"} also in_progress. Keep one task in_progress: complete ${others.length === 1 ? "it" : "them"} if done, else set back to pending.`;
	}
}
