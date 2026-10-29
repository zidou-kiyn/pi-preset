/**
 * The menu every preset command uses (/termius, /pi-preset, /trellis-lite):
 * a bordered panel modeled on pi's own /mcp manager.
 *
 *   - status lines under the title, rebuilt whenever the caller signals (so a
 *     status fetched in the background appears without reopening the menu);
 *   - a notice line for the result of the last action;
 *   - items that wrap around with ↑↓, a number key picks an item directly
 *     (two digits for lists past 9: the first digit highlights, the second
 *     picks, and a digit that no later item could extend picks at once),
 *     and the highlighted item's description is shown below the list;
 *   - with `filterable`, typing narrows the list to items whose label, hint,
 *     or value contains the text (number keys then type too); Backspace
 *     edits it and Esc clears it before it closes the menu;
 *   - Esc leaves this level only: callers loop, so an action returns to the
 *     menu and Esc in a sub-menu returns to its parent;
 *   - a list taller than the screen scrolls with the highlight, with
 *     "↑ n more" / "↓ n more" rows marking what is cut off, so the
 *     description and key hints under it always stay visible.
 *
 * pi's ctx.ui.select clamps at both ends and has no status area, which is why
 * the commands do not use it in the TUI. RPC hosts have no custom components
 * and get a plain select instead.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { messages } from "./preset-messages.ts";
import type { PresetTheme } from "./preset-ui.ts";

export interface MenuItem {
	value: string;
	label: string;
	/** Shown below the list while the item is highlighted. */
	description?: string;
	/** Current value, right of the label (e.g. the active mode). */
	hint?: string;
	/** Theme color for the hint; dim by default. "success" marks something that is on. */
	hintTone?: HintTone;
	/** A group row: drawn as a heading over the items that follow it. Selectable like any item. */
	heading?: boolean;
}

export type NoticeType = "info" | "success" | "warning" | "error";

export type HintTone = "dim" | "muted" | "accent" | "success" | "warning" | "error";

export interface Notice {
	text: string;
	type: NoticeType;
}

/**
 * How a flow run from a menu ended, so the menu can tone its last notice
 * without reading the (translated) text: "nothing-written" for a cancel or
 * a no-op, "done" otherwise.
 */
export type FlowOutcome = "done" | "nothing-written";

export interface MenuSpec {
	title: string;
	/** Status lines under the title. */
	status?: readonly string[];
	/** Result of the last action. */
	notice?: Notice;
	items: readonly MenuItem[];
	/** Item to highlight when the menu opens. */
	selected?: string;
	/** What Esc does here, for the footer ("close" or "back", in the UI language). */
	cancelLabel?: string;
	/** Typing filters the items; for long lists. */
	filterable?: boolean;
}

/** Re-render when `notify` is called; returns an unsubscribe function. */
export type MenuSubscribe = (notify: () => void) => () => void;

const NOTICE_COLOR: Record<NoticeType, string> = {
	info: "muted",
	success: "success",
	warning: "warning",
	error: "error",
};

/** List rows a menu keeps however short the screen is. */
const MIN_LIST_ROWS = 5;

/**
 * Rows a menu may take. pi does not tell a component how much room is left
 * between the widgets above it (a todo list can take a dozen rows) and the
 * footer, and it cuts what does not fit off the bottom, key hints first; so
 * keep to half the screen, like pi's own selectors keep to a fixed count.
 */
export function menuHeight(rows: number): number {
	return Math.max(MIN_LIST_ROWS + 10, Math.floor(rows * 0.5));
}

function fit(text: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(text, width, "");
}

/** Typed text, as opposed to a key sequence: no control characters, no escape sequence. */
function isTypedText(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/u.test(data);
}

const BACKSPACE = /^[\x7f\x08]$/u;

/** The items whose label, hint, or value contains `query` (case-insensitive); all of them for an empty query. */
export function filterItems(items: readonly MenuItem[], query: string): MenuItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...items];
	return items.filter((item) => `${item.label} ${item.hint ?? ""} ${item.value}`.toLowerCase().includes(q));
}

/** The longest start of `text` that fits in `width` columns (CJK characters take two). */
function headToWidth(text: string, width: number): string {
	let head = "";
	let used = 0;
	for (const char of text) {
		const size = visibleWidth(char);
		if (used + size > width && head) break;
		head += char;
		used += size;
	}
	return head;
}

/** Wide (CJK) characters: text that may break between any two of them. */
const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

/** Punctuation that must not start a line (kinsoku): it stays with the character before it. */
const NO_LINE_START = /^[\u3001\u3002\uff0c\uff0e\uff1a\uff1b\uff01\uff1f\uff09\u300d\u300f\u300b\u3009\u3011\u201d\u2019,.;:!?)\]]/u;

/**
 * The longest start of `text` within `width` that ends where a line may
 * break: next to a wide character (never inside a Latin run such as
 * PI_PRESET_LANG) and not before closing punctuation. Empty when there is none.
 */
function cjkHead(text: string, width: number): string {
	const chars = [...text];
	let used = 0;
	let best = 0;
	let length = 0;
	for (let i = 0; i < chars.length; i++) {
		used += visibleWidth(chars[i]!);
		if (used > width) break;
		length += chars[i]!.length;
		const next = chars[i + 1];
		if (next === undefined) break;
		const breakable = WIDE.test(chars[i]!) || WIDE.test(next);
		if (breakable && !NO_LINE_START.test(next)) best = length;
	}
	return text.slice(0, best);
}

/** Where to hard-split a word wider than a line: at a CJK break if there is one, else by width. */
function breakHead(text: string, width: number): string {
	return cjkHead(text, width) || headToWidth(text, width);
}

/**
 * Word wrap that keeps long words (paths, URLs) by hard-splitting them.
 * Chinese text has no spaces, so a sentence is one long "word": it fills the
 * rest of the current line and breaks between characters, never before
 * closing punctuation.
 */
export function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			let rest = word;
			// CJK text continues on the current line instead of starting a new one.
			if (current && WIDE.test(rest) && visibleWidth(`${current} ${rest}`) > width) {
				const room = width - visibleWidth(current) - 1;
				const head = room >= 2 ? cjkHead(rest, room) : "";
				if (head) {
					lines.push(`${current} ${head}`);
					current = "";
					rest = rest.slice(head.length);
				}
			}
			while (visibleWidth(rest) > width) {
				if (current) {
					lines.push(current);
					current = "";
				}
				const head = breakHead(rest, width);
				lines.push(head);
				rest = rest.slice(head.length);
			}
			const candidate = current ? `${current} ${rest}` : rest;
			if (visibleWidth(candidate) <= width) current = candidate;
			else {
				lines.push(current);
				current = rest;
			}
		}
		lines.push(current);
	}
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export class MenuComponent implements Component {
	private readonly build: () => MenuSpec;
	private readonly theme: PresetTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (value: string | undefined) => void;
	private cursorValue: string | undefined;
	private settled = false;
	private query = "";
	/** Digits typed so far toward a number pick (lists past 9 items). */
	private digits = "";
	/** Screen rows the menu may use; the list scrolls inside what is left. */
	private readonly maxHeight: () => number;
	/** First list row shown while the list scrolls, and the highlighted item's index at the last render. */
	private scrollTop = 0;
	private lastIndex = 0;

	constructor(
		build: () => MenuSpec,
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (value: string | undefined) => void,
		maxHeight: () => number = () => Number.POSITIVE_INFINITY,
	) {
		this.build = build;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		this.maxHeight = maxHeight;
		this.cursorValue = build().selected;
	}

	/** Index of the highlighted item in `items`, keeping it on the same value across rebuilds. */
	private cursor(items: readonly MenuItem[]): number {
		const index = items.findIndex((item) => item.value === this.cursorValue);
		return index === -1 ? 0 : index;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		const spec = this.build();
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (spec.filterable && this.query) {
				this.query = "";
				this.requestRender();
				return;
			}
			this.finish(undefined);
			return;
		}
		if (spec.filterable && BACKSPACE.test(data)) {
			this.query = [...this.query].slice(0, -1).join("");
			this.requestRender();
			return;
		}
		const items = spec.filterable ? filterItems(spec.items, this.query) : spec.items;
		const index = this.cursor(items);
		if (!spec.filterable && /^[0-9]$/.test(data)) {
			const typed = this.digits + data;
			const n = Number(typed);
			if (n < 1 || n > items.length) {
				this.digits = "";
				return;
			}
			// Another digit could still name an item: highlight and wait for it (or Enter).
			if (n * 10 <= items.length) {
				this.digits = typed;
				this.cursorValue = items[n - 1]!.value;
				this.requestRender();
				return;
			}
			this.finish(items[n - 1]!.value);
			return;
		}
		this.digits = "";
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (items.length === 0) return;
			this.cursorValue = items[index === 0 ? items.length - 1 : index - 1]!.value;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (items.length === 0) return;
			this.cursorValue = items[index === items.length - 1 ? 0 : index + 1]!.value;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (items.length === 0) return;
			this.finish(items[index]!.value);
			return;
		} else if (spec.filterable && isTypedText(data)) {
			this.query += data;
			this.cursorValue = filterItems(spec.items, this.query)[0]?.value;
		} else {
			return;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const spec = this.build();
		const { theme } = this;
		const m = messages();
		const inner = Math.max(1, width - 2);
		const border = theme.fg("accent", "─".repeat(Math.max(0, width)));

		const head: string[] = [border, fit(` ${theme.fg("accent", theme.bold(spec.title))}`, width)];
		for (const line of spec.status ?? []) {
			for (const row of wrapPlain(line, inner)) head.push(fit(` ${theme.fg("muted", row)}`, width));
		}
		if (spec.notice) {
			for (const row of wrapPlain(spec.notice.text, inner)) {
				head.push(fit(` ${theme.fg(NOTICE_COLOR[spec.notice.type], row)}`, width));
			}
		}
		if (spec.filterable) {
			const query = this.query ? theme.fg("accent", this.query) : theme.fg("dim", m.filterHint);
			head.push(fit(` ${theme.fg("dim", "/")} ${query}`, width));
		}
		head.push("");

		const items = spec.filterable ? filterItems(spec.items, this.query) : spec.items;
		const index = this.cursor(items);

		const tail: string[] = [];
		const description = items[index]?.description;
		if (description) {
			tail.push("");
			for (const row of wrapPlain(description, Math.max(1, width - 3))) tail.push(fit(`   ${theme.fg("dim", row)}`, width));
		}
		tail.push("");
		const keys = spec.filterable ? m.menuKeysFilter(spec.cancelLabel ?? m.close) : m.menuKeys(spec.cancelLabel ?? m.close);
		tail.push(fit(` ${theme.fg("dim", keys)}`, width));
		tail.push(border);

		this.lastIndex = index;
		const body = this.renderItems(items, index, spec.filterable === true, width);
		const budget = Math.max(MIN_LIST_ROWS, this.maxHeight() - head.length - tail.length);
		return [...head, ...this.window(body, budget, width), ...tail];
	}

	/** One entry per item: its rows (a heading brings the blank line above it). */
	private renderItems(items: readonly MenuItem[], index: number, filterable: boolean, width: number): string[][] {
		const { theme } = this;
		if (items.length === 0) return [[fit(`  ${theme.fg("dim", messages().noMatches)}`, width)]];
		const labelWidth = Math.max(0, ...items.filter((item) => !item.heading).map((item) => visibleWidth(item.label)));
		// Numbers only where number keys work; otherwise no number column at all.
		const numbered = !filterable && items.length > 1;
		const numberWidth = `${items.length}.`.length;
		// Under headings, the other rows step in so the groups read as groups.
		const indent = items.some((item) => item.heading) ? "  " : "";
		return items.map((item, i) => {
			const active = i === index;
			const lead = `${active ? theme.fg("accent", "→") : " "} ${numbered ? `${theme.fg("dim", `${i + 1}.`.padStart(numberWidth))} ` : ""}`;
			const hint = item.hint ? `  ${theme.fg(item.hintTone ?? "dim", item.hint)}` : "";
			if (item.heading) {
				const title = active ? theme.fg("accent", theme.bold(item.label)) : theme.bold(item.label);
				const row = fit(`${lead}${title}${hint}`, width);
				return i > 0 ? ["", row] : [row];
			}
			const label = item.hint ? item.label + " ".repeat(labelWidth - visibleWidth(item.label)) : item.label;
			return [fit(`${lead}${indent}${active ? theme.fg("accent", label) : label}${hint}`, width)];
		});
	}

	/**
	 * The rows of `body` that fit in `budget`, scrolled so the highlighted item
	 * stays visible. Cut-off items are counted in a dim row at either end.
	 */
	private window(body: string[][], budget: number, width: number): string[] {
		const total = body.reduce((sum, rows) => sum + rows.length, 0);
		if (total <= budget) {
			this.scrollTop = 0;
			return body.flat();
		}
		const { theme } = this;
		const m = messages();
		const starts: number[] = [];
		let row = 0;
		for (const rows of body) {
			starts.push(row);
			row += rows.length;
		}
		const flat = body.flat();
		const itemAt = (r: number) => {
			let i = 0;
			while (i + 1 < starts.length && starts[i + 1]! <= r) i++;
			return i;
		};
		const cursorItem = Math.min(this.lastIndex, body.length - 1);
		// The highlighted item's own row (its heading's blank line may scroll away).
		const cursorRow = starts[cursorItem]! + body[cursorItem]!.length - 1;
		// Two rows are kept for the markers, so the window never jumps when one appears.
		const visible = Math.max(1, budget - 2);
		if (cursorRow < this.scrollTop) this.scrollTop = cursorRow;
		if (cursorRow >= this.scrollTop + visible) this.scrollTop = cursorRow - visible + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, total - visible));
		// At either end there is nothing to mark: that marker's row goes to the list.
		const atTop = this.scrollTop === 0;
		let start = this.scrollTop;
		const end = Math.min(total, start + visible + (atTop ? 1 : 0));
		const atBottom = end === total;
		if (atBottom && !atTop) start--;
		const firstShown = itemAt(start);
		const lastShown = itemAt(end - 1);
		// An item whose last row is cut (a heading under its blank line) counts as hidden.
		const lastCut = end - 1 < starts[lastShown]! + body[lastShown]!.length - 1;
		const hiddenAbove = firstShown;
		const hiddenBelow = body.length - 1 - lastShown + (lastCut ? 1 : 0);
		return [
			...(atTop ? [] : [fit(`  ${theme.fg("dim", m.moreAbove(hiddenAbove))}`, width)]),
			...flat.slice(start, end),
			...(atBottom ? [] : [fit(`  ${theme.fg("dim", m.moreBelow(hiddenBelow))}`, width)]),
		];
	}

	invalidate(): void {}

	private finish(value: string | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
	}
}

/**
 * Show one menu screen. Resolves with the chosen item's value, or undefined
 * for Esc. In RPC mode (no custom components) a plain select stands in.
 */
export async function showMenu(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	build: () => MenuSpec,
	subscribe?: MenuSubscribe,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const spec = build();
		const title = [spec.title, ...(spec.status ?? []), ...(spec.notice ? [spec.notice.text] : [])].join("\n");
		const labels = spec.items.map((item) => (item.hint ? `${item.label} (${item.hint})` : item.label));
		const picked = await ctx.ui.select(title, labels);
		return picked === undefined ? undefined : spec.items[labels.indexOf(picked)]?.value;
	}
	let unsubscribe: (() => void) | undefined;
	try {
		return await ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
			const menu = new MenuComponent(build, theme, keybindings, () => tui.requestRender(), done, () => {
				const rows = (tui as Partial<TUI>).terminal?.rows;
				return rows ? menuHeight(rows) : Number.POSITIVE_INFINITY;
			});
			unsubscribe = subscribe?.(() => tui.requestRender());
			return menu;
		});
	} finally {
		unsubscribe?.();
	}
}

/**
 * Show a choice between values, the current one ticked. For settings such
 * as an approval mode. Resolves with the value, or undefined for Esc.
 */
export function chooseValue(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	title: string,
	options: readonly { value: string; label: string; description?: string }[],
	current: string | undefined,
	status?: readonly string[],
): Promise<string | undefined> {
	return showMenu(ctx, () => ({
		title,
		status,
		items: options.map((option) => ({
			value: option.value,
			label: `${option.value === current ? "✓" : " "} ${option.label}`,
			description: option.description,
		})),
		selected: current,
		cancelLabel: messages().back,
	}));
}

/**
 * A view of `ctx` whose ui.notify() lands in `onNotice` instead of the chat,
 * so an existing flow that reports through notify can run from a menu and
 * have its result shown there. Everything else passes through to `ctx`.
 */
export function captureNotices<T extends { ui: object }>(ctx: T, onNotice: (notice: Notice) => void): T {
	const bind = (target: object, key: PropertyKey) => {
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	};
	const ui = new Proxy(ctx.ui, {
		get: (target, key) =>
			key === "notify"
				? (text: string, type: "info" | "warning" | "error" = "info") => onNotice({ text, type })
				: bind(target, key),
	});
	return new Proxy(ctx, { get: (target, key) => (key === "ui" ? ui : bind(target, key)) });
}

/** A tiny observable for status that arrives in the background. */
export class Signal {
	private listeners = new Set<() => void>();

	subscribe: MenuSubscribe = (notify) => {
		this.listeners.add(notify);
		return () => this.listeners.delete(notify);
	};

	emit(): void {
		for (const listener of this.listeners) listener();
	}
}
