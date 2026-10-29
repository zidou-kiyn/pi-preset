// The shared preset menu: wrap-around, number keys, Esc, live rebuilds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MenuSpec, MenuComponent, Signal, wrapPlain } from "../src/preset-menu.ts";

// UI text is asserted in English whatever the system locale.
process.env.PI_PRESET_LANG = "en";

const KEYS: Record<string, string> = { "tui.select.up": "UP", "tui.select.down": "DOWN", "tui.select.confirm": "ENTER", "tui.select.cancel": "ESC" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data } as never;
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function menu(build: () => MenuSpec) {
	const results: (string | undefined)[] = [];
	let renders = 0;
	const component = new MenuComponent(build, theme, keybindings, () => renders++, (value) => results.push(value));
	return { component, results, renders: () => renders };
}

const items = [
	{ value: "a", label: "Alpha", description: "first item" },
	{ value: "b", label: "Beta", hint: "on" },
	{ value: "c", label: "Gamma" },
];

test("↑ on the first item wraps to the last, ↓ on the last wraps to the first", () => {
	const { component, results } = menu(() => ({ title: "T", items }));
	component.handleInput("UP");
	component.handleInput("ENTER");
	assert.deepEqual(results, ["c"]);

	const second = menu(() => ({ title: "T", items, selected: "c" }));
	second.component.handleInput("DOWN");
	second.component.handleInput("ENTER");
	assert.deepEqual(second.results, ["a"]);
});

test("a number key picks that item; Esc resolves undefined once", () => {
	const { component, results } = menu(() => ({ title: "T", items }));
	component.handleInput("2");
	component.handleInput("ESC");
	assert.deepEqual(results, ["b"], "settles once");

	const other = menu(() => ({ title: "T", items }));
	other.component.handleInput("9");
	other.component.handleInput("ESC");
	assert.deepEqual(other.results, [undefined], "out-of-range digits are ignored");
});

test("the highlight follows its value when the items change", () => {
	let list = items;
	const { component, results } = menu(() => ({ title: "T", items: list }));
	component.handleInput("DOWN"); // on "b"
	list = [{ value: "z", label: "New" }, ...items];
	component.handleInput("ENTER");
	assert.deepEqual(results, ["b"]);
});

test("render shows status, notice, hints, and the highlighted description", () => {
	let status = ["loading…"];
	const { component } = menu(() => ({ title: "Title", status, notice: { text: "Saved.", type: "success" }, items }));
	let out = component.render(60).join("\n");
	assert.match(out, /Title/);
	assert.match(out, /loading…/);
	assert.match(out, /Saved\./);
	assert.match(out, /→ 1\. Alpha/);
	assert.match(out, /Beta {2,}on/);
	assert.match(out, /first item/);
	assert.match(out, /Esc close/);
	status = ["signed in as me"];
	out = component.render(60).join("\n");
	assert.match(out, /signed in as me/, "status is rebuilt on every render");
});

test("no number column where number keys do not work", () => {
	const single = menu(() => ({ title: "T", items: [{ value: "a", label: "Only" }] }));
	assert.match(single.component.render(40).join("\n"), /^→ Only$/m);
	const filtered = menu(() => ({ title: "T", items, filterable: true }));
	assert.match(filtered.component.render(40).join("\n"), /^→ Alpha$/m);
});

test("a list taller than the menu scrolls with the highlight and counts what is cut off", () => {
	const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Item ${i + 1}` }));
	const component = new MenuComponent(() => ({ title: "T", items: many }), theme, keybindings, () => {}, () => {}, () => 20);
	let out = component.render(80);
	assert.ok(out.length <= 20, `fits in 20 rows, got ${out.length}`);
	assert.match(out.join("\n"), /→ +1\. Item 1\b/);
	assert.match(out.join("\n"), /↓ \d+ more/);
	assert.doesNotMatch(out.join("\n"), /↑ \d+ more/);
	assert.match(out.at(-2)!, /Esc close/, "the key hints stay visible");

	component.handleInput("UP"); // wraps to the last item
	out = component.render(80);
	assert.ok(out.length <= 20);
	assert.match(out.join("\n"), /→ 30\. Item 30/);
	assert.match(out.join("\n"), /↑ \d+ more/);
	assert.doesNotMatch(out.join("\n"), /↓ \d+ more/);
	const shown = out.filter((line) => /\d+\. Item/.test(line)).length;
	const above = Number(out.join("\n").match(/↑ (\d+) more/)![1]);
	assert.equal(above + shown, 30, "the count covers exactly the items not shown");
});

test("Signal notifies subscribers until they unsubscribe", () => {
	const signal = new Signal();
	let calls = 0;
	const off = signal.subscribe(() => calls++);
	signal.emit();
	off();
	signal.emit();
	assert.equal(calls, 1);
});

test("wrapPlain hard-splits words longer than the width", () => {
	assert.deepEqual(wrapPlain("abcdefgh ij", 4), ["abcd", "efgh", "ij"]);
	assert.deepEqual(wrapPlain("one two three", 7), ["one two", "three"]);
	assert.deepEqual(wrapPlain("同步预设的包和配置", 8), ["同步预设", "的包和配", "置"], "Chinese splits by display width");
	assert.deepEqual(
		wrapPlain("含 chrome MCP 服务器和状态栏", 20),
		["含 chrome MCP 服务器", "和状态栏"],
		"Chinese after a word fills the rest of the line",
	);
	assert.ok(
		wrapPlain("\u8bbe\u7f6e\u4e86\u73af\u5883\u53d8\u91cf PI_PRESET_LANG\uff08en \u6216 zh\uff09\u65f6", 24).some((line) => line.includes("PI_PRESET_LANG")),
		"a Latin run next to Chinese is not split",
	);
	assert.deepEqual(wrapPlain("同步预设，再写入", 8), ["同步预", "设，再写", "入"], "a line never opens with closing punctuation");
});

test("captureNotices routes notify to the menu and passes everything else through", async () => {
	const { captureNotices } = await import("../src/preset-menu.ts");
	class Ui {
		#calls: string[] = [];
		notify(text: string, _type?: string) {
			this.#calls.push(text);
		}
		input(title: string) {
			this.#calls.push(`input ${title}`);
			return this.#calls;
		}
	}
	class Ctx {
		#secret = "cwd";
		ui = new Ui();
		get cwd() {
			return this.#secret;
		}
	}
	const ctx = new Ctx();
	const notices: { text: string; type: string }[] = [];
	const wrapped = captureNotices(ctx, (notice) => notices.push(notice));
	wrapped.ui.notify("done", "warning");
	assert.deepEqual(notices, [{ text: "done", type: "warning" }]);
	assert.equal(wrapped.cwd, "cwd", "getters with private fields still work");
	assert.deepEqual(wrapped.ui.input("T"), ["input T"], "other ui methods reach the real ui; notify did not");
});

test("summarizePlan: in sync, pending changes, or blocked", async () => {
	const { summarizePlan } = await import("../extensions/pi-preset.ts");
	assert.equal(summarizePlan({ steps: [], notes: [], blockers: [] }), "Config: in sync with the preset");
	assert.equal(
		summarizePlan({
			steps: [
				{ kind: "json.patch", targetId: "mcp.json", configPath: "x", patch: {}, changes: [{ key: "a", path: [], from: 1, to: 2 }] },
				{ kind: "settings.packages.add", missing: ["npm:a", "npm:b"] } as never,
			],
			notes: [],
			blockers: [],
		}),
		"Config: mcp.json (1 key), 2 package(s) to add to sync",
	);
	assert.match(summarizePlan({ steps: [], notes: [], blockers: ["settings.json: bad"] }), /cannot plan a sync \(settings.json: bad\)/);
});
