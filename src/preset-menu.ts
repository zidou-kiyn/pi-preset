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
 *     menu and Esc in a sub-menu returns to its parent.
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
}

export type NoticeType = "info" | "success" | "warning" | "error";

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

/**
 * Word wrap that keeps long words (paths, URLs) by hard-splitting them.
 * Chinese text has no spaces, so a sentence is one long "word" and is split
 * the same way, by display width.
 */
export function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			let rest = word;
			while (visibleWidth(rest) > width) {
				if (current) {
					lines.push(current);
					current = "";
				}
				const head = headToWidth(rest, width);
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

	constructor(
		build: () => MenuSpec,
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (value: string | undefined) => void,
	) {
		this.build = build;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
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
		const inner = Math.max(1, width - 2);
		const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
		const lines: string[] = [border, fit(` ${theme.fg("accent", theme.bold(spec.title))}`, width)];
		for (const line of spec.status ?? []) {
			for (const row of wrapPlain(line, inner)) lines.push(fit(` ${theme.fg("muted", row)}`, width));
		}
		if (spec.notice) {
			for (const row of wrapPlain(spec.notice.text, inner)) {
				lines.push(fit(` ${theme.fg(NOTICE_COLOR[spec.notice.type], row)}`, width));
			}
		}
		const m = messages();
		if (spec.filterable) {
			const query = this.query ? theme.fg("accent", this.query) : theme.fg("dim", m.filterHint);
			lines.push(fit(` ${theme.fg("dim", "/")} ${query}`, width));
		}
		lines.push("");
		const items = spec.filterable ? filterItems(spec.items, this.query) : spec.items;
		const index = this.cursor(items);
		const labelWidth = Math.max(0, ...items.map((item) => visibleWidth(item.label)));
		if (items.length === 0) lines.push(fit(`   ${theme.fg("dim", m.noMatches)}`, width));
		const numberWidth = `${items.length}.`.length;
		items.forEach((item, i) => {
			const active = i === index;
			const number = !spec.filterable && items.length > 1 ? `${i + 1}.`.padStart(numberWidth) : " ".repeat(numberWidth);
			const label = item.hint ? item.label + " ".repeat(labelWidth - visibleWidth(item.label)) : item.label;
			const row = `${active ? "→" : " "} ${theme.fg("dim", number)} ${active ? theme.fg("accent", label) : label}`;
			lines.push(fit(item.hint ? `${row}  ${theme.fg("dim", item.hint)}` : row, width));
		});
		const description = items[index]?.description;
		if (description) {
			lines.push("");
			for (const row of wrapPlain(description, Math.max(1, width - 3))) lines.push(fit(`   ${theme.fg("dim", row)}`, width));
		}
		lines.push("");
		const keys = spec.filterable ? m.menuKeysFilter(spec.cancelLabel ?? m.close) : m.menuKeys(spec.cancelLabel ?? m.close);
		lines.push(fit(` ${theme.fg("dim", keys)}`, width));
		lines.push(border);
		return lines;
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
			const menu = new MenuComponent(build, theme, keybindings, () => tui.requestRender(), done);
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
