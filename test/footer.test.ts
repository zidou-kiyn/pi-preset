import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionKey, formatCost, historySegment, todoSummary } from "../extensions/vibrant-footer.ts";

process.env.PI_PRESET_LANG = "en";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("cost: cents from a dollar up, a tenth of a cent below", () => {
	assert.equal(formatCost(18.0333), "$18.03");
	assert.equal(formatCost(0.4104), "$0.410");
});

test("todos: shown while a task is open, gone once the list is finished", () => {
	assert.equal(todoSummary([]), null);
	assert.equal(todoSummary([{ status: "completed" }, { status: "completed" }]), null);
	assert.deepEqual(todoSummary([{ status: "completed" }, { status: "in_progress", subject: "Write", activeForm: "writing" }, { status: "pending" }]), {
		done: 1,
		total: 3,
		current: "writing",
	});
});

test("history: nothing while snapshots are healthy, a warning when they fail", () => {
	const icons = { history: "H" } as never;
	assert.equal(historySegment(plain, "\u27f2 history", icons), null);
	assert.equal(historySegment(plain, undefined, icons), null);
	assert.equal(historySegment(plain, "\u27f2 snapshot failed", icons), "H snapshot failed");
});

test("vendored packages count once, other package extensions per file, non-package sources not at all", () => {
	const root = "/home/u/.pi/agent/git/github.com/zidou-kiyn/pi-preset";
	const source = "git:github.com/zidou-kiyn/pi-preset";
	const pkg = (path: string) => ({ origin: "package", source, path });

	assert.equal(extensionKey(pkg(`${root}/vendor/pi-fff/src/index.ts`)), `${root}/vendor/pi-fff`);
	assert.equal(
		extensionKey(pkg(`${root}/vendor/pi-workspace-history/wtf/index.ts`)),
		extensionKey(pkg(`${root}/vendor/pi-workspace-history/.pi/extensions/workspace-history.ts`)),
		"wtf lives inside workspace-history and counts with it",
	);
	assert.equal(extensionKey(pkg(`${root}/extensions/compact-tools.ts`)), `${root}/extensions/compact-tools.ts`);
	assert.equal(extensionKey({ origin: "package", source: "npm:pi-statusline" }), "npm:pi-statusline");
	assert.equal(extensionKey({ origin: "builtin", path: "/x/vendor/y/z.ts" }), undefined);
	assert.equal(extensionKey(undefined), undefined);
});
