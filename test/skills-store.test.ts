// The skill store: catalog scanning and validation, enable levels, install
// from a local path, update records, search parsing, and the extension's
// resources_discover / tool behavior against a throwaway agent dir.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import skillsStore from "../extensions/skills-store.ts";
import {
	CURATED,
	loadStore,
	missingCurated,
	parseSkillFrontmatter,
	scanStoreDir,
	SOURCE_FILE,
	validateSkill,
} from "../src/skills-store/catalog.ts";
import { skillsFooterText } from "../src/skills-store/footer-state.ts";
import { findImportable, importSkill } from "../src/skills-store/import.ts";
import {
	chooseCandidates,
	createSkill,
	fetchSource,
	findSkillDirs,
	installCandidate,
	parseSource,
	removeSkill,
} from "../src/skills-store/install.ts";
import { matchScore, parseCliOutput, parseRegistryResponse, queryWords, searchStore } from "../src/skills-store/search.ts";
import {
	applyDefaults,
	DEFAULT_ALWAYS,
	enabledIn,
	levelOf,
	readSession,
	readState,
	sessionPath,
	setLevel,
	statePath,
	sweepSessions,
	writeSession,
	writeState,
} from "../src/skills-store/state.ts";
import { skillMessage } from "../src/skills-store/use.ts";
import { fakeCtx, fakePi, makeTree, writeTree } from "./trellis-lite-fixtures.ts";

const SKILL = (name: string, description = `Does ${name}. Use when asked for ${name}.`) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`;

function withAgentDir<T>(run: (dir: string) => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tree = makeTree();
	process.env.PI_CODING_AGENT_DIR = tree.root;
	try {
		return run(tree.root);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		tree.cleanup();
	}
}

async function withAgentDirAsync<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tree = makeTree();
	process.env.PI_CODING_AGENT_DIR = tree.root;
	try {
		return await run(tree.root);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		tree.cleanup();
	}
}

// ── catalog ──────────────────────────────────────────────────────────────

test("frontmatter: plain, quoted, and block scalars", () => {
	const plain = parseSkillFrontmatter(SKILL("a-b"));
	assert.equal(plain?.name, "a-b");
	assert.match(plain?.body ?? "", /Do the thing/);
	const quoted = parseSkillFrontmatter('---\nname: "x"\ndescription: \'y: z\'\n---\nbody');
	assert.deepEqual([quoted?.name, quoted?.description], ["x", "y: z"]);
	const block = parseSkillFrontmatter("---\nname: x\ndescription: >\n  first line\n  second line\n---\nbody");
	assert.equal(block?.description, "first line second line");
	assert.equal(parseSkillFrontmatter("# no frontmatter"), undefined);
	assert.equal(parseSkillFrontmatter("---\nname: x\n"), undefined, "unclosed");
});

test("validateSkill reports each rule", () => {
	assert.equal(validateSkill(SKILL("ok"), "ok"), undefined);
	assert.match(validateSkill("# nope", "x") ?? "", /frontmatter/);
	assert.match(validateSkill("---\ndescription: d\n---\nbody") ?? "", /no `name`/);
	assert.match(validateSkill("---\nname: Bad_Name\ndescription: d\n---\nbody") ?? "", /not lowercase/);
	assert.match(validateSkill(SKILL("a"), "b") ?? "", /differs from the directory/);
	assert.match(validateSkill("---\nname: a\n---\nbody") ?? "", /no `description`/);
	assert.match(validateSkill(`---\nname: a\ndescription: ${"x".repeat(1025)}\n---\nbody`) ?? "", /1024/);
	assert.match(validateSkill("---\nname: a\ndescription: d\n---\n\n") ?? "", /no instructions/);
});

test("loadStore merges bundled and local by name, local shadows", () => {
	const tree = makeTree({
		"bundled/one/SKILL.md": SKILL("one"),
		"bundled/two/SKILL.md": SKILL("two"),
		"bundled/.hidden/SKILL.md": SKILL("hidden"),
		"bundled/broken/SKILL.md": "no frontmatter",
		"local/two/SKILL.md": SKILL("two", "Local two."),
		"local/two/.pi-preset-source.json": JSON.stringify({ source: "o/r@two", path: "two", commit: "abc", installedAt: "t" }),
		"local/three/SKILL.md": SKILL("three"),
	});
	try {
		const skills = loadStore({ bundledDir: join(tree.root, "bundled"), localDir: join(tree.root, "local") });
		assert.deepEqual(
			skills.map((s) => [s.name, s.origin, s.shadows ?? false]),
			[
				["one", "bundled", false],
				["three", "local", false],
				["two", "local", true],
			],
		);
		assert.equal(skills.find((s) => s.name === "two")?.description, "Local two.");
		assert.equal(skills.find((s) => s.name === "two")?.install?.commit, "abc");
		assert.equal(scanStoreDir(join(tree.root, "none"), "local").length, 0);
		assert.deepEqual(
			missingCurated(skills).map((c) => c.name),
			CURATED.map((c) => c.name),
		);
	} finally {
		tree.cleanup();
	}
});

test("the bundled store validates", () => {
	const skills = scanStoreDir(join(import.meta.dirname, "..", "skills-store"), "bundled");
	const names = skills.map((s) => s.name);
	for (const expected of DEFAULT_ALWAYS) {
		assert.ok(names.includes(expected), `${expected} is bundled`);
	}
	for (const skill of skills) {
		assert.equal(validateSkill(readFileSync(skill.filePath, "utf8"), skill.name), undefined, skill.name);
	}
	const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.ok(
		!manifest.pi.skills.some((entry: string) => entry.includes("skills-store")),
		"the store is not in pi.skills: pi must not load it on its own",
	);
});

// ── state ────────────────────────────────────────────────────────────────

test("state: defaults, levels, one level at a time, persistence", () => {
	withAgentDir(() => {
		const state = readState();
		assert.deepEqual(state.always, [...DEFAULT_ALWAYS]);
		const target = { state, session: [] as string[] };
		setLevel(target, "a", "/p", "session");
		setLevel(target, "b", "/p", "project");
		setLevel(target, "c", "/p", "always");
		assert.equal(levelOf("a", "/p", target.state, target.session), "session");
		assert.equal(levelOf("b", "/p", target.state, target.session), "project");
		assert.equal(levelOf("b", "/other", target.state, target.session), undefined);
		assert.equal(levelOf("c", "/other", target.state, target.session), "always");
		setLevel(target, "a", "/p", "always");
		assert.deepEqual(target.session, [], "promoting clears the session level");
		setLevel(target, "b", "/p", undefined);
		assert.equal(target.state.projects["/p"], undefined, "empty project lists are dropped");
		writeState(target.state);
		writeSession(target.session);
		const again = readState();
		assert.deepEqual(again.always.sort(), ["a", "c", ...DEFAULT_ALWAYS].sort());
		assert.equal(again.importOffered, false);
		assert.ok(!existsSync(sessionPath()), "an empty session list removes the file");
		writeSession(["x"]);
		assert.deepEqual(readSession(), ["x"]);
		const enabled = enabledIn("/p", again, ["x"]);
		assert.equal(enabled.get("x"), "session");
		assert.equal(enabled.get("a"), "always");
		writeFileSync(statePath(), "{garbage");
		assert.deepEqual(readState().always, [], "a corrupt file enables nothing");
	});
});

test("defaults added later are applied once to an existing state file", () => {
	withAgentDir(() => {
		// A file from the first version: skill-authoring only, no defaultsApplied.
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(statePath(), JSON.stringify({ always: ["skill-authoring"], projects: {} }));
		const state = readState();
		assert.deepEqual(state.defaultsApplied, ["skill-authoring"]);
		assert.equal(applyDefaults(state), true);
		assert.deepEqual(state.always.sort(), [...DEFAULT_ALWAYS].sort());
		writeState(state);
		// Turned off by the user: stays off.
		const again = readState();
		again.always = again.always.filter((name) => name !== "git-conventions");
		assert.equal(applyDefaults(again), false);
		assert.ok(!again.always.includes("git-conventions"));
		// A fresh file has everything applied already.
		rmSync(statePath());
		assert.equal(applyDefaults(readState()), false);
	});
});

test("sweepSessions removes files of dead processes only", () => {
	withAgentDir((dir) => {
		writeSession(["mine"]);
		writeSession(["dead"], sessionPath(999_999));
		writeSession(["alive"], sessionPath(1));
		sweepSessions(join(dir, "pi-preset"), (pid) => pid === 1);
		assert.ok(existsSync(sessionPath()));
		assert.ok(existsSync(sessionPath(1)));
		assert.ok(!existsSync(sessionPath(999_999)));
	});
});

// ── install ──────────────────────────────────────────────────────────────

test("parseSource reads every form", () => {
	assert.deepEqual(parseSource("owner/repo"), { source: "owner/repo", repo: "https://github.com/owner/repo.git", path: "", skill: undefined });
	assert.equal(parseSource("owner/repo@my-skill").skill, "my-skill");
	const url = parseSource("https://github.com/anthropics/skills/tree/main/skills/docx");
	assert.deepEqual([url.repo, url.ref, url.path], ["https://github.com/anthropics/skills.git", "main", "skills/docx"]);
	assert.equal(parseSource("https://github.com/o/r.git").repo, "https://github.com/o/r.git");
	assert.equal(parseSource("git@github.com:o/r.git").repo, "git@github.com:o/r.git");
	assert.throws(() => parseSource("not a source!"), /cannot read/);
	assert.throws(() => parseSource("/definitely/missing/dir"), /does not exist/);
});

test("install from a local tree: candidates, @name, record, replace, remove", async () => {
	const tree = makeTree({
		"repo/skills/alpha/SKILL.md": SKILL("alpha"),
		"repo/skills/alpha/scripts/run.sh": "#!/bin/sh\n",
		"repo/skills/beta/SKILL.md": SKILL("beta"),
		"repo/node_modules/junk/SKILL.md": SKILL("junk"),
		"repo/.git/HEAD": "ref: refs/heads/main\n",
		"local/": "",
	});
	try {
		const local = join(tree.root, "local");
		assert.deepEqual(
			findSkillDirs(join(tree.root, "repo")).map((d) => d.slice(tree.root.length + 1)),
			["repo/skills/alpha", "repo/skills/beta"],
		);
		const all = await fetchSource(join(tree.root, "repo"));
		assert.deepEqual(chooseCandidates(all).map((c) => c.name), ["alpha", "beta"]);
		assert.equal(all.commit, undefined);
		const one = { ...all, parsed: { ...all.parsed, skill: "alpha" } };
		const [alpha] = chooseCandidates(one);
		const result = installCandidate(one, alpha!, local);
		assert.equal(result.replaced, false);
		assert.equal(result.skill.name, "alpha");
		assert.ok(existsSync(join(local, "alpha", "scripts", "run.sh")));
		const record = JSON.parse(readFileSync(join(local, "alpha", SOURCE_FILE), "utf8"));
		assert.equal(record.path, "skills/alpha");
		assert.equal(installCandidate(one, alpha!, local).replaced, true);
		assert.throws(() => chooseCandidates({ ...all, parsed: { ...all.parsed, skill: "gamma" } }), /no skill named "gamma"/);
		const skills = loadStore({ bundledDir: join(tree.root, "none"), localDir: local });
		removeSkill(skills[0]!);
		assert.ok(!existsSync(join(local, "alpha")));
		assert.throws(() => removeSkill({ ...skills[0]!, origin: "bundled" }), /bundled/);
	} finally {
		tree.cleanup();
	}
});

test("createSkill validates and refuses to overwrite unless asked", () => {
	const tree = makeTree({ "local/": "" });
	try {
		const local = join(tree.root, "local");
		assert.throws(() => createSkill(local, "x", "no frontmatter"), /frontmatter/);
		assert.throws(() => createSkill(local, "x", SKILL("y")), /differs/);
		const skill = createSkill(local, "x", SKILL("x"));
		assert.equal(skill.origin, "local");
		assert.throws(() => createSkill(local, "x", SKILL("x")), /already exists/);
		createSkill(local, "x", SKILL("x", "Second."), true);
		assert.equal(loadStore({ bundledDir: "/none", localDir: local })[0]?.description, "Second.");
	} finally {
		tree.cleanup();
	}
});

test("import moves a skill from pi's directories into the store with a backup", () => {
	withAgentDir((dir) => {
		writeTree(dir, { "skills/officecli/SKILL.md": SKILL("officecli"), "skills/officecli/ref.md": "r" });
		const roots = [join(dir, "skills")];
		const found = findImportable(new Set(["other"]), roots);
		assert.deepEqual(found.map((c) => [c.name, c.conflict]), [["officecli", false]]);
		const local = join(dir, "pi-preset", "skills");
		const outcome = importSkill(found[0]!, local, "stamp");
		assert.equal(outcome.skill.dir, join(local, "officecli"));
		assert.ok(existsSync(join(local, "officecli", "ref.md")));
		assert.ok(!existsSync(join(dir, "skills", "officecli")), "original moved away");
		assert.ok(existsSync(join(outcome.backup, "SKILL.md")), "backup holds the original");
		assert.deepEqual(findImportable(new Set(), roots), []);
	});
});

// ── search ───────────────────────────────────────────────────────────────

test("search: words, scores, registry and CLI parsing", () => {
	assert.deepEqual(queryWords("TCP tuning, 调优 a"), ["tcp", "tuning", "调优"]);
	assert.equal(matchScore(["tcp"], "vps-tcp-tune", "x"), 3);
	assert.equal(matchScore(["tune"], "x", "tune it"), 1);
	const tree = makeTree({ "vps-tcp-tune/SKILL.md": SKILL("vps-tcp-tune", "Tune TCP. Use for retransmits."), "other/SKILL.md": SKILL("other") });
	try {
		const skills = loadStore({ bundledDir: tree.root, localDir: "/none" });
		assert.equal(searchStore("tcp retransmits", skills)[0]?.name, "vps-tcp-tune");
		assert.equal(searchStore("nothing-matches-this", skills).length, 0);
	} finally {
		tree.cleanup();
	}
	const hits = parseRegistryResponse({ skills: [{ source: "o/r", skillId: "s", name: "s", installs: 5 }, { bogus: true }] }, 8);
	assert.deepEqual(hits, [{ source: "o/r@s", name: "s", installs: 5, url: "https://skills.sh/o/r/s" }]);
	const cli = parseCliOutput("\u001b[38;5;145mjtsang4/network-tune@network-tune\u001b[0m \u001b[36m8 installs\u001b[0m\n└ https://x\nnoise\n", 8);
	assert.deepEqual(cli.map((h) => [h.source, h.installs]), [["jtsang4/network-tune@network-tune", 8]]);
});

// ── use / footer ─────────────────────────────────────────────────────────

test("skillMessage is the /skill:name shape", () => {
	const tree = makeTree({ "s/SKILL.md": SKILL("s") });
	try {
		const [skill] = scanStoreDir(tree.root, "local");
		const text = skillMessage(skill!, "do it");
		assert.ok(text.startsWith(`<skill name="s" location="${skill!.filePath}">\n---`));
		assert.ok(text.endsWith("</skill>\n\ndo it"));
	} finally {
		tree.cleanup();
	}
	assert.equal(skillsFooterText(undefined), undefined);
	assert.equal(skillsFooterText({ session: 0, pending: 0 }), undefined);
	assert.equal(skillsFooterText({ session: 2, pending: 0 }), "2");
	assert.equal(skillsFooterText({ session: 2, pending: 1 }), "2*");
});

// ── extension ────────────────────────────────────────────────────────────

test("extension: resources_discover reports enabled skills; the tool enables, uses, and creates", async () => {
	await withAgentDirAsync(async (dir) => {
		const local = join(dir, "pi-preset", "skills");
		writeTree(dir, { "pi-preset/skills/alpha/SKILL.md": SKILL("alpha"), "pi-preset/skills/beta/SKILL.md": SKILL("beta") });
		writeState({ always: ["alpha"], projects: {}, defaultsApplied: [...DEFAULT_ALWAYS] });
		const pi = fakePi();
		const tools: any[] = [];
		pi.api.registerTool = (tool: any) => tools.push(tool);
		skillsStore(pi.api);
		assert.ok(pi.commands.has("skills"));
		const tool = tools.find((t) => t.name === "skills");
		assert.ok(tool);

		const discovered = await pi.emit("resources_discover", { type: "resources_discover", cwd: "/p", reason: "startup" });
		assert.deepEqual(discovered.skillPaths, [join(local, "alpha", "SKILL.md")]);

		const ctx = fakeCtx("/p");
		const list = await tool.execute("1", { action: "list" }, undefined, undefined, ctx);
		assert.match(list.content[0].text, /- alpha \[always\]/);
		assert.match(list.content[0].text, /- beta \[off\]/);
		assert.match(list.content[0].text, /humanizer-zh \(op7418\/Humanizer-zh\)/);

		const enabled = await tool.execute("2", { action: "enable", name: "beta" }, undefined, undefined, ctx);
		assert.match(enabled.content[0].text, /Skill "beta" \(files in .*beta; resolve/);
		assert.match(enabled.content[0].text, /Enabled at level "session"/);
		assert.deepEqual(readSession(), ["beta"]);
		const again = await pi.emit("resources_discover", { type: "resources_discover", cwd: "/p", reason: "reload" });
		assert.deepEqual(again.skillPaths.map((p: string) => p.split("/").at(-2)), ["alpha", "beta"]);

		// enable never demotes
		await tool.execute("3", { action: "enable", name: "alpha", level: "session" }, undefined, undefined, ctx);
		assert.deepEqual(readState().always, ["alpha"]);

		const missing = await tool.execute("4", { action: "use", name: "nope" }, undefined, undefined, ctx);
		assert.equal(missing.isError, true);

		const created = await tool.execute("5", { action: "create", name: "gamma", content: SKILL("gamma") }, undefined, undefined, ctx);
		assert.equal(created.isError, false);
		assert.ok(existsSync(join(local, "gamma", "SKILL.md")));
		const bad = await tool.execute("6", { action: "create", name: "gamma", content: SKILL("gamma") }, undefined, undefined, ctx);
		assert.match(bad.content[0].text, /already exists/);

		// install from a local path asks, then copies
		const repo = join(dir, "repo");
		writeTree(repo, { "delta/SKILL.md": SKILL("delta") });
		const asked: string[] = [];
		const askCtx = fakeCtx("/p", { ui: { ...ctx.ui, confirm: async (title: string) => (asked.push(title), true) } });
		const installed = await tool.execute("7", { action: "install", source: repo }, undefined, undefined, askCtx);
		assert.equal(installed.isError, false, installed.content[0].text);
		assert.equal(asked.length, 1);
		assert.ok(existsSync(join(local, "delta", SOURCE_FILE)));
		const declined = await tool.execute("8", { action: "install", source: repo }, undefined, undefined, fakeCtx("/p", { ui: { ...ctx.ui, confirm: async () => false } }));
		assert.equal(declined.isError, true);

		// session file goes away on quit
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.ok(existsSync(sessionPath()));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.ok(!existsSync(sessionPath()));
	});
});

test("extension: typed subcommands list and use", async () => {
	await withAgentDirAsync(async (dir) => {
		writeTree(dir, { "pi-preset/skills/alpha/SKILL.md": SKILL("alpha") });
		const pi = fakePi();
		pi.api.registerTool = () => {};
		skillsStore(pi.api);
		const ctx = fakeCtx("/p", { isIdle: () => true, reload: async () => {} });
		await pi.commands.get("skills")!.handler("list", ctx);
		assert.match(ctx.notes.at(-1)!.text, /alpha/);
		await pi.commands.get("skills")!.handler("use alpha please", ctx);
		assert.match(pi.sent[0] ?? "", /^<skill name="alpha"/);
		assert.match(pi.sent[0] ?? "", /\n\nplease$/);
		await pi.commands.get("skills")!.handler("use nope", ctx);
		assert.equal(ctx.notes.at(-1)!.level, "warning");
	});
});

test("menu filter matches label, hint, and value; empty query keeps all", async () => {
	const { filterItems } = await import("../src/preset-menu.ts");
	const items = [
		{ value: "skill:vps-tcp-tune", label: "vps-tcp-tune", hint: "session" },
		{ value: "skill:selfhost-ops", label: "selfhost-ops", hint: "off" },
		{ value: "install", label: "Install from GitHub…" },
	];
	assert.equal(filterItems(items, "").length, 3);
	assert.deepEqual(filterItems(items, "TCP").map((i) => i.value), ["skill:vps-tcp-tune"]);
	assert.deepEqual(filterItems(items, "session").map((i) => i.value), ["skill:vps-tcp-tune"]);
	assert.deepEqual(filterItems(items, "github").map((i) => i.value), ["install"]);
	assert.equal(filterItems(items, "zzz").length, 0);
});

test("extension: /skills find hands the need to the agent", async () => {
	await withAgentDirAsync(async () => {
		const pi = fakePi();
		pi.api.registerTool = () => {};
		skillsStore(pi.api);
		const ctx = fakeCtx("/p");
		await pi.commands.get("skills")!.handler("find 把 word 文档里的表格转成 excel", ctx);
		assert.match(pi.sent[0] ?? "", /把 word 文档里的表格转成 excel/);
		assert.match(pi.sent[0] ?? "", /action search/);
		await pi.commands.get("skills")!.handler("find", ctx);
		assert.equal(ctx.notes.at(-1)!.level, "warning");
	});
});
