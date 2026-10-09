import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import trellisLite from "../extensions/trellis-lite.ts";
import { parseFrontmatter } from "../src/trellis-lite/frontmatter.ts";
import { compareSpecificity, compileGlob, globError, specificity } from "../src/trellis-lite/glob.ts";
import {
	buildInjection,
	contentSha,
	contextToolTexts,
	readMarkers,
	repoRelative,
	SpecIndex,
	touchedPaths,
} from "../src/trellis-lite/spec-inject.ts";
import { truncateChars } from "../src/trellis-lite/text.ts";
import { fakeCtx, fakePi, makeTree } from "./trellis-lite-fixtures.ts";

// ── frontmatter ─────────────────────────────────────────────────────────────

test("frontmatter: block list, flow list, BOM, comments, quotes", () => {
	const text = "---\ndescription: db rules # note\npaths:\n  - src/db/**\n  - 'a b.py'\n---\n# Body\n";
	assert.deepEqual(parseFrontmatter(text), {
		bodyStart: text.indexOf("# Body"),
		description: "db rules",
		paths: ["src/db/**", "a b.py"],
	});
	const flow = parseFrontmatter('\uFEFF---\npaths: [src/a.ts, "src/b/"]\nname: x\n---\nbody');
	assert.deepEqual(flow?.paths, ["src/a.ts", "src/b/"]);
	assert.equal(flow?.name, "x");
	assert.equal('\uFEFF---\npaths: [src/a.ts, "src/b/"]\nname: x\n---\nbody'.slice(flow?.bodyStart), "body");
});

test("frontmatter: block scalars are skipped, unknown keys ignored", () => {
	const parsed = parseFrontmatter("---\nsummary: >\n  long text\n  - not a path\npaths:\n- x/**\nowner: me\n---\n");
	assert.deepEqual(parsed?.paths, ["x/**"]);
});

test("frontmatter: none, horizontal rule, and the two errors", () => {
	assert.equal(parseFrontmatter("# Title\n---\n"), undefined);
	assert.equal(parseFrontmatter("---\nJust prose under a rule.\n---\n"), undefined);
	assert.throws(() => parseFrontmatter("---\npaths: src/**\n---\n"), /list of globs/u);
	assert.throws(() => parseFrontmatter("---\npaths: |\n  src\n---\n"), /list of globs/u);
	assert.throws(() => parseFrontmatter("---\npaths:\n  - a\n"), /not closed/u);
});

// ── globs ───────────────────────────────────────────────────────────────────

test("glob semantics", () => {
	const cases: Array<[string, string[], string[]]> = [
		["src/commands/update.ts", ["src/commands/update.ts"], ["src/commands/update.tsx", "x/src/commands/update.ts"]],
		["src/commands/*.ts", ["src/commands/a.ts"], ["src/commands/sub/a.ts", "src/commands/a.js"]],
		["src/templates/**", ["src/templates/a.ts", "src/templates/x/y/z.md"], ["src/templates", "src/templatesX/a"]],
		["packages/**/index.ts", ["packages/index.ts", "packages/cli/src/index.ts"], ["packages/cli/index.tsx"]],
		["**/*.sql", ["a.sql", "db/m/1.sql"], ["a.sqlx"]],
		["src/util?.py", ["src/utils.py"], ["src/util.py", "src/utilXY.py", "src/util/.py"]],
		["packages/cli/", ["packages/cli/a.ts", "packages/cli/x/y"], ["packages/cli", "packages/clix/a"]],
		["app/[slug]/(group)/@modal/页面.tsx", ["app/[slug]/(group)/@modal/页面.tsx"], ["app/s/(group)/@modal/页面.tsx"]],
		["src/a**b.ts", ["src/aXb.ts", "src/ab.ts"], ["src/a/b.ts"]],
	];
	for (const [glob, yes, no] of cases) {
		const regex = compileGlob(glob, false);
		for (const path of yes) assert.ok(regex.test(path), `${glob} should match ${path}`);
		for (const path of no) assert.ok(!regex.test(path), `${glob} should not match ${path}`);
	}
	assert.ok(compileGlob("SRC/*.ts", true).test("src/a.ts"));
	assert.ok(!compileGlob("SRC/*.ts", false).test("src/a.ts"));
});

test("glob validation", () => {
	assert.equal(globError("src/**"), undefined);
	for (const bad of ["", "/abs/x", "a/../b", "a\\b", "a\u0001"]) assert.ok(globError(bad), bad);
});

test("specificity: exact, then narrow, then broad", () => {
	const order = ["**", "src/**", "src/db/*.py", "src/db/models.py"]
		.map((glob) => ({ glob, score: specificity(glob) }))
		.sort((a, b) => compareSpecificity(a.score, b.score))
		.map((entry) => entry.glob);
	assert.deepEqual(order, ["src/db/models.py", "src/db/*.py", "src/**", "**"]);
});

test("truncation never splits a surrogate pair", () => {
	assert.equal(truncateChars("中文测试", 2), "中文");
	assert.equal(truncateChars("a😀b", 2), "a");
	assert.equal(truncateChars("short", 10), "short");
});

// ── touched paths ───────────────────────────────────────────────────────────

test("touched paths for read/edit/write/apply_patch only", () => {
	assert.deepEqual(touchedPaths("read", { path: "src/a.ts" }), ["src/a.ts"]);
	assert.deepEqual(touchedPaths("edit", { path: "src/a.ts", edits: [] }), ["src/a.ts"]);
	assert.deepEqual(
		touchedPaths("apply_patch", {
			input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** Add File: c.md\n+hi\n*** Delete File: d.ts\n*** End Patch",
		}),
		["src/a.ts", "src/b.ts", "c.md"],
	);
	assert.deepEqual(touchedPaths("bash", { command: "cat src/a.ts" }), []);
	assert.deepEqual(touchedPaths("ffgrep", { pattern: "x", path: "src/" }), []);
});

test("repo-relative paths: relative, absolute, @-prefixed, outside", () => {
	const { root, cleanup } = makeTree({ "p/src/a.ts": "" });
	try {
		const project = join(root, "p");
		assert.equal(repoRelative(project, join(project, "src"), "a.ts"), "src/a.ts");
		assert.equal(repoRelative(project, project, "@src/a.ts"), "src/a.ts");
		assert.equal(repoRelative(project, "/elsewhere", join(project, "src", "new.ts")), "src/new.ts");
		assert.equal(repoRelative(project, project, "../outside.ts"), undefined);
		assert.equal(repoRelative(project, project, "."), undefined);
	} finally {
		cleanup();
	}
});

// ── matching and budgets ────────────────────────────────────────────────────

function specProject(files: Record<string, string>) {
	return makeTree({ ".trellis/.developer": "name=d\n", ".trellis/spec/index.md": "# index\n", ...files });
}

test("index: matches by frontmatter, most specific first; reports bad specs", () => {
	const { root, cleanup } = specProject({
		".trellis/spec/backend/db.md": "---\ndescription: db\npaths:\n  - src/db/**\n---\nDB body\n",
		".trellis/spec/backend/models.md": "---\npaths: [src/db/models.py]\n---\nModels body\n",
		".trellis/spec/backend/all.md": "---\npaths: ['**']\n---\nAll\n",
		".trellis/spec/backend/none.md": "# no frontmatter\n",
		".trellis/spec/backend/bad.md": "---\npaths: src/**\n---\n",
		".trellis/spec/backend/badglob.md": "---\npaths: [/abs, src/ok/**]\n---\n",
	});
	try {
		const index = new SpecIndex(root);
		assert.deepEqual(
			index.match("src/db/models.py").map((rule) => rule.path),
			[".trellis/spec/backend/models.md", ".trellis/spec/backend/db.md", ".trellis/spec/backend/all.md"],
		);
		assert.deepEqual(index.match("README.md").map((rule) => rule.path), [".trellis/spec/backend/all.md"]);
		const problems = index.scan().problems.map((problem) => problem.path);
		assert.deepEqual(problems, [".trellis/spec/backend/bad.md", ".trellis/spec/backend/badglob.md"]);
		assert.deepEqual(index.match("src/ok/x").map((rule) => rule.path).includes(".trellis/spec/backend/badglob.md"), true);

		// Edits to a spec are picked up (mtime/size cache).
		writeFileSync(join(root, ".trellis/spec/backend/none.md"), "---\npaths: [README.md]\n---\nnow scoped, longer\n");
		assert.ok(index.match("README.md").some((rule) => rule.path === ".trellis/spec/backend/none.md"));
	} finally {
		cleanup();
	}
});

const rule = (path: string, description?: string) => ({ path, globs: [], description });

test("injection: full body without frontmatter, once per content", () => {
	const specs: Record<string, string> = { "a.md": "---\npaths: [x]\n---\nRule A\n" };
	const read = (path: string) => specs[path];
	const first = buildInjection({ root: "/r", file: "x", rules: [rule("a.md")], state: new Map(), readSpec: read });
	assert.ok(first);
	assert.match(first.text, /^<spec-context file="x">/u);
	assert.match(first.text, new RegExp(`<spec path="a.md" sha="${contentSha(specs["a.md"]!)}">\\nRule A\\n</spec>`, "u"));
	assert.ok(!first.text.includes("paths: [x]"));

	const state = readMarkers([first.text]);
	assert.equal(buildInjection({ root: "/r", file: "x", rules: [rule("a.md")], state, readSpec: read }), undefined);

	specs["a.md"] = "---\npaths: [x]\n---\nRule A, revised\n";
	assert.match(buildInjection({ root: "/r", file: "x", rules: [rule("a.md")], state, readSpec: read })?.text ?? "", /revised/u);
});

test("injection budgets: per spec, per result, per session", () => {
	const budget = { perSpec: 50, perResult: 260, perSession: 300 };
	const specs: Record<string, string> = {
		"long.md": "中".repeat(80),
		"b.md": "B".repeat(40),
		"c.md": "C".repeat(40),
		"d.md": "D".repeat(40),
	};
	const read = (path: string) => specs[path];
	const result = buildInjection({
		root: "/r",
		file: "x",
		rules: [rule("long.md"), rule("b.md"), rule("c.md"), rule("d.md", "d rules")],
		state: new Map(),
		budget,
		readSpec: read,
	});
	assert.ok(result);
	assert.match(result.text, /中{50}\n\[truncated at 50 characters; read long\.md for the rest\]/u);
	assert.match(result.text, /<spec path="d.md" sha="[0-9a-f]{12}" listed="budget">d rules<\/spec>/u);
	assert.equal(result.added.get("d.md")?.full, false);
	assert.equal(result.added.get("b.md")?.full, true);

	// The session budget counts what is already in the context.
	const state = readMarkers([result.text]);
	specs["e.md"] = "E".repeat(40);
	const later = buildInjection({ root: "/r", file: "y", rules: [rule("e.md"), rule("d.md")], state, budget, readSpec: read });
	assert.match(later?.text ?? "", /<spec path="e.md" sha="[0-9a-f]{12}" listed="budget">/u);
	assert.ok(!later?.text.includes('path="d.md"'), "an already listed spec is not listed again");
});

test("context texts: only tool results after the last compaction's kept point", () => {
	const tool = (id: string, text: string) => ({ type: "message", id, message: { role: "toolResult", content: [{ type: "text", text }] } });
	const branch = [
		tool("1", "old"),
		tool("2", "kept"),
		{ type: "compaction", id: "3", firstKeptEntryId: "2" },
		{ type: "message", id: "4", message: { role: "user", content: [{ type: "text", text: "user" }] } },
		tool("5", "new"),
	];
	assert.deepEqual(contextToolTexts(branch), ["kept", "new"]);
	assert.deepEqual(contextToolTexts(branch.slice(0, 2)), ["old", "kept"]);
});

// ── extension wiring ────────────────────────────────────────────────────────

function sessionWith(texts: string[]) {
	return {
		buildContextEntries: () =>
			texts.map((text, i) => ({ type: "message", id: String(i), message: { role: "toolResult", content: [{ type: "text", text }] } })),
	};
}

test("extension: read attaches a matching spec once; compaction brings it back", async () => {
	const { root, cleanup } = specProject({
		".git/": "",
		".trellis/spec/backend/db.md": "---\npaths: [src/db/**]\n---\n数据库规则\n",
		"src/db/models.py": "x = 1\n",
		"src/other.py": "",
	});
	try {
		const pi = fakePi();
		trellisLite(pi.api);
		const history: string[] = [];
		const ctx = fakeCtx(root, { sessionManager: sessionWith(history) });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const read = (path: string, extra: Record<string, unknown> = {}) =>
			pi.emit(
				"tool_result",
				{ toolName: "read", input: { path }, content: [{ type: "text", text: "x = 1" }], isError: false, ...extra },
				ctx,
			);

		const first = await read("src/db/models.py");
		assert.equal(first.content.length, 2);
		assert.equal(first.content[0].text, "x = 1");
		assert.match(first.content[1].text, /数据库规则/u);
		history.push(first.content[1].text);

		assert.equal(await read("src/db/models.py"), undefined, "second read in the same session");
		assert.equal(await read("src/other.py"), undefined, "no matching spec");
		assert.equal(await read(".trellis/spec/backend/db.md"), undefined, "spec files themselves");
		assert.equal(await read("src/db/x.py", { isError: true }), undefined, "failed calls");
		assert.equal(await read("src/db/x.py", { parentToolCallId: "p" }), undefined, "nested calls");

		// Compaction: the earlier tool result is no longer in the context.
		history.length = 0;
		await pi.emit("session_compact", {}, ctx);
		assert.match((await read("src/db/models.py")).content[1].text, /数据库规则/u);
	} finally {
		cleanup();
	}
});

test("extension: resumed session derives what is already attached from the transcript", async () => {
	const { root, cleanup } = specProject({ ".git/": "", ".trellis/spec/db.md": "---\npaths: [src/**]\n---\nrule\n", "src/a.py": "" });
	try {
		const text = "---\npaths: [src/**]\n---\nrule\n";
		const previous = `<spec-context file="src/a.py">\n<spec path=".trellis/spec/db.md" sha="${contentSha(text)}">\nrule\n</spec>\n</spec-context>`;
		const pi = fakePi();
		trellisLite(pi.api);
		const ctx = fakeCtx(root, { sessionManager: sessionWith([previous]) });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const result = await pi.emit(
			"tool_result",
			{ toolName: "edit", input: { path: "src/a.py" }, content: [{ type: "text", text: "ok" }], isError: false },
			ctx,
		);
		assert.equal(result, undefined);
	} finally {
		cleanup();
	}
});

test("extension: PI_PRESET_TRELLIS_SPECS=off keeps tool results untouched", async () => {
	const previous = process.env.PI_PRESET_TRELLIS_SPECS;
	process.env.PI_PRESET_TRELLIS_SPECS = "off";
	const { root, cleanup } = specProject({ ".git/": "", ".trellis/spec/db.md": "---\npaths: [src/**]\n---\nrule\n" });
	try {
		const pi = fakePi();
		trellisLite(pi.api);
		const ctx = fakeCtx(root, { sessionManager: sessionWith([]) });
		const result = await pi.emit(
			"tool_result",
			{ toolName: "read", input: { path: "src/a.py" }, content: [], isError: false },
			ctx,
		);
		assert.equal(result, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_PRESET_TRELLIS_SPECS;
		else process.env.PI_PRESET_TRELLIS_SPECS = previous;
		cleanup();
	}
});
