import assert from "node:assert/strict";
import { test } from "node:test";
import { readThreshold, TodoNudge, tasksFromBranch, type NudgeTask } from "../src/todo-nudge.ts";

const task = (id: number, status: string, subject = `task ${id}`): NudgeTask => ({ id, subject, status });
const todo = (tasks: NudgeTask[], params: Record<string, unknown> = { action: "list" }, parentToolCallId?: string) => ({
	toolName: "todo",
	toolCallId: `todo-${Math.random()}`,
	parentToolCallId,
	details: { action: params.action, params, tasks, nextId: tasks.length + 1 },
});
let n = 0;
const other = (parentToolCallId?: string, toolCallId = `call-${++n}`) => ({ toolName: "bash", toolCallId, parentToolCallId });

test("reminds after the threshold, then backs off by doubling", () => {
	const nudge = new TodoNudge(3);
	nudge.onResult(todo([task(1, "in_progress", "write tests"), task(2, "pending")], { action: "update", id: 1, status: "in_progress" }));
	const lines = Array.from({ length: 20 }, () => nudge.onResult(other()));
	const fired = lines.flatMap((line, i) => (line ? [i + 1] : []));
	assert.deepEqual(fired, [3, 9, 21].filter((x) => x <= 20), "3, then 6 more, then 12 more");
	assert.equal(lines[2], "[todo] #1 write tests is still in_progress after 3 tool calls without a todo update: mark it completed now if it is done.");
});

test("any todo call resets the count; nothing in progress means no reminder", () => {
	const nudge = new TodoNudge(2);
	nudge.onResult(todo([task(1, "in_progress")]));
	assert.equal(nudge.onResult(other()), undefined);
	nudge.onResult(todo([task(1, "in_progress")]));
	assert.equal(nudge.onResult(other()), undefined, "count restarted");
	assert.match(nudge.onResult(other()) ?? "", /#1 task 1 is still in_progress after 2/);

	nudge.onResult(todo([task(1, "completed")], { action: "update", id: 1, status: "completed" }));
	for (let i = 0; i < 10; i++) assert.equal(nudge.onResult(other()), undefined);
});

test("a script's nested calls count once; a todo call inside a script counts as an update", () => {
	const nudge = new TodoNudge(2);
	nudge.onResult(todo([task(1, "in_progress")]));
	// codemode script "s1" runs five nested tools: one call, not five.
	for (let i = 0; i < 5; i++) assert.equal(nudge.onResult(other("s1")), undefined);
	assert.equal(nudge.onResult(other(undefined, "s1")), undefined);
	assert.equal(nudge.sinceTodo, 1);
	// script "s2" calls todo: its own result is a todo update.
	nudge.onResult(todo([task(1, "in_progress")], { action: "list" }, "s2"));
	assert.equal(nudge.onResult(other(undefined, "s2")), undefined);
	assert.equal(nudge.sinceTodo, 0);
});

test("starting a second task while one is open adds a note to that todo result", () => {
	const nudge = new TodoNudge();
	assert.equal(nudge.onResult(todo([task(1, "in_progress")], { action: "update", id: 1, status: "in_progress" })), undefined);
	assert.equal(
		nudge.onResult(todo([task(1, "in_progress", "parse"), task(2, "in_progress")], { action: "update", id: 2, status: "in_progress" })),
		"[todo] #1 parse is also in_progress. Keep one task in_progress: complete it if done, else set back to pending.",
	);
	assert.equal(
		nudge.onResult(todo([task(1, "completed"), task(2, "in_progress")], { action: "update", id: 1, status: "completed" })),
		undefined,
		"completing is never flagged",
	);
});

test("state comes back from the session branch, state entries first", () => {
	const branch = [
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [task(1, "pending")] } } },
		{ type: "custom", customType: "rpiv-todo-state", data: { tasks: [task(1, "in_progress")] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: { tasks: "not todo" } } },
	];
	assert.deepEqual(tasksFromBranch(branch), [task(1, "in_progress")]);
	assert.deepEqual(tasksFromBranch(branch.slice(0, 1)), [task(1, "pending")]);
	assert.equal(tasksFromBranch([]), undefined);

	const nudge = new TodoNudge(1);
	nudge.reset(tasksFromBranch(branch));
	assert.match(nudge.onResult(other()) ?? "", /#1 task 1 is still in_progress/);
});

test("PI_PRESET_TODO_NUDGE", () => {
	assert.equal(readThreshold(undefined), 8);
	assert.equal(readThreshold("off"), undefined);
	assert.equal(readThreshold("0"), undefined);
	assert.equal(readThreshold("12"), 12);
	assert.equal(readThreshold("junk"), 8);
});
