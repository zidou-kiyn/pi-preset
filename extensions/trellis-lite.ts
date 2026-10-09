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
 * Command: /trellis-lite [status|init|migrate], /trellis-lite-migrate
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

	pi.registerCommand("trellis-lite", {
		description: "trellis-lite: status (default), init, migrate",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/u).filter(Boolean);
			if (sub === "status") {
				const found = project(ctx.cwd);
				if (!found) {
					ctx.ui.notify("Not a Trellis project (no .trellis/ up to the repository root). /trellis-lite init creates one.", "info");
					return;
				}
				const lines = [`root: ${found.root}`];
				if (found.legacy.length > 0) {
					lines.push(`paused, old Trellis assets: ${found.legacy.join(", ")}`, "run /trellis-lite-migrate");
				} else {
					const text = snapshot ?? buildSnapshot(found.root, { specInjection: config.specInjection });
					lines.push(`project-memory section (${text.length} chars):`, text);
					const { rules, problems } = (specIndex?.root === found.root ? specIndex : new SpecIndex(found.root)).scan();
					lines.push(`path-scoped specs: ${rules.length}${config.specInjection ? "" : " (injection off)"}`);
					for (const problem of problems) lines.push(`  ! ${problem.path}: ${problem.message}`);
					if (injected?.size) {
						lines.push(`in context this session: ${[...injected.keys()].join(", ")}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "init") {
				const root = project(ctx.cwd)?.root ?? gitToplevel(ctx.cwd) ?? ctx.cwd;
				let developer = readDeveloper(root);
				if (!developer) {
					const suggested = developerId(gitUserName(root) ?? "");
					const answer = ctx.hasUI ? await ctx.ui.input("Developer name (journal directory)", suggested) : suggested;
					developer = developerId(answer?.trim() || suggested);
					if (!developer) {
						ctx.ui.notify("No developer name given; nothing created.", "warning");
						return;
					}
				}
				const steps = planInit(root, developer, today(), new Date().toISOString().slice(0, 19));
				if (steps.length === 0) {
					ctx.ui.notify(`${root} is already initialized.`, "info");
					return;
				}
				const summary = steps.map((step) => `${step.append ? "append" : "create"} ${step.path}`).join("\n");
				if (ctx.hasUI && !(await ctx.ui.confirm("Initialize trellis-lite?", `${root}\n\n${summary}`))) return;
				applyInit(root, steps);
				projects.clear();
				ctx.ui.notify(`${summary}\n\nNot committed (see git status). Run /reload to load the trellis-lite skills.`, "info");
				return;
			}
			if (sub === "migrate") {
				const found = project(ctx.cwd);
				if (!found) {
					ctx.ui.notify("Not a Trellis project; nothing to migrate.", "info");
					return;
				}
				ctx.ui.notify(`${formatPlan(scanMigration(found.root))}\n\nRun /trellis-lite-migrate to carry it out with the agent.`, "info");
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${sub}". Use status, init, or migrate.`, "warning");
		},
	});

	pi.registerCommand("trellis-lite-migrate", {
		description: "Migrate this project from Trellis to trellis-lite with the agent (dry run first, asks before every change)",
		handler: async (_args, ctx) => {
			if (!project(ctx.cwd)) {
				ctx.ui.notify("Not a Trellis project; nothing to migrate.", "info");
				return;
			}
			const prompt = readFileSync(join(RESOURCES, "prompts", "migrate.md"), "utf8").replaceAll("{{CLI}}", CLI_PATH);
			pi.sendUserMessage(prompt);
		},
	});
}
