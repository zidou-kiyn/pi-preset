/**
 * The /termius host list: one row per host with its address, route, and
 * level, marks for what is special about it, typing to filter, Space to
 * select several, Enter for the detail page (or the batch editor when hosts
 * are selected). Esc clears the filter, then the selection, then leaves.
 *
 * It scrolls: at most VISIBLE_ROWS rows are drawn, with "↑ n more" /
 * "↓ n more" lines. The same bordered look as src/preset-menu.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type MenuSubscribe, wrapPlain } from "../preset-menu.ts";
import type { PresetTheme } from "../preset-ui.ts";

export const VISIBLE_ROWS = 15;

export type Tone = "error" | "warning" | "success" | "accent" | "muted" | "dim" | undefined;

export interface HostListRow {
	key: string;
	label: string;
	address: string;
	route: string;
	routeTone?: Tone;
	/** The host's own level; undefined = follows global (drawn as "·"). */
	level?: string;
	levelTone?: Tone;
	marks: { text: string; tone?: Tone }[];
	/** Lowercase text the filter matches against (label, address, tags, ...). */
	search: string;
}

export interface HostListSpec {
	title: string;
	status?: readonly string[];
	notice?: { text: string; tone: Tone };
	rows: readonly HostListRow[];
	/** Shown instead of rows (loading, empty, error). */
	placeholder?: string;
	labels: {
		filter: string;
		filterHint: string;
		noMatch: string;
		legend: string;
		keys: string;
		keysSelected: (count: number) => string;
		more: (count: number, up: boolean) => string;
	};
	selectedKey?: string;
}

export type HostListResult = { action: "open"; key: string } | { action: "batch"; keys: string[] } | undefined;

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/u;

function pad(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

export class HostListComponent implements Component {
	private readonly build: () => HostListSpec;
	private readonly theme: PresetTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: HostListResult) => void;
	private filter = "";
	private cursorKey: string | undefined;
	private readonly selected = new Set<string>();
	private scroll = 0;
	private settled = false;

	constructor(
		build: () => HostListSpec,
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: HostListResult) => void,
	) {
		this.build = build;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		this.cursorKey = build().selectedKey;
	}

	/** Rows that pass the filter (every word must appear). */
	private visible(rows: readonly HostListRow[]): HostListRow[] {
		const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
		return words.length === 0 ? [...rows] : rows.filter((row) => words.every((word) => row.search.includes(word)));
	}

	private cursorIndex(rows: readonly HostListRow[]): number {
		const index = rows.findIndex((row) => row.key === this.cursorKey);
		return index === -1 ? 0 : index;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		const kb = this.keybindings;
		const rows = this.visible(this.build().rows);
		const index = this.cursorIndex(rows);
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.filter) this.filter = "";
			else if (this.selected.size > 0) this.selected.clear();
			else return this.finish(undefined);
		} else if (kb.matches(data, "tui.select.up")) {
			if (rows.length > 0) this.cursorKey = rows[index === 0 ? rows.length - 1 : index - 1]!.key;
		} else if (kb.matches(data, "tui.select.down")) {
			if (rows.length > 0) this.cursorKey = rows[index === rows.length - 1 ? 0 : index + 1]!.key;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			if (rows.length > 0) this.cursorKey = rows[Math.max(0, index - VISIBLE_ROWS)]!.key;
		} else if (kb.matches(data, "tui.select.pageDown")) {
			if (rows.length > 0) this.cursorKey = rows[Math.min(rows.length - 1, index + VISIBLE_ROWS)]!.key;
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.selected.size > 0) return this.finish({ action: "batch", keys: [...this.selected] });
			if (rows.length > 0) return this.finish({ action: "open", key: rows[index]!.key });
			return;
		} else if (data === " ") {
			const key = rows[index]?.key;
			if (key === undefined) return;
			if (this.selected.has(key)) this.selected.delete(key);
			else this.selected.add(key);
		} else if (kb.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f" || data === "\b") {
			this.filter = [...this.filter].slice(0, -1).join("");
		} else if (PRINTABLE.test(data)) {
			this.filter += data;
		} else {
			return;
		}
		this.requestRender();
	}

	private columnWidths(rows: readonly HostListRow[], width: number): [number, number, number, number] {
		const max = (pick: (row: HostListRow) => string, cap: number) => Math.min(cap, Math.max(0, ...rows.map((row) => visibleWidth(pick(row)))));
		const label = max((row) => row.label, 24);
		const address = max((row) => row.address, 22);
		const route = max((row) => row.route, 24);
		const level = max((row) => row.level ?? "·", 10);
		// Narrow terminals give up the address column first, then shrink the route.
		const fixed = 6 + label + level + 6;
		if (fixed + address + route <= width) return [label, address, route, level];
		if (fixed + route <= width) return [label, 0, route, level];
		return [label, 0, Math.max(6, width - fixed), level];
	}

	render(width: number): string[] {
		const spec = this.build();
		const { theme } = this;
		const tone = (text: string, t: Tone) => (t ? theme.fg(t, text) : text);
		const inner = Math.max(1, width - 2);
		const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
		const lines: string[] = [border, truncateToWidth(` ${theme.fg("accent", theme.bold(spec.title))}`, width, "")];
		for (const line of spec.status ?? []) {
			for (const row of wrapPlain(line, inner)) lines.push(truncateToWidth(` ${theme.fg("muted", row)}`, width, ""));
		}
		if (spec.notice) {
			for (const row of wrapPlain(spec.notice.text, inner)) lines.push(truncateToWidth(` ${tone(row, spec.notice.tone)}`, width, ""));
		}
		const filterText = this.filter ? `${this.filter}_` : theme.fg("dim", spec.labels.filterHint);
		lines.push(truncateToWidth(` ${theme.fg("dim", `${spec.labels.filter}:`)} ${filterText}`, width, ""));
		lines.push("");

		const rows = this.visible(spec.rows);
		if (spec.placeholder) lines.push(truncateToWidth(` ${theme.fg("muted", spec.placeholder)}`, width, ""));
		else if (rows.length === 0) lines.push(truncateToWidth(` ${theme.fg("muted", spec.labels.noMatch)}`, width, ""));
		else {
			const index = this.cursorIndex(rows);
			if (index < this.scroll) this.scroll = index;
			if (index >= this.scroll + VISIBLE_ROWS) this.scroll = index - VISIBLE_ROWS + 1;
			this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - VISIBLE_ROWS)));
			const [labelW, addressW, routeW, levelW] = this.columnWidths(rows, width);
			if (this.scroll > 0) lines.push(truncateToWidth(`   ${theme.fg("dim", spec.labels.more(this.scroll, true))}`, width, ""));
			for (const [offset, row] of rows.slice(this.scroll, this.scroll + VISIBLE_ROWS).entries()) {
				const active = this.scroll + offset === index;
				const box = this.selected.has(row.key) ? theme.fg("accent", "[x]") : theme.fg("dim", "[ ]");
				const label = pad(row.label, labelW);
				const cells = [
					`${active ? theme.fg("accent", "→") : " "} ${box} ${active ? theme.fg("accent", label) : label}`,
					addressW > 0 ? theme.fg("muted", pad(row.address, addressW)) : "",
					tone(pad(row.route, routeW), row.routeTone),
					row.level ? tone(pad(row.level, levelW), row.levelTone) : theme.fg("dim", pad("·", levelW)),
					row.marks.map((mark) => tone(mark.text, mark.tone ?? "dim")).join(" "),
				].filter((cell) => cell !== "");
				lines.push(truncateToWidth(cells.join("  "), width, theme.fg("dim", "…")));
			}
			const below = rows.length - this.scroll - VISIBLE_ROWS;
			if (below > 0) lines.push(truncateToWidth(`   ${theme.fg("dim", spec.labels.more(below, false))}`, width, ""));
		}

		lines.push("");
		lines.push(truncateToWidth(` ${theme.fg("dim", spec.labels.legend)}`, width, ""));
		const keys = this.selected.size > 0 ? spec.labels.keysSelected(this.selected.size) : spec.labels.keys;
		lines.push(truncateToWidth(` ${theme.fg("dim", keys)}`, width, ""));
		lines.push(border);
		return lines;
	}

	invalidate(): void {}

	private finish(result: HostListResult): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

/** Show the host list until a host is opened, hosts are picked for a batch edit, or Esc. */
export async function showHostList(
	ctx: Pick<ExtensionContext, "ui">,
	build: () => HostListSpec,
	subscribe?: MenuSubscribe,
): Promise<HostListResult> {
	let unsubscribe: (() => void) | undefined;
	try {
		return await ctx.ui.custom<HostListResult>((tui: TUI, theme, keybindings, done) => {
			const list = new HostListComponent(build, theme, keybindings, () => tui.requestRender(), done);
			unsubscribe = subscribe?.(() => tui.requestRender());
			return list;
		});
	} finally {
		unsubscribe?.();
	}
}
