/**
 * Opt-in package checklist shown before a preset sync.
 *
 * Already-installed entries render checked and locked: the preset is
 * additive-only, so unchecking an installed package would promise a removal
 * that apply() will never perform.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { OptionalPackage } from "./manifest.ts";

interface ChecklistTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "");
}

/** Greedy word wrap so descriptions stay readable at narrow widths. */
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

export class OptionalPackagesComponent implements Component {
	private readonly packages: readonly OptionalPackage[];
	private readonly installed: ReadonlySet<string>;
	private readonly theme: ChecklistTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: string[] | undefined) => void;
	private readonly checked: Set<string>;
	private cursor = 0;
	private settled = false;

	constructor(
		packages: readonly OptionalPackage[],
		installed: ReadonlySet<string>,
		theme: ChecklistTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: string[] | undefined) => void,
	) {
		this.packages = packages;
		this.installed = installed;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		// Installed entries start checked; they stay checked (locked) because the
		// sync never removes packages.
		this.checked = new Set(packages.filter((pkg) => installed.has(pkg.source)).map((pkg) => pkg.source));
	}

	/** Checked sources that are not already installed — the extras a plan should add. */
	getExtraSources(): string[] {
		return this.packages
			.filter((pkg) => this.checked.has(pkg.source) && !this.installed.has(pkg.source))
			.map((pkg) => pkg.source);
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		const lastIndex = this.packages.length;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? lastIndex : this.cursor - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === lastIndex ? 0 : this.cursor + 1;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.cursor === lastIndex) {
				this.finish(this.getExtraSources());
				return;
			}
			const pkg = this.packages[this.cursor];
			if (pkg && !this.installed.has(pkg.source)) {
				if (this.checked.has(pkg.source)) this.checked.delete(pkg.source);
				else this.checked.add(pkg.source);
			}
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [
			fit(this.theme.bold("Optional extensions"), width),
			fit(this.theme.fg("dim", "Check the browser-automation extensions this machine should install."), width),
		];
		for (let index = 0; index < this.packages.length; index++) {
			const pkg = this.packages[index]!;
			const active = index === this.cursor;
			const installed = this.installed.has(pkg.source);
			const checked = this.checked.has(pkg.source);
			const suffix = installed ? " (installed)" : "";
			const row = `${active ? "→" : " "} [${checked ? "x" : " "}] ${pkg.label}${suffix}`;
			lines.push(fit(active ? this.theme.fg("accent", row) : installed ? this.theme.fg("dim", row) : row, width));
		}
		const continueRow = `${this.cursor === this.packages.length ? "→" : " "} Continue`;
		lines.push(fit(this.cursor === this.packages.length ? this.theme.fg("accent", continueRow) : continueRow, width));
		const active = this.packages[this.cursor];
		if (active) {
			lines.push(fit("", width));
			for (const line of wrapText(active.description, Math.max(1, width - 2))) {
				lines.push(fit(this.theme.fg("dim", `  ${line}`), width));
			}
		}
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

/**
 * Show the optional-package checklist. Resolves to the extra sources to add,
 * or undefined when the user cancels.
 */
export async function selectOptionalPackagesWithUi(
	ctx: ExtensionCommandContext,
	packages: readonly OptionalPackage[],
	installed: ReadonlySet<string>,
): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui: TUI, theme, keybindings, done) => {
		return new OptionalPackagesComponent(packages, installed, theme, keybindings, () => tui.requestRender(), done);
	});
}
