/** Human report and CLI entry for the migration (trellis-lite/bin/trellis-lite.ts migrate). */

import { homedir } from "node:os";
import { findProjectRoot } from "../root.ts";
import { type ApplyReport, applyMigration, type MigrationPlan, type PathItem, scanMigration } from "./run.ts";

const MAX_LINES = 30;

/** Collapse paths into units: one line per Trellis skill/agent/command directory or runtime area. */
function unitOf(path: string): string {
	if (/^\.trellis\/\.backup-/u.test(path)) return ".trellis/.backup-*/";
	if (path.includes("__pycache__/")) return "__pycache__/ directories";
	const segments = path.split("/");
	const owned = segments.findIndex((segment, index) => index < segments.length - 1 && /^(mini-)?trellis(-|$)/u.test(segment));
	if (owned >= 0) return `${segments.slice(0, owned + 1).join("/")}/`;
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "./" : path.slice(0, slash + 1);
}

function grouped(items: readonly PathItem[]): string[] {
	const units = new Map<string, { entries: number; files: number }>();
	for (const item of items) {
		const key = unitOf(item.path);
		const unit = units.get(key) ?? { entries: 0, files: 0 };
		unit.entries += 1;
		unit.files += item.files ?? 1;
		units.set(key, unit);
	}
	return [...units.entries()].map(([key, unit]) => `  ${key} (${unit.files} file${unit.files === 1 ? "" : "s"})`);
}

function capped(lines: string[], limit = MAX_LINES): string[] {
	return lines.length > limit ? [...lines.slice(0, limit), `  … ${lines.length - limit} more (--json lists all)`] : lines;
}

export function formatPlan(plan: MigrationPlan): string {
	const out: string[] = [
		`Trellis${plan.trellisVersion ? ` ${plan.trellisVersion}` : ""} → trellis-lite migration plan (dry run) for ${plan.root}`,
		!plan.git.repo
			? "! not a git repository: apply is refused"
			: plan.git.clean
				? "git: work tree clean"
				: `! git: ${plan.git.dirty.length} uncommitted change(s); apply is refused until they are committed or stashed`,
	];
	if (!plan.hashTable) out.push("! no .trellis/.template-hashes.json: templates cannot be verified, so every Trellis file is needs-review");
	if (plan.nothingToDo) {
		out.push("", "Nothing to do: no Trellis files are left.");
	} else {
		if (plan.delete.length) {
			out.push("", `Delete (${plan.delete.length}: unmodified templates and runtime leftovers):`, ...capped(grouped(plan.delete)));
		}
		if (plan.edit.length) {
			out.push("", "Edit (only the Trellis parts):");
			for (const item of plan.edit) {
				out.push(`  ${item.path}: ${item.action === "delete" ? "delete the file (nothing else in it)" : "remove"}`);
				for (const line of item.removed.slice(0, 6)) out.push(`    - ${line}`);
				if (item.removed.length > 6) out.push(`    - … ${item.removed.length - 6} more line(s)`);
			}
		}
		for (const [dir, group] of Object.entries(plan.hosts)) {
			if (group.delete.length + group.review.length === 0) continue;
			out.push(
				"",
				`Other host ${dir}/ (kept unless removed with --remove-hosts ${dir.replace(/^\./u, "")}): ${group.delete.length} unmodified, ${group.review.length} modified or unregistered`,
			);
			if (group.review.length) out.push(...capped(group.review.map((item) => `  ${item.path} (${item.reason})`), 6));
		}
		if (plan.needsReview.length) {
			out.push("", "Needs review (kept; the AI-guided step decides):", ...plan.needsReview.map((item) => `  ${item.path} (${item.reason})`));
		}
	}
	if (plan.staleReferences.length) {
		out.push(
			"",
			"References to removed Trellis machinery:",
			...capped(plan.staleReferences.map((ref) => `  ${ref.file}:${ref.line} ${ref.term}`)),
		);
	}
	if (plan.activeTasks.length) {
		out.push("", "Open tasks (kept as they are):", ...plan.activeTasks.map((task) => `  ${task.path}${task.trellisFiles.length ? ` (${task.trellisFiles.join(", ")} unused by trellis-lite)` : ""}`));
	}
	return out.join("\n");
}

export function formatApply(report: ApplyReport): string {
	return [
		`Deleted ${report.deleted.length} path(s); edited ${report.edited.length}; created ${report.created.length}.`,
		...report.edited.map((line) => `  ${line}`),
		...report.created.map((path) => `  created ${path}`),
		report.trellisVersion ? `Trellis version was ${report.trellisVersion} (.trellis/.version is now deleted).` : "",
		report.needsReview.length
			? `Kept for review:\n${report.needsReview.map((item) => `  ${item.path} (${item.reason})`).join("\n")}`
			: "Nothing left for review.",
		"Not committed; see git status.",
	]
		.filter(Boolean)
		.join("\n");
}

export function runMigrateCli(cwd: string, flags: Map<string, string | true>): number {
	const root = findProjectRoot(cwd, homedir());
	if (!root) {
		console.error("Not inside a Trellis project (no .trellis/ up to the repository root).");
		return 1;
	}
	if (flags.has("apply")) {
		if (!flags.has("yes")) {
			console.error("--apply also needs --yes (after the user confirmed the dry-run plan).");
			return 2;
		}
		const hosts = typeof flags.get("remove-hosts") === "string" ? String(flags.get("remove-hosts")).split(",").map((s) => s.trim()).filter(Boolean) : [];
		const report = applyMigration(root, { removeHosts: hosts.map((host) => (host.startsWith(".") ? host : `.${host}`)) });
		console.log(flags.has("json") ? JSON.stringify(report, null, 2) : formatApply(report));
		return 0;
	}
	const plan = scanMigration(root);
	if (flags.has("json")) {
		const { edit, ...rest } = plan;
		console.log(JSON.stringify({ ...rest, edit: edit.map(({ text: _text, ...item }) => item) }, null, 2));
	} else {
		console.log(formatPlan(plan));
	}
	return 0;
}
