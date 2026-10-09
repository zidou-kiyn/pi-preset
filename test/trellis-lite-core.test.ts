import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import trellisLite from "../extensions/trellis-lite.ts";
import { readTrellisConfig } from "../src/trellis-lite/config.ts";
import { detectLegacy, findProjectRoot, maxJournalLines, readDeveloper, readJournalInfo } from "../src/trellis-lite/root.ts";
import { buildSnapshot, LIMITS } from "../src/trellis-lite/snapshot.ts";
import { fakeCtx, fakePi, makeTree } from "./trellis-lite-fixtures.ts";

const journal = (sessions: number[], extraLines = 0) =>
	[
		"# Journal - dev (Part 1)",
		"",
		...sessions.flatMap((n) => [`## Session ${n}: t${n}`, "", "body", ""]),
		...Array.from({ length: extraLines }, () => "x"),
	].join("\n") + "\n";

function weibiLike() {
	return makeTree({
		"project/.git/": "",
		"project/.trellis/.developer": "name=zidou\ninitialized_at=2026-07-26T19:20:07\n",
		"project/.trellis/spec/backend/index.md": "# backend\n",
		"project/.trellis/spec/backend/db.md": "# db\n",
		"project/.trellis/spec/guides/index.md": "# guides\n",
		"project/.trellis/workspace/zidou/journal-1.md": journal([1, 2, 3]),
		"project/.trellis/tasks/archive/2026-10/10-01-old/prd.md": "old",
		"project/src/app/main.py": "print()\n",
	});
}

test("root: nearest .trellis up from a subdirectory, stopping at the repo root and $HOME", () => {
	const { root, cleanup } = weibiLike();
	try {
		const project = join(root, "project");
		assert.equal(findProjectRoot(join(project, "src", "app"), "/nonexistent-home"), project);
		assert.equal(findProjectRoot(project, "/nonexistent-home"), project);

		// A nested repository without .trellis does not inherit the outer project.
		mkdirSync(join(project, "vendor", "lib", ".git"), { recursive: true });
		assert.equal(findProjectRoot(join(project, "vendor", "lib"), "/nonexistent-home"), undefined);

		// $HOME and above are never considered.
		assert.equal(findProjectRoot(join(project, "src"), project), undefined);
	} finally {
		cleanup();
	}
});

test("root: an empty or symlinked .trellis is not a project", () => {
	const { root, cleanup } = makeTree({ "a/.trellis/": "", "real/.trellis/spec/": "", "b/": "" });
	try {
		assert.equal(findProjectRoot(join(root, "a"), "/nonexistent-home"), undefined);
		symlinkSync(join(root, "real", ".trellis"), join(root, "b", ".trellis"));
		assert.equal(findProjectRoot(join(root, "b"), "/nonexistent-home"), undefined);
		assert.equal(findProjectRoot(join(root, "real"), "/nonexistent-home"), join(root, "real"));
	} finally {
		cleanup();
	}
});

test("legacy: every pi-visible Trellis asset is reported", () => {
	const { root, cleanup } = makeTree({
		".trellis/spec/": "",
		".pi/extensions/trellis/index.ts": "",
		".pi/extensions/mini-trellis/index.ts": "",
		".agents/skills/trellis-check/SKILL.md": "",
		".agents/skills/other/SKILL.md": "",
		".pi/skills/trellis-meta/SKILL.md": "",
		".pi/prompts/trellis-start.md": "",
		".pi/prompts/mini-trellis-remember.md": "",
		".pi/prompts/release.md": "",
	});
	try {
		assert.deepEqual(detectLegacy(root), [
			".pi/extensions/trellis/",
			".pi/extensions/mini-trellis/",
			".agents/skills/trellis-check",
			".pi/skills/trellis-meta",
			".pi/prompts/mini-trellis-remember.md",
			".pi/prompts/trellis-start.md",
		]);
	} finally {
		cleanup();
	}
});

test("developer, journal info, and max_journal_lines", () => {
	const { root, cleanup } = makeTree({
		".trellis/.developer": "initialized_at=x\nname= dev \n",
		".trellis/config.yaml": "session_commit_message: x\nmax_journal_lines: 500 # cap\n",
		".trellis/workspace/dev/journal-1.md": journal([1, 2]),
		".trellis/workspace/dev/journal-2.md": journal([3, 4], 10),
		".trellis/workspace/dev/journal-10.md": journal([5]),
		".trellis/workspace/dev/notes.md": "## Session 99: not a journal\n",
	});
	try {
		assert.equal(readDeveloper(root), "dev");
		assert.equal(maxJournalLines(root), 500);
		assert.deepEqual(readJournalInfo(root, "dev"), {
			path: ".trellis/workspace/dev/journal-10.md",
			part: 10,
			lines: 6,
			sessions: 5,
		});
	} finally {
		cleanup();
	}
});

test("snapshot: weibi-bot shape, byte-stable", () => {
	const { root, cleanup } = weibiLike();
	try {
		const project = join(root, "project");
		const text = buildSnapshot(project, { specInjection: true });
		assert.equal(
			text,
			[
				"This project keeps durable memory in .trellis/. Read files there when they are relevant; do not load them all up front.",
				"- Spec indexes (read the one for the area you change before editing code there): .trellis/spec/backend/index.md, .trellis/spec/guides/index.md",
				"- Journal: .trellis/workspace/zidou/journal-1.md (3 sessions, 14/2000 lines)",
				"- Open tasks: none",
				"Specs whose frontmatter `paths:` match a file you read or edit are attached to that tool result.",
			].join("\n"),
		);
		assert.equal(buildSnapshot(project, { specInjection: true }), text);
		assert.ok(!buildSnapshot(project, { specInjection: false }).includes("paths:"));
	} finally {
		cleanup();
	}
});

test("snapshot: tasks, research, and caps", () => {
	const files: Record<string, string> = {
		".trellis/spec/index.md": "",
		".trellis/research/README.md": "",
		".trellis/research/archive/old.md": "",
		".trellis/research/protocol.md": "",
		".trellis/research/capture/": "",
		".trellis/research/raw.txt": "",
	};
	for (let i = 1; i <= 7; i++) files[`.trellis/tasks/10-0${i}-t${i}/prd.md`] = "";
	files[".trellis/tasks/10-07-t7/design.md"] = "";
	for (let i = 0; i < 12; i++) files[`.trellis/spec/l${String(i).padStart(2, "0")}/index.md`] = "";
	files[".trellis/spec/pkg/backend/index.md"] = "";
	const { root, cleanup } = makeTree(files);
	try {
		const text = buildSnapshot(root, { specInjection: false });
		assert.match(text, /Spec indexes \(.*\): \.trellis\/spec\/index\.md, \.trellis\/spec\/l00\/index\.md, .* \(\+4 more\)/u);
		assert.match(text, /Open tasks: \.trellis\/tasks\/10-07-t7\/ \(prd, design\), \.trellis\/tasks\/10-06-t6\/ \(prd\), .* \(\+2 more\)/u);
		assert.match(text, /Research notes in \.trellis\/research\/: capture\/, protocol\.md$/mu);
		assert.match(text, /no developer set/u);
		assert.ok(text.length <= LIMITS.totalChars);
	} finally {
		cleanup();
	}
});

test("snapshot: degrades lists to counts past the size limit", () => {
	const files: Record<string, string> = { ".trellis/.developer": "name=d\n" };
	const long = "x".repeat(120);
	for (let i = 0; i < 6; i++) files[`.trellis/research/${long}${i}.md`] = "";
	for (let i = 0; i < 5; i++) files[`.trellis/tasks/10-0${i}-${long}/prd.md`] = "";
	for (let i = 0; i < 10; i++) files[`.trellis/spec/${long}${i}/index.md`] = "";
	const { root, cleanup } = makeTree(files);
	try {
		const text = buildSnapshot(root, { specInjection: true });
		assert.ok(text.length <= LIMITS.totalChars, `${text.length}`);
		assert.match(text, /Research notes: 6 in \.trellis\/research\//u);
		assert.match(text, /Open tasks: 5 under/u);
	} finally {
		cleanup();
	}
});

test("config: on by default; off values", () => {
	assert.deepEqual(readTrellisConfig({}), { enabled: true, specInjection: true });
	assert.equal(readTrellisConfig({ PI_PRESET_TRELLIS: "off" }).enabled, false);
	assert.equal(readTrellisConfig({ PI_PRESET_TRELLIS_SPECS: "0" }).specInjection, false);
});

test("extension: zero effect outside a Trellis project", async () => {
	const { root, cleanup } = makeTree({ "plain/.git/": "", "plain/src/a.ts": "" });
	try {
		const pi = fakePi();
		trellisLite(pi.api);
		const cwd = join(root, "plain");
		const ctx = fakeCtx(cwd);
		assert.equal(await pi.emit("resources_discover", { cwd, reason: "startup" }), undefined);
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.emit("before_agent_start", event, ctx);
		assert.deepEqual(event.systemPromptOptions.sections, {});
		const result = { content: [{ type: "text", text: "file" }], input: { path: "src/a.ts" }, isError: false };
		assert.equal(await pi.emit("tool_result", { ...result, toolName: "read" }, ctx), undefined);
		assert.deepEqual(ctx.notes, []);
	} finally {
		cleanup();
	}
});

test("extension: section and skills in a Trellis project, stable across turns", async () => {
	const { root, cleanup } = weibiLike();
	try {
		const pi = fakePi();
		trellisLite(pi.api);
		const cwd = join(root, "project", "src");
		const ctx = fakeCtx(cwd);
		const discovered = await pi.emit("resources_discover", { cwd, reason: "startup" });
		assert.deepEqual(
			discovered.skillPaths.map((path: string) => path.split("/").slice(-2).join("/")),
			["trellis-spec/SKILL.md", "trellis-journal/SKILL.md", "trellis-plan/SKILL.md"],
		);
		const first = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.emit("before_agent_start", first, ctx);
		const section = first.systemPromptOptions.sections["project-memory"];
		assert.match(section ?? "", /journal-1\.md/u);

		// A new open task mid-session does not change the section bytes.
		mkdirSync(join(root, "project", ".trellis", "tasks", "10-09-new"), { recursive: true });
		const second = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.emit("before_agent_start", second, ctx);
		assert.equal(second.systemPromptOptions.sections["project-memory"], section);
		assert.deepEqual(ctx.notes, []);
	} finally {
		cleanup();
	}
});

test("extension: legacy assets pause everything and notify once", async () => {
	const { root, cleanup } = weibiLike();
	try {
		mkdirSync(join(root, "project", ".pi", "extensions", "trellis"), { recursive: true });
		const pi = fakePi();
		trellisLite(pi.api);
		const cwd = join(root, "project");
		const ctx = fakeCtx(cwd);
		assert.equal(await pi.emit("resources_discover", { cwd, reason: "startup" }), undefined);
		await pi.emit("session_start", { reason: "startup" }, ctx);
		await pi.emit("session_start", { reason: "reload" }, ctx);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.emit("before_agent_start", event, ctx);
		assert.deepEqual(event.systemPromptOptions.sections, {});
		assert.equal(ctx.notes.length, 1);
		assert.match(ctx.notes[0]!.text, /trellis-lite-migrate/u);
	} finally {
		cleanup();
	}
});

test("extension: PI_PRESET_TRELLIS=off registers nothing", () => {
	const previous = process.env.PI_PRESET_TRELLIS;
	process.env.PI_PRESET_TRELLIS = "off";
	try {
		const pi = fakePi();
		trellisLite(pi.api);
		assert.equal(pi.handlers.size, 0);
		assert.equal(pi.commands.size, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_PRESET_TRELLIS;
		else process.env.PI_PRESET_TRELLIS = previous;
	}
});
