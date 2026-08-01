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
import type { FamilyTemplate } from "./model-templates.ts";

export interface WizardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "");
}

function pageSize(modelCount: number): number {
	return Math.max(1, Math.min(8, modelCount));
}

export class ModelChecklistComponent implements Component {
	private readonly family: FamilyTemplate;
	private readonly theme: WizardTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string[] | undefined) => void;
	private readonly selected = new Set<string>();
	private cursor = 0;
	private settled = false;

	constructor(
		family: FamilyTemplate,
		theme: WizardTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: string[] | undefined) => void,
	) {
		this.family = family;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
	}

	getSelectedModelIds(): string[] {
		return this.family.models.filter((model) => this.selected.has(model.id)).map((model) => model.id);
	}

	isContinueEnabled(): boolean {
		return this.selected.size > 0;
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

		const lastIndex = this.family.models.length;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? lastIndex : this.cursor - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === lastIndex ? 0 : this.cursor + 1;
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - pageSize(this.family.models.length));
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.min(lastIndex, this.cursor + pageSize(this.family.models.length));
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.cursor === lastIndex) {
				if (this.isContinueEnabled()) this.finish(this.getSelectedModelIds());
				return;
			}
			const model = this.family.models[this.cursor];
			if (model) {
				if (this.selected.has(model.id)) this.selected.delete(model.id);
				else this.selected.add(model.id);
			}
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [
			fit(this.theme.bold(`Select ${this.family.label} models`), width),
			fit(this.theme.fg("dim", "Choose one or more models, then move to Continue."), width),
		];

		for (let index = 0; index < this.family.models.length; index++) {
			const model = this.family.models[index]!;
			const active = index === this.cursor;
			const checked = this.selected.has(model.id);
			const row = `${active ? "→" : " "} [${checked ? "x" : " "}] ${model.name}`;
			lines.push(fit(active ? this.theme.fg("accent", row) : row, width));
		}

		const continueRow = `${this.cursor === this.family.models.length ? "→" : " "} Continue`;
		lines.push(
			fit(
				this.isContinueEnabled()
					? this.cursor === this.family.models.length
						? this.theme.fg("accent", continueRow)
						: continueRow
					: this.theme.fg("dim", `${continueRow} (select a model first)`),
				width,
			),
		);
		lines.push(fit(this.theme.fg("dim", "↑↓ navigate · Enter toggle/continue · Esc cancel"), width));
		return lines;
	}

	invalidate(): void {}

	private finish(result: string[] | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

export class MaskedInputComponent implements Component, Focusable {
	private input = new Input();
	private readonly theme: WizardTheme;
	private readonly title: string;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string | undefined) => void;
	private settled = false;
	private _focused = false;

	constructor(
		title: string,
		theme: WizardTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: string | undefined) => void,
	) {
		this.title = title;
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
		const prompt = `${this.theme.bold(this.title)}\n${this.theme.fg("dim", "The key is hidden while you type.")}\n> ${mask}${cursor}`;
		return prompt.split("\n").map((line) => fit(line, width));
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

export class DiffConfirmationComponent implements Component {
	private readonly title: string;
	private readonly diffLines: readonly string[];
	private readonly theme: WizardTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: boolean) => void;
	private readonly maxVisible: number;
	private scroll = 0;
	private settled = false;

	constructor(
		title: string,
		diffLines: readonly string[],
		theme: WizardTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: boolean) => void,
		maxVisible = 12,
	) {
		this.title = title;
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
		const lines = [
			fit(this.theme.bold(this.title), width),
			fit(this.theme.fg("dim", "Review the redacted provider diff."), width),
		];
		for (const line of visible) {
			const styled = line.startsWith("+")
				? this.theme.fg("success", line)
				: line.startsWith("-")
					? this.theme.fg("error", line)
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

export async function selectModelsWithUi(
	ctx: ExtensionCommandContext,
	family: FamilyTemplate,
): Promise<string[] | undefined> {
	const result = await ctx.ui.custom<string[] | undefined>((tui: TUI, theme, keybindings, done) => {
		return new ModelChecklistComponent(family, theme, keybindings, () => tui.requestRender(), done);
	});
	return result;
}

export async function promptApiKeyWithUi(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
		return new MaskedInputComponent("API key", theme, keybindings, () => tui.requestRender(), done);
	});
}

export async function confirmProviderDiff(
	ctx: ExtensionCommandContext,
	title: string,
	diffLines: readonly string[],
): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	return ctx.ui.custom<boolean>((tui: TUI, theme, keybindings, done) => {
		return new DiffConfirmationComponent(title, diffLines, theme, keybindings, () => tui.requestRender(), done);
	});
}
