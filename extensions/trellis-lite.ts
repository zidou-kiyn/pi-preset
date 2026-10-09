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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTrellisConfig } from "../src/trellis-lite/config.ts";
import { detectLegacy, findProjectRoot } from "../src/trellis-lite/root.ts";
import { buildSnapshot, SECTION_NAME } from "../src/trellis-lite/snapshot.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(PACKAGE_ROOT, "trellis-lite");
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

	pi.on("resources_discover", (event) => {
		if (!active(event.cwd)) return;
		return { skillPaths: SKILL_PATHS };
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
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
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${sub}". Use status, init, or migrate.`, "warning");
		},
	});
}
