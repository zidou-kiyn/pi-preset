/**
 * Package checklist shown before a preset sync.
 *
 * packages[] is managed as a whitelist, so this screen is where consent for
 * every removal comes from:
 *
 *   - Optional extensions: checked = installed after the sync. Installed ones
 *     start checked; unchecking one removes it.
 *   - Packages outside the preset: start UNCHECKED. Check the ones to keep;
 *     everything left unchecked is removed.
 *
 * The plan diff that follows still lists every removal and needs its own
 * confirmation, so nothing is written from this screen.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { OptionalPackage } from "./manifest.ts";
import type { UnlistedPackage } from "./plan.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

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

export interface PackageSelection {
	/** Every checked optional source, installed or not. */
	extraPackages: string[];
	/** Sources outside the preset the user checked to keep. */
	keep: string[];
}

interface Row {
	kind: "optional" | "unlisted";
	source: string;
	label: string;
	description: string;
	installed: boolean;
}

/** Untrusted settings.json text, made safe for a single terminal line. */
function display(value: string): string {
	return sanitizeTerminalText(value, 500).replace(/\n+/g, " ");
}

function unlistedDescription(source: string): string {
	const kind = source.startsWith("npm:") ? "npm" : /^(git|github):|^(https?|ssh):\/\/|^git@/.test(source) ? "git" : "local";
	if (kind === "local") {
		return "Not part of the preset. Unchecked: the entry is removed from settings.json; the local directory itself is left alone.";
	}
	return `Not part of the preset. Unchecked: \`pi remove\` drops it from settings.json and deletes its installed ${kind} files.`;
}

export class PackageChecklistComponent implements Component {
	private readonly rows: Row[];
	private readonly optionalCount: number;
	private readonly theme: ChecklistTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (result: PackageSelection | undefined) => void;
	private readonly checked: Set<string>;
	private cursor = 0;
	private settled = false;

	constructor(
		packages: readonly OptionalPackage[],
		installedOptional: ReadonlySet<string>,
		unlisted: readonly UnlistedPackage[],
		theme: ChecklistTheme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (result: PackageSelection | undefined) => void,
	) {
		this.rows = [
			...packages.map(
				(pkg): Row => ({
					kind: "optional",
					source: pkg.source,
					label: pkg.label,
					description: pkg.description,
					installed: installedOptional.has(pkg.source),
				}),
			),
			...unlisted.map(
				(pkg): Row => ({
					kind: "unlisted",
					source: pkg.source,
					label: display(pkg.source),
					description: unlistedDescription(pkg.source),
					installed: true,
				}),
			),
		];
		this.optionalCount = packages.length;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
		// Installed optional packages start checked; packages outside the preset
		// start unchecked (removed unless the user keeps them).
		this.checked = new Set(this.rows.filter((row) => row.kind === "optional" && row.installed).map((row) => row.source));
	}

	getSelection(): PackageSelection {
		const checked = (kind: Row["kind"]) =>
			this.rows.filter((row) => row.kind === kind && this.checked.has(row.source)).map((row) => row.source);
		return { extraPackages: checked("optional"), keep: checked("unlisted") };
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		const lastIndex = this.rows.length;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? lastIndex : this.cursor - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === lastIndex ? 0 : this.cursor + 1;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.cursor === lastIndex) {
				this.finish(this.getSelection());
				return;
			}
			const row = this.rows[this.cursor];
			if (row) {
				if (this.checked.has(row.source)) this.checked.delete(row.source);
				else this.checked.add(row.source);
			}
		}
		this.requestRender();
	}

	private renderRow(index: number, width: number): string {
		const row = this.rows[index]!;
		const active = index === this.cursor;
		const checked = this.checked.has(row.source);
		let suffix = "";
		if (row.kind === "optional" && row.installed && !checked) suffix = " (installed, will be removed)";
		else if (row.kind === "optional" && row.installed) suffix = " (installed)";
		else if (row.kind === "unlisted" && !checked) suffix = " (will be removed)";
		const text = `${active ? "→" : " "} [${checked ? "x" : " "}] ${row.label}`;
		if (active) return fit(this.theme.fg("accent", text + suffix), width);
		const warn = suffix.includes("removed");
		return fit(text + (warn ? this.theme.fg("warning", suffix) : this.theme.fg("dim", suffix)), width);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.optionalCount > 0) {
			lines.push(fit(this.theme.bold("Optional extensions"), width));
			lines.push(
				fit(this.theme.fg("dim", "Checked = installed after the sync. Unchecking an installed one removes it."), width),
			);
			for (let index = 0; index < this.optionalCount; index++) lines.push(this.renderRow(index, width));
		}

		if (this.rows.length > this.optionalCount) {
			if (lines.length > 0) lines.push(fit("", width));
			lines.push(fit(this.theme.bold("Packages not in the preset"), width));
			lines.push(fit(this.theme.fg("dim", "Check the ones to keep. Unchecked packages are removed."), width));
			for (let index = this.optionalCount; index < this.rows.length; index++) lines.push(this.renderRow(index, width));
		}

		lines.push(fit("", width));
		const onContinue = this.cursor === this.rows.length;
		const continueRow = `${onContinue ? "→" : " "} Continue`;
		lines.push(fit(onContinue ? this.theme.fg("accent", continueRow) : continueRow, width));
		const active = this.rows[this.cursor];
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

	private finish(result: PackageSelection | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

/**
 * Show the package checklist. Resolves to the selection, or undefined when the
 * user cancels.
 */
export async function selectPackagesWithUi(
	ctx: ExtensionCommandContext,
	packages: readonly OptionalPackage[],
	installedOptional: ReadonlySet<string>,
	unlisted: readonly UnlistedPackage[],
): Promise<PackageSelection | undefined> {
	return ctx.ui.custom<PackageSelection | undefined>((tui: TUI, theme, keybindings, done) => {
		return new PackageChecklistComponent(
			packages,
			installedOptional,
			unlisted,
			theme,
			keybindings,
			() => tui.requestRender(),
			done,
		);
	});
}
