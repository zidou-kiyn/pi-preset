import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

/**
 * Custom session-entry type carrying the `details` snapshot of every
 * state-changing `todo` call — the replay source that survives calls made
 * through another tool (`ctx.executeTool`, e.g. Pi's codemode), whose results
 * never land on the branch as standalone `toolResult` messages. Persistence key
 * for branch replay, like `TOOL_NAME`. DO NOT rename.
 */
export const STATE_ENTRY_TYPE = "rpiv-todo-state";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
/** One item in a batch `create` `tasks[]` payload. Same create-shaped fields as a single create, minus nested `tasks`. */
export interface CreateTaskInput {
	subject: string;
	description?: string;
	activeForm?: string;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	/** Batch create items. One-of with `subject` on `create`. */
	tasks?: CreateTaskInput[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests.
// ---------------------------------------------------------------------------

// pi-preset: item fields mean what the top-level create fields mean, so only
// the one batch-specific limit is described. owner and metadata are not in
// the schema (top level or items): a single agent never sets them. Tasks that
// already carry them still replay and render (Task keeps both fields).
const CreateTaskInputSchema = Type.Object({
	subject: Type.String(),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Existing task ids only, not items of this batch",
		}),
	),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(
		Type.String({
			description: "Task subject line (create, unless tasks[] is given)",
		}),
	),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Spinner label while in_progress, e.g. 'writing tests'",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "New status (update) or filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "update only; merged into blockedBy",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "update only",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "list: include deleted tasks",
		}),
	),
	tasks: Type.Optional(
		Type.Array(CreateTaskInputSchema, {
			description: "create only: several independent tasks at once, all or none",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
