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
import {
	type CompatFlagOption,
	compatFlagsForApi,
	CUSTOM_API_OPTIONS,
	type CustomApiId,
	type FamilyTemplate,
	MODALITY_OPTIONS,
	THINKING_LEVELS,
	THINKING_PRESETS,
	type ThinkingLevelMap,
} from "./model-templates.ts";
import {
	type CustomModelSpec,
	type CustomProviderSpec,
	parseCostList,
	parseTokenCount,
	validateCustomModelId,
} from "./models-config.ts";

export interface WizardTheme {
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
	let current = "";
	for (const word of text.split(/\s+/)) {
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
	return lines.map((line) => fit(line, width));
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

export interface DescribedOption {
	id: string;
	label: string;
	description: string;
}

/** Single-choice list that shows an explanation of the highlighted option. */
export class DescribedSelectComponent implements Component {
	private readonly title: string;
	private readonly options: readonly DescribedOption[];
	private readonly theme: WizardTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string | undefined) => void;
	private cursor = 0;
	private settled = false;

	constructor(
		title: string,
		options: readonly DescribedOption[],
		theme: WizardTheme,
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

type TriState = "default" | "on" | "off";

/**
 * Tri-state compatibility checklist: each flag cycles default → on → off.
 * "default" omits the flag so Pi keeps its built-in or auto-detected behavior.
 */
export class CompatFlagsComponent implements Component {
	private readonly flags: readonly CompatFlagOption[];
	private readonly theme: WizardTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: Record<string, boolean> | undefined) => void;
	private readonly states: TriState[];
	private cursor = 0;
	private settled = false;

	constructor(
		flags: readonly CompatFlagOption[],
		theme: WizardTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: Record<string, boolean> | undefined) => void,
	) {
		this.flags = flags;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		this.states = flags.map(() => "default");
	}

	getResult(): Record<string, boolean> {
		const result: Record<string, boolean> = {};
		for (let index = 0; index < this.flags.length; index++) {
			const state = this.states[index];
			if (state === "on") result[this.flags[index]!.key] = true;
			else if (state === "off") result[this.flags[index]!.key] = false;
		}
		return result;
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		const lastIndex = this.flags.length;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? lastIndex : this.cursor - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === lastIndex ? 0 : this.cursor + 1;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.cursor === lastIndex) {
				this.finish(this.getResult());
				return;
			}
			const state = this.states[this.cursor]!;
			this.states[this.cursor] = state === "default" ? "on" : state === "on" ? "off" : "default";
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [
			fit(this.theme.bold("Compatibility flags"), width),
			fit(this.theme.fg("dim", "Enter cycles default → true → false. Default keeps Pi's built-in behavior."), width),
		];
		for (let index = 0; index < this.flags.length; index++) {
			const flag = this.flags[index]!;
			const active = index === this.cursor;
			const state = this.states[index];
			const mark = state === "on" ? "[true ]" : state === "off" ? "[false]" : "[  -  ]";
			const row = `${active ? "→" : " "} ${mark} ${flag.key}`;
			lines.push(fit(active ? this.theme.fg("accent", row) : row, width));
		}
		const continueRow = `${this.cursor === this.flags.length ? "→" : " "} Continue`;
		lines.push(fit(this.cursor === this.flags.length ? this.theme.fg("accent", continueRow) : continueRow, width));
		const active = this.flags[this.cursor];
		if (active) {
			lines.push(fit("", width));
			for (const line of wrapText(active.description, Math.max(1, width - 2))) {
				lines.push(fit(this.theme.fg("dim", `  ${line}`), width));
			}
		}
		lines.push(fit(this.theme.fg("dim", "↑↓ navigate · Enter cycle/continue · Esc cancel"), width));
		return lines;
	}

	invalidate(): void {}

	private finish(result: Record<string, boolean> | undefined): void {
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

async function selectDescribedWithUi(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly DescribedOption[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui: TUI, theme, keybindings, done) => {
		return new DescribedSelectComponent(title, options, theme, keybindings, () => tui.requestRender(), done);
	});
}

async function selectCompatFlagsWithUi(
	ctx: ExtensionCommandContext,
	api: CustomApiId,
): Promise<Record<string, boolean> | undefined> {
	return ctx.ui.custom<Record<string, boolean> | undefined>((tui: TUI, theme, keybindings, done) => {
		return new CompatFlagsComponent(compatFlagsForApi(api), theme, keybindings, () => tui.requestRender(), done);
	});
}

/** Prompt until the validator accepts the value; Esc/cancel returns undefined. */
async function promptValidated(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
	validate: (value: string) => string | undefined,
): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.ui.input(title, placeholder);
		if (value === undefined) return undefined;
		const error = validate(value);
		if (error === undefined) return value;
		ctx.ui.notify(error, "warning");
	}
}

const CUSTOM_THINKING_OPTION = {
	id: "custom",
	label: "Custom mapping",
	description:
		"Define the value sent to the provider for each of Pi's seven thinking levels yourself. Leave a level empty to make it unavailable in Pi's selector.",
} as const;

/** Ask for a provider value per thinking level; empty means the level is unavailable. */
async function collectCustomThinkingMap(
	ctx: ExtensionCommandContext,
	ordinal: number,
): Promise<ThinkingLevelMap | undefined> {
	for (;;) {
		const map: Partial<Record<keyof ThinkingLevelMap, string | null>> = {};
		for (const { level, description } of THINKING_LEVELS) {
			const value = await ctx.ui.input(`Model ${ordinal}: thinking level "${level}"`, description);
			if (value === undefined) return undefined;
			map[level] = value.trim() === "" ? null : value.trim();
		}
		const complete = map as ThinkingLevelMap;
		if (Object.values(complete).some((value) => value !== null)) return complete;
		ctx.ui.notify("At least one thinking level needs a value; every level was left empty. Try again.", "warning");
	}
}

async function collectCustomModel(
	ctx: ExtensionCommandContext,
	ordinal: number,
): Promise<CustomModelSpec | undefined> {
	const id = await promptValidated(
		ctx,
		`Model ${ordinal}: model ID`,
		"exact ID the endpoint expects, e.g. gpt-4o-mini or deepseek-chat",
		validateCustomModelId,
	);
	if (id === undefined) return undefined;

	const name = await ctx.ui.input(`Model ${ordinal}: display name`, "shown in /model; empty = use the model ID");
	if (name === undefined) return undefined;

	const modalityId = await selectDescribedWithUi(
		ctx,
		`Model ${ordinal}: input modalities`,
		MODALITY_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description })),
	);
	if (modalityId === undefined) return undefined;
	const modality = MODALITY_OPTIONS.find((option) => option.id === modalityId)!;

	const presetId = await selectDescribedWithUi(ctx, `Model ${ordinal}: reasoning / thinking levels`, [
		...THINKING_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, description: preset.description })),
		CUSTOM_THINKING_OPTION,
	]);
	if (presetId === undefined) return undefined;

	let reasoning: boolean;
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	if (presetId === CUSTOM_THINKING_OPTION.id) {
		thinkingLevelMap = await collectCustomThinkingMap(ctx, ordinal);
		if (thinkingLevelMap === undefined) return undefined;
		reasoning = true;
	} else {
		const preset = THINKING_PRESETS.find((option) => option.id === presetId)!;
		reasoning = preset.reasoning;
		thinkingLevelMap = preset.map === null ? undefined : { ...preset.map };
	}

	const contextWindowText = await promptValidated(
		ctx,
		`Model ${ordinal}: context window (tokens)`,
		"total prompt+output budget, e.g. 128000 or 128k (empty = 128k)",
		(value) =>
			value.trim() === "" || parseTokenCount(value) !== undefined
				? undefined
				: "enter a positive token count such as 128000, 128k, or 1m",
	);
	if (contextWindowText === undefined) return undefined;
	const contextWindow = contextWindowText.trim() === "" ? 128_000 : parseTokenCount(contextWindowText)!;

	const maxTokensText = await promptValidated(
		ctx,
		`Model ${ordinal}: max output tokens`,
		"largest single response, e.g. 8192 or 32k (empty = 8192); must fit in the context window",
		(value) => {
			if (value.trim() === "") return undefined;
			const parsed = parseTokenCount(value);
			if (parsed === undefined) return "enter a positive token count such as 8192 or 32k";
			if (parsed > contextWindow) return "max output tokens cannot exceed the context window";
			return undefined;
		},
	);
	if (maxTokensText === undefined) return undefined;
	const maxTokens = maxTokensText.trim() === "" ? Math.min(8_192, contextWindow) : parseTokenCount(maxTokensText)!;

	const costText = await promptValidated(
		ctx,
		`Model ${ordinal}: cost per 1M tokens`,
		"USD as input,output,cacheRead,cacheWrite — e.g. 2,10,0.2,2.5 (empty = all 0, only affects Pi's cost display)",
		(value) =>
			parseCostList(value) === undefined
				? "enter up to four non-negative numbers separated by commas, e.g. 2,10,0.2,2.5"
				: undefined,
	);
	if (costText === undefined) return undefined;

	return {
		id: id.trim(),
		name: name.trim() === "" ? id.trim() : name.trim(),
		input: [...modality.input],
		reasoning,
		contextWindow,
		maxTokens,
		cost: parseCostList(costText)!,
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
	};
}

/** Interactive flow for a fully custom provider: API protocol, compat flags, then one or more models. */
export async function collectCustomProviderWithUi(
	ctx: ExtensionCommandContext,
): Promise<CustomProviderSpec | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const api = await selectDescribedWithUi(
		ctx,
		"Select the API protocol",
		CUSTOM_API_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description })),
	);
	if (api === undefined) return undefined;

	const compat = await selectCompatFlagsWithUi(ctx, api as CustomApiId);
	if (compat === undefined) return undefined;

	const models: CustomModelSpec[] = [];
	for (;;) {
		const model = await collectCustomModel(ctx, models.length + 1);
		if (model === undefined) return undefined;
		if (models.some((existing) => existing.id === model.id)) {
			ctx.ui.notify(`Model "${model.id}" is already defined; it was not added again`, "warning");
		} else {
			models.push(model);
		}
		const addAnother = await ctx.ui.confirm(
			"Add another model?",
			`${models.length} model${models.length === 1 ? "" : "s"} defined so far. Add one more to this provider?`,
		);
		if (!addAnother) break;
	}

	return { api, compat, models };
}
