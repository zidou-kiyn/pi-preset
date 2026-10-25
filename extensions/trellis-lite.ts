/**
 * trellis-lite — spec, journal, and light task planning for projects that
 * keep a `.trellis/` directory, without Trellis's workflow machinery.
 *
 * Why: Trellis on pi costs about 7k tokens before the first message (workflow
 * phases, nine skill descriptions, a duplicated overview, a per-turn
 * breadcrumb) and 20k+ more while a task is active, because task documents
 * and every listed spec are copied into the system prompt. The valuable part
 * is the knowledge in `.trellis/spec/`, the journal, and task notes; this
 * extension keeps those, reads the same files, and costs about 450 tokens.
 *
 * Effect, only inside a Trellis project (nearest `.trellis/` up to the repo
 * root; nothing at all elsewhere):
 *   - a `project-memory` system prompt section listing spec indexes, the
 *     journal, open tasks, and research notes by path. Computed once per
 *     session and identical on every turn, so the cached prefix holds.
 *   - the trellis-spec, trellis-journal, and trellis-plan skills, provided
 *     per project through `resources_discover` (never in other projects).
 *   - path-scoped specs: a spec whose frontmatter `paths:` matches a file the
 *     model reads or edits is appended to that tool result, once per session.
 *   - while old Trellis / mini-trellis pi assets are installed in the project,
 *     all of the above stays off and `/trellis-lite-migrate` is offered.
 * No per-turn injection, no tool rewriting, no tools, no Python.
 *
 * Env:
 *   PI_PRESET_TRELLIS=off          disable the extension
 *   PI_PRESET_TRELLIS_SPECS=off    keep everything but path-scoped specs
 *
 * Runtime: pi-preset/extensions/trellis-lite.ts (logic in src/trellis-lite/)
 * Command: /trellis-lite (menu: status at the top, init / migrate when they
 *          apply; typed: status, init, migrate), /trellis-lite-migrate
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MenuItem, type Notice, showMenu } from "../src/preset-menu.ts";
import { confirmLinesWithUi } from "../src/preset-ui.ts";
import { readTrellisConfig } from "../src/trellis-lite/config.ts";
import { applyInit, developerId, gitToplevel, gitUserName, planInit } from "../src/trellis-lite/init.ts";
import { today } from "../src/trellis-lite/journal.ts";
import { formatPlan } from "../src/trellis-lite/migrate/cli.ts";
import { scanMigration } from "../src/trellis-lite/migrate/run.ts";
import { detectLegacy, findProjectRoot, readDeveloper } from "../src/trellis-lite/root.ts";
import { buildSnapshot, SECTION_NAME } from "../src/trellis-lite/snapshot.ts";
import {
	buildInjection,
	contextToolTexts,
	type Injected,
	isTrellisPath,
	readMarkers,
	repoRelative,
	SpecIndex,
	touchedPaths,
} from "../src/trellis-lite/spec-inject.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(PACKAGE_ROOT, "trellis-lite");
const CLI_PATH = join(RESOURCES, "bin", "trellis-lite.ts");
const SKILL_PATHS = ["trellis-spec", "trellis-journal", "trellis-plan"].map((name) =>
	join(RESOURCES, "skills", name, "SKILL.md"),
);

interface Project {
	root: string;
	legacy: string[];
}

export default function trellisLite(pi: ExtensionAPI): void {
	const config = readTrellisConfig(process.env);
	if (!config.enabled) return;

	const projects = new Map<string, Project | null>();
	const project = (cwd: string): Project | undefined => {
		if (!projects.has(cwd)) {
			const root = findProjectRoot(cwd);
			projects.set(cwd, root ? { root, legacy: detectLegacy(root) } : null);
		}
		return projects.get(cwd) ?? undefined;
	};
	const active = (cwd: string): Project | undefined => {
		const found = project(cwd);
		return found && found.legacy.length === 0 ? found : undefined;
	};

	let snapshot: string | undefined;
	let legacyNotified = false;
	let specIndex: SpecIndex | undefined;
	// Specs already in the model's context; undefined = re-derive from the session.
	let injected: Map<string, Injected> | undefined;
	const forget = () => {
		injected = undefined;
	};
	pi.on("session_tree", forget);
	pi.on("session_compact", forget);

	pi.on("resources_discover", (event) => {
		if (!active(event.cwd)) return;
		return { skillPaths: SKILL_PATHS };
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		forget();
		const found = project(ctx.cwd);
		if (!found || found.legacy.length === 0 || legacyNotified || !ctx.hasUI) return;
		legacyNotified = true;
		ctx.ui.notify(
			`trellis-lite is paused: old Trellis pi assets are installed (${found.legacy.slice(0, 3).join(", ")}${
				found.legacy.length > 3 ? ", …" : ""
			}). Run /trellis-lite-migrate to migrate.`,
			"warning",
		);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const found = active(ctx.cwd);
		if (!found) return;
		snapshot ??= buildSnapshot(found.root, { specInjection: config.specInjection });
		event.systemPromptOptions.sections[SECTION_NAME] = snapshot;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!config.specInjection || event.isError || event.parentToolCallId) return;
		const paths = touchedPaths(event.toolName, event.input);
		if (paths.length === 0) return;
		const found = active(ctx.cwd);
		if (!found) return;
		if (specIndex?.root !== found.root) specIndex = new SpecIndex(found.root);
		if (!injected) {
			const manager = ctx.sessionManager;
			injected = readMarkers(contextToolTexts(manager.buildContextEntries?.() ?? manager.getBranch()));
		}
		const texts: string[] = [];
		for (const path of paths) {
			const file = repoRelative(found.root, ctx.cwd, path);
			if (!file || isTrellisPath(file)) continue;
			const rules = specIndex.match(file);
			if (rules.length === 0) continue;
			const result = buildInjection({ root: found.root, file, rules, state: injected });
			if (!result) continue;
			texts.push(result.text);
			for (const [spec, entry] of result.added) injected.set(spec, entry);
		}
		if (texts.length === 0) return;
		return {
			content: [...event.content, { type: "text" as const, text: texts.join("\n\n") }],
			structuredContent: event.structuredContent,
		};
	});

	// ── /trellis-lite ───────────────────────────────────────────────────────

	const statusLines = (cwd: string): string[] => {
		const found = project(cwd);
		if (!found) return ["Not a Trellis project (no .trellis/ up to the repository root)."];
		const lines = [`Project: ${found.root}`];
		if (found.legacy.length > 0) {
			lines.push(`Paused: old Trellis assets are installed (${found.legacy.slice(0, 3).join(", ")}${found.legacy.length > 3 ? ", …" : ""}).`);
			return lines;
		}
		const text = snapshot ?? buildSnapshot(found.root, { specInjection: config.specInjection });
		const { rules, problems } = (specIndex?.root === found.root ? specIndex : new SpecIndex(found.root)).scan();
		lines.push(
			`project-memory section: ${text.length} chars · path-scoped specs: ${rules.length}${config.specInjection ? "" : " (injection off)"}`,
		);
		if (!readDeveloper(found.root)) lines.push("No developer set yet (.trellis/.developer): initialize to start a journal.");
		for (const problem of problems) lines.push(`! ${problem.path}: ${problem.message}`);
		if (injected?.size) lines.push(`Specs in context this session: ${[...injected.keys()].join(", ")}`);
		return lines;
	};

	const init = async (ctx: ExtensionCommandContext): Promise<Notice | undefined> => {
		const root = project(ctx.cwd)?.root ?? gitToplevel(ctx.cwd) ?? ctx.cwd;
		let developer = readDeveloper(root);
		if (!developer) {
			const suggested = developerId(gitUserName(root) ?? "");
			const answer = ctx.hasUI ? await ctx.ui.input("Developer name (journal directory)", suggested) : suggested;
			developer = developerId(answer?.trim() || suggested);
			if (!developer) return { text: "No developer name given; nothing created.", type: "warning" };
		}
		const steps = planInit(root, developer, today(), new Date().toISOString().slice(0, 19));
		if (steps.length === 0) return { text: `${root} is already initialized.`, type: "info" };
		const summary = steps.map((step) => `${step.append ? "append" : "create"} ${step.path}`);
		if (ctx.hasUI && !(await ctx.ui.confirm("Initialize trellis-lite?", `${root}\n\n${summary.join("\n")}`))) return undefined;
		applyInit(root, steps);
		projects.clear();
		return { text: `${summary.join("; ")}. Not committed (see git status). Run /reload to load the trellis-lite skills.`, type: "success" };
	};

	const migrationPlan = (cwd: string): string | undefined => {
		const found = project(cwd);
		return found ? formatPlan(scanMigration(found.root)) : undefined;
	};

	const startMigration = (cwd: string): boolean => {
		if (!project(cwd)) return false;
		const prompt = readFileSync(join(RESOURCES, "prompts", "migrate.md"), "utf8").replaceAll("{{CLI}}", CLI_PATH);
		pi.sendUserMessage(prompt);
		return true;
	};

	const menuItems = (cwd: string): MenuItem[] => {
		const found = project(cwd);
		const items: MenuItem[] = [];
		if (!found || !readDeveloper(found.root)) {
			items.push({ value: "init", label: "Initialize trellis-lite here", description: "Creates the missing .trellis/ skeleton (spec indexes, workspace, journal) after showing the file list. Nothing is committed." });
		}
		if (found && found.legacy.length > 0) {
			items.push(
				{ value: "migrate", label: "Migrate from Trellis with the agent", description: "Sends the migration prompt: dry run first, then asks before every change. Closes this menu." },
				{ value: "plan", label: "Show the migration plan", description: "Read-only: what the migration would move, keep, and remove." },
			);
		}
		if (found && found.legacy.length === 0) {
			items.push({ value: "section", label: "Show the project-memory section", description: "The exact text added to the system prompt in this project." });
		}
		return items;
	};

	const runMenu = async (ctx: ExtensionCommandContext) => {
		let notice: Notice | undefined;
		let selected: string | undefined;
		for (;;) {
			const items = menuItems(ctx.cwd);
			const choice = await showMenu(ctx, () => ({ title: "trellis-lite", status: statusLines(ctx.cwd), notice, items, selected }));
			if (!choice) return;
			selected = choice;
			notice = undefined;
			if (choice === "init") notice = await init(ctx);
			else if (choice === "migrate") {
				if (startMigration(ctx.cwd)) return;
			} else if (choice === "plan") {
				const text = migrationPlan(ctx.cwd);
				if (text) await confirmLinesWithUi(ctx, "Migration plan (read-only)", text.split("\n"));
			} else if (choice === "section") {
				const found = project(ctx.cwd);
				if (found) {
					const text = snapshot ?? buildSnapshot(found.root, { specInjection: config.specInjection });
					await confirmLinesWithUi(ctx, `project-memory section (${text.length} chars)`, text.split("\n"));
				}
			}
		}
	};

	pi.registerCommand("trellis-lite", {
		description: "trellis-lite: project status, init, migrate (subcommands: status, init, migrate)",
		getArgumentCompletions: (prefix) => {
			const matches = ["status", "init", "migrate"].filter((sub) => sub.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [sub] = args.trim().split(/\s+/u).filter(Boolean);
			if (!sub) {
				if (ctx.hasUI) await runMenu(ctx);
				else ctx.ui.notify(statusLines(ctx.cwd).join("\n"), "info");
				return;
			}
			if (sub === "status") {
				const found = project(ctx.cwd);
				const lines = statusLines(ctx.cwd);
				if (found && found.legacy.length === 0) {
					lines.push("", snapshot ?? buildSnapshot(found.root, { specInjection: config.specInjection }));
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "init") {
				const result = await init(ctx);
				if (result) ctx.ui.notify(result.text, result.type === "success" ? "info" : result.type);
				return;
			}
			if (sub === "migrate") {
				const text = migrationPlan(ctx.cwd);
				ctx.ui.notify(text ? `${text}\n\nRun /trellis-lite-migrate to carry it out with the agent.` : "Not a Trellis project; nothing to migrate.", "info");
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${sub}". Use status, init, or migrate.`, "warning");
		},
	});

	pi.registerCommand("trellis-lite-migrate", {
		description: "Migrate this project from Trellis to trellis-lite with the agent (dry run first, asks before every change)",
		handler: async (_args, ctx) => {
			if (!startMigration(ctx.cwd)) ctx.ui.notify("Not a Trellis project; nothing to migrate.", "info");
		},
	});
}
