import assert from "node:assert/strict";
import { test } from "node:test";
import doubleEscape from "../extensions/double-escape.ts";

type Listener = (data: string) => { consume?: boolean; data?: string } | undefined;
type Handler = (event: unknown, ctx: unknown) => void;

function setup(mode = "tui") {
	const handlers = new Map<string, Handler>();
	const listeners = new Set<Listener>();
	const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
	const ctx = {
		mode,
		ui: {
			onTerminalInput: (listener: Listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
	doubleEscape(pi as never);
	return { start: () => handlers.get("session_start")!({}, ctx), shutdown: () => handlers.get("session_shutdown")!({}, ctx), listeners };
}

/** Run `fn` while capturing what is fed back through stdin. */
async function fed(fn: () => void): Promise<string[]> {
	const seen: string[] = [];
	const onData = (data: unknown) => seen.push(String(data));
	process.stdin.on("data", onData);
	try {
		fn();
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.stdin.off("data", onData);
	}
	return seen;
}

test("Alt+Esc in every encoding becomes Esc plus a second Esc through stdin", async () => {
	const { start, listeners } = setup();
	start();
	const [listener] = [...listeners];
	for (const sequence of ["\x1b[27;3u", "\x1b[27;3;27~", "\x1b\x1b"]) {
		let result: ReturnType<Listener>;
		const extra = await fed(() => {
			result = listener!(sequence);
		});
		assert.deepEqual(result!, { data: "\x1b" }, JSON.stringify(sequence));
		assert.deepEqual(extra, ["\x1b"], JSON.stringify(sequence));
	}
});

test("other keys, a plain Esc included, pass through untouched", async () => {
	const { start, listeners } = setup();
	start();
	const [listener] = [...listeners];
	for (const sequence of ["\x1b", "\x1b[A", "a", "\x1b[27u", "\x1b[27;5u"]) {
		let result: ReturnType<Listener>;
		const extra = await fed(() => {
			result = listener!(sequence);
		});
		assert.equal(result!, undefined, JSON.stringify(sequence));
		assert.deepEqual(extra, [], JSON.stringify(sequence));
	}
});

test("one listener across session switches, none outside the TUI", () => {
	const tui = setup();
	tui.start();
	tui.start();
	assert.equal(tui.listeners.size, 1);
	tui.shutdown();
	assert.equal(tui.listeners.size, 0);

	const rpc = setup("rpc");
	rpc.start();
	assert.equal(rpc.listeners.size, 0);
});
