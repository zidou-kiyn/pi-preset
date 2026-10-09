/**
 * Small TUI components shared by the /pi-preset flows: a described single
 * choice list, a masked input for API keys, and a scrollable confirmation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Input,
	type KeybindingsManager,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface PresetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "");
}

/** Greedy word wrap so option descriptions stay readable at narrow widths. */
function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			const candidate = current === "" ? word : `${current} ${word}`;
			if (candidate.length <= width) {
				current = candidate;
				continue;
			}
			if (current !== "") lines.push(current);
			current = word;
		}
		if (current !== "") lines.push(current);
	}
	return lines.map((line) => fit(line, width));
}

/** Single-line input whose value is never rendered; for API keys. */
export class MaskedInputComponent implements Component, Focusable {
	private input = new Input();
	private readonly theme: PresetTheme;
	private readonly title: string;
	private readonly hint: string;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string | undefined) => void;
	private settled = false;
	private _focused = false;

	constructor(
		title: string,
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: string | undefined) => void,
		hint = "The key is hidden while you type.",
	) {
		this.title = title;
		this.hint = hint;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(this.input.getValue());
			return;
		}

		this.input.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const hasValue = this.input.getValue().length > 0;
		const mask = hasValue ? "••••••••" : "";
		const cursor = this._focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : " ";
		return [
			fit(this.theme.bold(this.title), width),
			...wrapText(this.hint, width).map((line) => this.theme.fg("dim", line)),
			fit(`> ${mask}${cursor}`, width),
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.clearInput();
	}

	private clearInput(): void {
		this.input.setValue("");
		this.input = new Input();
		this.input.focused = this._focused;
	}

	private finish(result: string | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.clearInput();
		this.done(result);
	}
}

/** Scrollable review screen: Enter accepts, Esc declines. */
export class DiffConfirmationComponent implements Component {
	private readonly title: string;
	private readonly subtitle: string;
	private readonly diffLines: readonly string[];
	private readonly theme: PresetTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: boolean) => void;
	private readonly maxVisible: number;
	private scroll = 0;
	private settled = false;

	constructor(
		title: string,
		diffLines: readonly string[],
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: boolean) => void,
		maxVisible = 16,
		subtitle = "Review the changes below.",
	) {
		this.title = title;
		this.subtitle = subtitle;
		this.diffLines = diffLines;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		this.maxVisible = Math.max(1, maxVisible);
	}

	getScrollOffset(): number {
		return this.scroll;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(true);
			return;
		}

		const maxScroll = Math.max(0, this.diffLines.length - this.maxVisible);
		if (this.keybindings.matches(data, "tui.select.up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.scroll = Math.min(maxScroll, this.scroll + 1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scroll = Math.max(0, this.scroll - this.maxVisible);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scroll = Math.min(maxScroll, this.scroll + this.maxVisible);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const visible = this.diffLines.slice(this.scroll, this.scroll + this.maxVisible);
		const lines = [fit(this.theme.bold(this.title), width), fit(this.theme.fg("dim", this.subtitle), width)];
		for (const line of visible) {
			const trimmed = line.trimStart();
			const styled = trimmed.startsWith("+")
				? this.theme.fg("success", line)
				: trimmed.startsWith("-")
					? this.theme.fg("error", line)
					: trimmed.startsWith("!")
						? this.theme.fg("warning", line)
						: this.theme.fg("text", line);
			lines.push(fit(styled, width));
		}
		if (this.diffLines.length > this.maxVisible) {
			lines.push(
				fit(
					this.theme.fg(
						"dim",
						`showing ${this.scroll + 1}-${Math.min(this.diffLines.length, this.scroll + this.maxVisible)} of ${this.diffLines.length}`,
					),
					width,
				),
			);
		}
		lines.push(fit(this.theme.fg("dim", "↑↓/PageUp/PageDown scroll · Enter apply · Esc cancel"), width));
		return lines;
	}

	invalidate(): void {}

	private finish(result: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

export interface DescribedOption {
	id: string;
	label: string;
	description: string;
}

/** Single-choice list that shows an explanation of the highlighted option. */
export class DescribedSelectComponent implements Component {
	private readonly title: string;
	private readonly options: readonly DescribedOption[];
	private readonly theme: PresetTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string | undefined) => void;
	private cursor = 0;
	private settled = false;

	constructor(
		title: string,
		options: readonly DescribedOption[],
		theme: PresetTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: string | undefined) => void,
	) {
		this.title = title;
		this.options = options;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
	}

	getCursorIndex(): number {
		return this.cursor;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		const lastIndex = this.options.length - 1;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? lastIndex : this.cursor - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === lastIndex ? 0 : this.cursor + 1;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(this.options[this.cursor]?.id);
			return;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [fit(this.theme.bold(this.title), width)];
		for (let index = 0; index < this.options.length; index++) {
			const option = this.options[index]!;
			const active = index === this.cursor;
			const row = `${active ? "→" : " "} ${option.label}`;
			lines.push(fit(active ? this.theme.fg("accent", row) : row, width));
		}
		const active = this.options[this.cursor];
		if (active) {
			lines.push(fit("", width));
			for (const line of wrapText(active.description, Math.max(1, width - 2))) {
				lines.push(fit(this.theme.fg("dim", `  ${line}`), width));
			}
		}
		lines.push(fit(this.theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"), width));
		return lines;
	}

	invalidate(): void {}

	private finish(result: string | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

export function selectDescribedWithUi(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly DescribedOption[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
		return new DescribedSelectComponent(title, options, theme, keybindings, () => tui.requestRender(), done);
	});
}

export function promptMaskedWithUi(
	ctx: ExtensionCommandContext,
	title: string,
	hint?: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
		return new MaskedInputComponent(title, theme, keybindings, () => tui.requestRender(), done, hint);
	});
}

export function confirmLinesWithUi(
	ctx: ExtensionCommandContext,
	title: string,
	lines: readonly string[],
	subtitle?: string,
): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui: TUI, theme, keybindings, done) => {
		return new DiffConfirmationComponent(
			title,
			lines,
			theme,
			keybindings,
			() => tui.requestRender(),
			done,
			16,
			subtitle,
		);
	});
}
