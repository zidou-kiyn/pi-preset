/**
 * skills-store — skills kept on hand but loaded only when enabled.
 *
 * pi loads every skill in its skill directories into every session. This
 * extension keeps a second set, the store (src/skills-store/catalog.ts:
 * skills bundled with the preset plus the user's own under
 * ~/.pi/agent/pi-preset/skills/), and reports to pi only the ones enabled
 * for the current session, directory, or always (src/skills-store/state.ts).
 *
 *   /skills            the store: enable at a level, use now, install from
 *                      GitHub or a path, recommended skills, search skills.sh,
 *                      check updates, move pi's own skills into the store
 *   skills (tool)      the same for the model: search, list, use, enable,
 *                      install (asks you first), create
 *
 * Enabling from the menu reloads at once (resources_discover re-runs and pi
 * lists the skill). A tool can not reload, so an enable from the model
 * returns the instructions right away and the listing waits for the next
 * /reload; the footer marks that with `*`. "Use now" sends the same message
 * `/skill:name` would, with no reload at all.
 *
 * Runtime: pi-preset/extensions/skills-store.ts (logic in src/skills-store/)
 * Command: /skills (menu; typed: list, use <name>, enable <name> [level],
 *          off <name>, install <source>, search <query>, find <what you need>)
 */

import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type MenuItem, type Notice, showMenu } from "../src/preset-menu.ts";
import { confirmLinesWithUi } from "../src/preset-ui.ts";
import { defaultStore, loadStore, missingCurated, type StoreSkill } from "../src/skills-store/catalog.ts";
import { publishSkillsFooter } from "../src/skills-store/footer-state.ts";
import { findImportable, importSkill } from "../src/skills-store/import.ts";
import {
	type Candidate,
	checkUpdate,
	chooseCandidates,
	createSkill,
	type Fetched,
	fetchSource,
	installCandidate,
	removeSkill,
} from "../src/skills-store/install.ts";
import { messages } from "../src/skills-store/messages.ts";
import { searchCurated, searchRegistry, searchStore } from "../src/skills-store/search.ts";
import {
	applyDefaults,
	enabledIn,
	type Level,
	LEVELS,
	levelOf,
	readSession,
	readState,
	setLevel,
	sweepSessions,
	writeSession,
	writeState,
} from "../src/skills-store/state.ts";
import { skillForModel, skillMessage } from "../src/skills-store/use.ts";

const TOOL_NAME = "skills";

const Params = Type.Object({
	action: StringEnum(["search", "list", "use", "enable", "install", "create"] as const),
	query: Type.Optional(Type.String({ description: "search: words to look for" })),
	name: Type.Optional(Type.String({ description: "use / enable / create: the skill name" })),
	level: Type.Optional(
		StringEnum(["session", "project", "always"] as const, {
			description: "enable: session (default, until pi exits), project (this directory), always",
		}),
	),
	source: Type.Optional(Type.String({ description: "install: owner/repo, owner/repo@skill, a GitHub URL, or a local path" })),
	content: Type.Optional(Type.String({ description: "create: the full SKILL.md text, frontmatter included" })),
	replace: Type.Optional(Type.Boolean({ description: "create: overwrite an existing SKILL.md of that name" })),
});

export default function skillsStore(pi: ExtensionAPI): void {
	const store = defaultStore();
	let state = readState();
	if (applyDefaults(state)) writeState(state);
	let session = readSession();
	/** Enabled through the tool since the last reload: in the state, not yet in pi's list. */
	let pending = new Set<string>();
	sweepSessions();

	const publish = () => publishSkillsFooter({ session: session.length, pending: pending.size });
	const persist = () => {
		writeState(state);
		writeSession(session);
		publish();
	};
	const skills = () => loadStore(store);
	const find = (name: string): StoreSkill | undefined => skills().find((skill) => skill.name === name);
	const level = (name: string, cwd: string) => levelOf(name, cwd, state, session);
	const enable = (name: string, cwd: string, to: Level | undefined) => {
		const target = { state, session };
		setLevel(target, name, cwd, to);
		state = target.state;
		session = target.session;
		persist();
	};
	publish();

	pi.on("resources_discover", (event) => {
		state = readState();
		if (applyDefaults(state)) writeState(state);
		session = readSession();
		pending = new Set();
		publish();
		const enabled = enabledIn(event.cwd, state, session);
		const paths = skills()
			.filter((skill) => enabled.has(skill.name))
			.map((skill) => skill.filePath);
		return paths.length > 0 ? { skillPaths: paths } : undefined;
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") writeSession([]);
	});

	// ── tool ────────────────────────────────────────────────────────────────

	const describe = (skill: StoreSkill, cwd: string) => {
		const at = level(skill.name, cwd);
		return `- ${skill.name} [${at ?? "off"}${skill.origin === "bundled" ? ", bundled" : ""}]: ${skill.description}`;
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Skills",
		description:
			"The skill store: skills kept on disk but loaded only when enabled. Actions: list (store + recommended), search (store, recommended, and the skills.sh registry), use (returns a skill's instructions for this task), enable (marks it enabled at a level — session by default — and returns its instructions; it is listed in the system prompt after the next /reload), install (fetches a skill from GitHub or a path into the store; asks the user first), create (writes a SKILL.md into the store after validating it). A skill's files are at the directory the result names.",
		promptSnippet: "skills: find, use, enable, install, or create skills from the on-demand store (use when a task might have a skill for it that is not listed)",
		promptGuidelines: [
			"When the user asks for a skill, says they do not know how to approach a domain task, or a listed-skill-free task smells like one someone has written a skill for (document formats, infrastructure tuning, writing style), call `skills` with action search before improvising; prefer store and recommended hits, then registry hits with many installs.",
			"A vague request is still searchable: derive 2-4 queries yourself from the task (domain, file types, tool names, in English), run them, and present at most 5 candidates with install counts and one recommendation; never ask the user to phrase the query.",
			"A skill from `skills use` or `skills enable` is in effect for the rest of the task: follow it, and resolve its relative paths against the directory the result names.",
			"Create a skill with `skills create` (not a prompt template, not a file under .pi/) when the user asks to save a reusable procedure; load the skill-authoring skill first if it is listed.",
		],
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], details: undefined, isError });
			const cwd = ctx.cwd;
			switch (params.action) {
				case "list": {
					const all = skills();
					const lines = [all.length > 0 ? "Store:" : "Store: (empty)", ...all.map((skill) => describe(skill, cwd))];
					const curated = missingCurated(all);
					if (curated.length > 0) {
						lines.push("", "Recommended, not installed (install with action install, source as given):");
						for (const entry of curated) lines.push(`- ${entry.name} (${entry.source}): ${entry.what}`);
					}
					return text(lines.join("\n"));
				}
				case "search": {
					const query = params.query?.trim();
					if (!query) return text("search needs a query", true);
					const all = skills();
					const lines: string[] = [];
					const local = searchStore(query, all);
					if (local.length > 0) lines.push("In the store (enable or use by name):", ...local.map((skill) => describe(skill, cwd)));
					const curated = searchCurated(query, new Set(all.map((skill) => skill.name)));
					if (curated.length > 0) {
						lines.push("", "Recommended (install by source):", ...curated.map((entry) => `- ${entry.name} (${entry.source}): ${entry.what}`));
					}
					const registry = await searchRegistry(query, 8, signal);
					if (registry.hits.length > 0) {
						lines.push("", "skills.sh registry (install by source; install counts are the only reputation signal, review SKILL.md after installing):");
						for (const hit of registry.hits) lines.push(`- ${hit.source}: ${hit.installs} installs — ${hit.url}`);
					} else lines.push("", registry.error ? `Registry unavailable: ${registry.error}` : "skills.sh registry: no matches.");
					return text(lines.length > 0 ? lines.join("\n") : "No matches in the store, the recommended list, or the registry.");
				}
				case "use":
				case "enable": {
					const name = params.name?.trim();
					if (!name) return text(`${params.action} needs a name`, true);
					const skill = find(name);
					if (!skill) return text(`No skill named "${name}" in the store. Use action list or search.`, true);
					if (params.action === "enable") {
						const to: Level = params.level ?? "session";
						const current = level(name, cwd);
						// Never demote: "always" asked as "session" stays always.
						const rank = (value: Level | undefined) => (value ? LEVELS.indexOf(value) : -1);
						if (rank(to) > rank(current)) {
							enable(name, cwd, to);
							pending.add(name);
							publish();
						}
						return text(`${skillForModel(skill)}\n\n(Enabled at level "${level(name, cwd)}"; pi lists it in the system prompt after the next /reload. It is in effect now.)`);
					}
					return text(skillForModel(skill));
				}
				case "install": {
					const source = params.source?.trim();
					if (!source) return text("install needs a source", true);
					if (!ctx.hasUI) return text("install needs an interactive session so the user can confirm it", true);
					let fetched: Fetched;
					try {
						fetched = await fetchSource(source);
					} catch (error) {
						return text((error as Error).message, true);
					}
					try {
						let candidates: Candidate[];
						try {
							candidates = chooseCandidates(fetched);
						} catch (error) {
							return text((error as Error).message, true);
						}
						if (candidates.length === 0) return text(`No SKILL.md found in ${source}`, true);
						if (candidates.length > 1 && !fetched.parsed.skill) {
							return text(
								`${source} holds ${candidates.length} skills; install one with source "${source}@<name>":\n${candidates.map((c) => `- ${c.name}: ${c.description}`).join("\n")}`,
							);
						}
						const m = messages();
						const installed: string[] = [];
						for (const candidate of candidates) {
							const replaced = Boolean(find(candidate.name)?.origin === "local");
							const ok = await ctx.ui.confirm(m.confirmInstall(candidate.name, source, replaced), `${candidate.description}\n\n${candidate.dir}`);
							if (!ok) return text(`The user declined installing ${candidate.name}.`, true);
							installed.push(installCandidate(fetched, candidate, store.localDir).skill.name);
						}
						return text(`Installed into the store: ${installed.join(", ")}. Enable or use it by name.`);
					} finally {
						fetched.cleanup();
					}
				}
				case "create": {
					const name = params.name?.trim();
					if (!name || !params.content) return text("create needs name and content (the SKILL.md text)", true);
					const existing = find(name);
					if (existing?.origin === "bundled") return text(`${name} is bundled with the preset; choose another name.`, true);
					try {
						const skill = createSkill(store.localDir, name, params.content, params.replace === true);
						return text(`Written: ${skill.filePath}. Put scripts, references, or assets under ${skill.dir}/ if the skill needs them. Enable it with action enable.`);
					} catch (error) {
						return text((error as Error).message, true);
					}
				}
			}
		},
	});

	// ── /skills menu ────────────────────────────────────────────────────────

	type Ctx = ExtensionCommandContext;
	/** A flow that must close the menu: the runtime was reloaded, or the agent was started. */
	type Close = "close";

	/** Reload so resources_discover re-runs; returns the notice instead when the agent is busy. */
	const reload = async (ctx: Ctx, notice: Notice): Promise<Notice | Close> => {
		if (!ctx.isIdle()) return notice;
		ctx.ui.notify(notice.text, "info");
		await ctx.reload();
		return "close";
	};

	const statusLines = (cwd: string): string[] => {
		const m = messages();
		const all = skills();
		const enabled = enabledIn(cwd, state, session);
		const count = (at: Level) => [...enabled.values()].filter((value) => value === at).length;
		const lines = [
			m.storeStats(all.filter((s) => s.origin === "bundled").length, all.filter((s) => s.origin === "local").length),
			m.enabledHere(count("session"), count("project"), count("always")),
		];
		if (pending.size > 0) lines.push(m.pendingReload);
		return lines;
	};

	/** Enabled skills first (session, project, always: the ones you toggle on top), then the rest; by name within a group. */
	const ordered = (cwd: string): StoreSkill[] => {
		const rank = (skill: StoreSkill) => {
			const at = level(skill.name, cwd);
			return at ? LEVELS.indexOf(at) : LEVELS.length;
		};
		return skills().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	};

	const mainItems = (cwd: string): MenuItem[] => {
		const m = messages();
		const all = skills();
		const items: MenuItem[] = ordered(cwd).map((skill) => ({
			value: `skill:${skill.name}`,
			label: skill.name,
			hint: m.levelName(level(skill.name, cwd)),
			description: `${skill.description}\n(${m.originName(skill.origin)})`,
		}));
		items.push({ value: "find", label: m.findLabel, description: m.findHelp });
		items.push({ value: "install", label: m.installLabel, description: m.installHelp });
		if (missingCurated(all).length > 0) items.push({ value: "curated", label: m.curatedLabel, description: m.curatedHelp });
		items.push({ value: "search", label: m.searchLabel, description: m.searchHelp });
		if (all.some((skill) => skill.install?.repo)) items.push({ value: "updates", label: m.updatesLabel, description: m.updatesHelp });
		const importable = findImportable(new Set(all.map((skill) => skill.name)));
		if (importable.length > 0) items.push({ value: "import", label: m.importLabel(importable.length), description: m.importHelp });
		return items;
	};

	/** Install every chosen candidate after a confirmation each; returns the notice. */
	const installFrom = async (ctx: Ctx, source: string): Promise<Notice | undefined> => {
		const m = messages();
		ctx.ui.notify(m.fetching(source), "info");
		let fetched: Fetched;
		try {
			fetched = await fetchSource(source);
		} catch (error) {
			return { text: (error as Error).message, type: "error" };
		}
		try {
			let candidates = chooseCandidates(fetched);
			if (candidates.length === 0) return { text: `No SKILL.md in ${source}`, type: "warning" };
			if (candidates.length > 1) {
				const picked = await showMenu(ctx, () => ({
					title: m.pickSkill,
					status: [m.pickSkillHelp(source)],
					items: [
						{ value: "*", label: m.installAll(candidates.length), description: candidates.map((c) => c.name).join(", ") },
						...candidates.map((c) => ({ value: c.name, label: c.name, description: c.description })),
					],
					cancelLabel: m.backToList,
				}));
				if (!picked) return undefined;
				if (picked !== "*") candidates = candidates.filter((c) => c.name === picked);
			}
			const names: string[] = [];
			for (const candidate of candidates) {
				const replaced = find(candidate.name)?.origin === "local";
				if (!(await ctx.ui.confirm(m.confirmInstall(candidate.name, source, replaced), candidate.description))) continue;
				names.push(installCandidate(fetched, candidate, store.localDir).skill.name);
			}
			return names.length > 0 ? { text: m.installed(names.join(", ")), type: "success" } : { text: m.cancelled, type: "info" };
		} catch (error) {
			return { text: (error as Error).message, type: "error" };
		} finally {
			fetched.cleanup();
		}
	};

	const curatedMenu = async (ctx: Ctx): Promise<Notice | undefined> => {
		const m = messages();
		const entries = missingCurated(skills());
		const picked = await showMenu(ctx, () => ({
			title: m.curatedLabel.replace(/…$/u, ""),
			items: entries.map((entry) => ({
				value: entry.source,
				label: entry.name,
				hint: entry.source,
				description: m.curatedWhat(entry.name, entry.what),
			})),
			cancelLabel: m.backToList,
		}));
		return picked ? installFrom(ctx, picked) : undefined;
	};

	const searchMenu = async (ctx: Ctx): Promise<Notice | undefined> => {
		const m = messages();
		const query = (await ctx.ui.input(m.searchPrompt))?.trim();
		if (!query) return undefined;
		ctx.ui.notify(m.searching(query), "info");
		const result = await searchRegistry(query, 12);
		if (result.hits.length === 0) return { text: result.error ?? m.noResults, type: result.error ? "error" : "info" };
		const picked = await showMenu(ctx, () => ({
			title: `skills.sh: ${query}`,
			items: result.hits.map((hit) => ({ value: hit.source, label: hit.source, hint: m.installs(hit.installs), description: hit.url })),
			cancelLabel: m.backToList,
		}));
		return picked ? installFrom(ctx, picked) : undefined;
	};

	const checkAll = async (ctx: Ctx): Promise<Notice> => {
		const m = messages();
		const targets = skills().filter((skill) => skill.install?.repo);
		if (targets.length === 0) return { text: m.nothingToCheck, type: "info" };
		ctx.ui.notify(m.updatesLabel, "info");
		const results = await Promise.all(targets.map((skill) => checkUpdate(skill)));
		const outdated = results.filter((r) => r.outdated).map((r) => r.name);
		const errors = results.filter((r) => r.error).map((r) => r.name);
		return { text: m.updatesSummary(outdated, results.length - errors.length, errors), type: outdated.length > 0 ? "warning" : "success" };
	};

	const importMenu = async (ctx: Ctx, candidates = findImportable(new Set(skills().map((s) => s.name)))): Promise<Notice | Close | undefined> => {
		const m = messages();
		if (candidates.length === 0) return undefined;
		const names = candidates.map((c) => (c.conflict ? `${c.name} (replaces the store copy)` : c.name)).join(", ");
		if (!(await ctx.ui.confirm(m.importLabel(candidates.length).replace(/…$/u, ""), m.confirmImport(names, "~/.pi/agent/pi-preset/skills-import-backup/")))) {
			return undefined;
		}
		const moved: string[] = [];
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		for (const candidate of candidates) {
			try {
				moved.push(importSkill(candidate, store.localDir, stamp).skill.name);
			} catch (error) {
				ctx.ui.notify(`${candidate.name}: ${(error as Error).message}`, "error");
			}
		}
		if (moved.length === 0) return { text: m.cancelled, type: "info" };
		// They were loaded before the move; a reload drops them from pi's list.
		return reload(ctx, { text: m.imported(moved.join(", ")), type: "success" });
	};

	/** The one-time offer when pi's own skill directories hold something. */
	const offerImport = async (ctx: Ctx): Promise<Close | undefined> => {
		if (state.importOffered) return undefined;
		const candidates = findImportable(new Set(skills().map((s) => s.name)));
		state.importOffered = true;
		persist();
		if (candidates.length === 0) return undefined;
		const m = messages();
		const names = candidates.map((c) => `${c.name} (${c.root})`).join("\n");
		if (!(await ctx.ui.confirm(m.importOfferTitle, m.importOfferText(names)))) return undefined;
		const result = await importMenu(ctx, candidates);
		return result === "close" ? "close" : undefined;
	};

	const skillMenu = async (ctx: Ctx, name: string): Promise<Notice | Close | undefined> => {
		const m = messages();
		let notice: Notice | undefined;
		for (;;) {
			const skill = find(name);
			if (!skill) return { text: m.notFound(name), type: "warning" };
			const at = level(name, ctx.cwd);
			const status = [skill.description, m.originName(skill.origin)];
			if (skill.install) status.push(m.installedFrom(skill.install.source, skill.install.commit));
			if (skill.shadows) status.push(m.shadows);
			const items: MenuItem[] = [{ value: "use", label: m.useLabel, description: m.useHelp }];
			for (const target of LEVELS) {
				if (target !== at) items.push({ value: `enable:${target}`, label: m.enableLabel(target), description: m.enableHelp(target) });
			}
			if (at) items.push({ value: "off", label: m.offLabel, description: m.offHelp });
			items.push({ value: "show", label: m.showLabel, description: m.showHelp });
			if (skill.install?.repo) {
				items.push({ value: "check", label: m.checkLabel, description: m.checkHelp });
				items.push({ value: "update", label: m.updateLabel, description: m.updateHelp });
			}
			if (skill.origin === "local") items.push({ value: "remove", label: m.removeLabel, description: m.removeHelp });
			const choice = await showMenu(ctx, () => ({
				title: `${name} · ${m.levelName(at)}`,
				status,
				notice,
				items,
				cancelLabel: m.backToList,
			}));
			if (!choice) return notice;
			notice = undefined;
			if (choice === "use") {
				pi.sendUserMessage(skillMessage(skill));
				return "close"; // the agent starts working
			}
			if (choice.startsWith("enable:")) {
				const target = choice.slice("enable:".length) as Level;
				enable(name, ctx.cwd, target);
				pending.delete(name);
				const result = await reload(ctx, { text: m.enabled(name, target), type: "success" });
				return result === "close" ? "close" : { text: m.enabledNoReload(name, target), type: "warning" };
			}
			if (choice === "off") {
				enable(name, ctx.cwd, undefined);
				pending.delete(name);
				const result = await reload(ctx, { text: m.disabled(name), type: "success" });
				return result === "close" ? "close" : { text: m.disabled(name), type: "warning" };
			}
			if (choice === "show") {
				await confirmLinesWithUi(ctx, skill.filePath, readFileSync(skill.filePath, "utf8").split("\n"));
			} else if (choice === "check") {
				const result = await checkUpdate(skill);
				notice = result.error
					? { text: `${name}: ${result.error}`, type: "error" }
					: result.outdated
						? { text: m.updateAvailable(name), type: "warning" }
						: { text: m.upToDate(name), type: "success" };
			} else if (choice === "update") {
				notice = await installFrom(ctx, skill.install!.source);
			} else if (choice === "remove") {
				if (await ctx.ui.confirm(m.confirmRemove(name), skill.dir)) {
					const wasOn = at !== undefined;
					removeSkill(skill);
					enable(name, ctx.cwd, undefined);
					if (wasOn) {
						const result = await reload(ctx, { text: m.removed(name), type: "success" });
						return result === "close" ? "close" : { text: m.removed(name), type: "success" };
					}
					return { text: m.removed(name), type: "success" };
				}
			}
		}
	};

	/** Hand a vague need to the agent: it derives the queries, searches, and recommends. */
	const findWithAgent = (need: string): void => {
		pi.sendUserMessage(
			[
				`I am looking for a skill for this, but may not have named it well: "${need.trim()}"`,
				"",
				"1. Work out what the task really is (domain, file types, tools, language) and derive 2-4 search queries in English.",
				"2. Run the `skills` tool with action search for each query, and action list once, so store and recommended skills are considered first.",
				"3. Present at most 5 candidates: name or source, install count, one line on how well it fits; mark one as your recommendation and say why. Be honest when nothing fits well, and then offer to write one (load skill-authoring).",
				"4. Ask me which to install or enable. Do not install anything before I answer.",
			].join("\n"),
		);
	};

	const runMenu = async (ctx: Ctx) => {
		if ((await offerImport(ctx)) === "close") return;
		let notice: Notice | undefined;
		let selected: string | undefined;
		for (;;) {
			const choice = await showMenu(ctx, () => ({
				title: messages().title,
				status: statusLines(ctx.cwd),
				notice,
				items: mainItems(ctx.cwd),
				selected,
				filterable: true,
			}));
			if (!choice) return;
			selected = choice;
			notice = undefined;
			try {
				let result: Notice | Close | undefined;
				if (choice.startsWith("skill:")) result = await skillMenu(ctx, choice.slice("skill:".length));
				else if (choice === "find") {
					const need = (await ctx.ui.input(messages().findPrompt))?.trim();
					if (need) {
						findWithAgent(need);
						return;
					}
				} else if (choice === "install") {
					const source = (await ctx.ui.input(messages().installPrompt))?.trim();
					result = source ? await installFrom(ctx, source) : undefined;
				} else if (choice === "curated") result = await curatedMenu(ctx);
				else if (choice === "search") result = await searchMenu(ctx);
				else if (choice === "updates") result = await checkAll(ctx);
				else if (choice === "import") result = await importMenu(ctx);
				if (result === "close") return;
				notice = result;
			} catch (error) {
				notice = { text: (error as Error).message, type: "error" };
			}
		}
	};

	// ── typed subcommands ───────────────────────────────────────────────────

	const listText = (cwd: string): string => {
		const m = messages();
		const all = skills();
		if (all.length === 0) return m.noSkills;
		return [m.listHeader, ...all.map((skill) => `${m.levelName(level(skill.name, cwd)).padEnd(8)} ${skill.name}  ${skill.description}`)].join("\n");
	};

	const typed = async (sub: string, rest: string[], ctx: Ctx): Promise<void> => {
		const m = messages();
		const name = rest[0] ?? "";
		switch (sub) {
			case "list":
				ctx.ui.notify(listText(ctx.cwd), "info");
				return;
			case "use": {
				const skill = find(name);
				if (!skill) return ctx.ui.notify(m.notFound(name), "warning");
				pi.sendUserMessage(skillMessage(skill, rest.slice(1).join(" ")));
				return;
			}
			case "enable":
			case "off": {
				if (!find(name)) return ctx.ui.notify(m.notFound(name), "warning");
				const target = sub === "off" ? undefined : ((rest[1] as Level | undefined) ?? "session");
				if (target && !LEVELS.includes(target)) return ctx.ui.notify(m.unknownSubcommand(target), "warning");
				enable(name, ctx.cwd, target);
				pending.delete(name);
				const notice = target ? { text: m.enabled(name, target), type: "success" as const } : { text: m.disabled(name), type: "success" as const };
				if ((await reload(ctx, notice)) !== "close") ctx.ui.notify(m.needsIdle, "warning");
				return;
			}
			case "install": {
				if (!name) return ctx.ui.notify(m.installPrompt, "warning");
				const notice = await installFrom(ctx, name);
				if (notice) ctx.ui.notify(notice.text, notice.type === "error" ? "error" : "info");
				return;
			}
			case "find": {
				const need = rest.join(" ").trim();
				if (!need) return ctx.ui.notify(m.findPrompt, "warning");
				findWithAgent(need);
				return;
			}
			case "search": {
				const query = rest.join(" ").trim();
				if (!query) return ctx.ui.notify(m.searchPrompt, "warning");
				const result = await searchRegistry(query, 12);
				if (result.hits.length === 0) return ctx.ui.notify(result.error ?? m.noResults, result.error ? "error" : "info");
				ctx.ui.notify(result.hits.map((hit) => `${hit.source}  ${m.installs(hit.installs)}`).join("\n"), "info");
				return;
			}
			default:
				ctx.ui.notify(m.unknownSubcommand(sub), "warning");
		}
	};

	const SUBCOMMANDS = ["list", "use", "enable", "off", "install", "search", "find"];

	pi.registerCommand("skills", {
		description: "Skill store: enable on demand (session / project / always), use now, install, search, find <what you need> (the agent searches and recommends)",
		getArgumentCompletions: (prefix) => {
			const [first, second] = prefix.trimStart().split(/\s+/u);
			if (second !== undefined && (first === "use" || first === "enable" || first === "off")) {
				const names = skills()
					.map((skill) => skill.name)
					.filter((name) => name.startsWith(second));
				return names.length > 0 ? names.map((name) => ({ value: `${first} ${name}`, label: name })) : null;
			}
			const matches = SUBCOMMANDS.filter((sub) => sub.startsWith(first ?? ""));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
			if (sub) {
				await typed(sub, rest, ctx);
				return;
			}
			if (ctx.hasUI) await runMenu(ctx);
			else ctx.ui.notify(listText(ctx.cwd), "info");
		},
	});
}
