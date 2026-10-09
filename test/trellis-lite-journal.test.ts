import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import trellisLite from "../extensions/trellis-lite.ts";
import { applyInit, developerId, planInit } from "../src/trellis-lite/init.ts";
import { appendJournal, type Git, journalHeader } from "../src/trellis-lite/journal.ts";
import { parseArgs } from "../trellis-lite/bin/trellis-lite.ts";
import { fakeCtx, fakePi, makeTree } from "./trellis-lite-fixtures.ts";

const git: Git = { branch: () => "dev", subject: (hash) => ({ abc1234: "feat: thing" })[hash] };

const INDEX = `# Workspace Index - d

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: \`journal-1.md\`
- **Total Sessions**: 1
- **Last Active**: 2026-10-01
<!-- @@@/auto:current-status -->

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| \`journal-1.md\` | ~10 | Active |
<!-- @@@/auto:active-documents -->

## Session History

<!-- @@@auto:session-history -->
| # | Date | Title | Commits | Branch |
|---|------|-------|---------|--------|
| 1 | 2026-10-01 | first | - | \`dev\` |
<!-- @@@/auto:session-history -->

Hand-written notes stay.
`;

test("journal: numbering continues, format, index blocks refreshed", () => {
	const existing = `${journalHeader("d", 1, "2026-10-01")}\n\n## Session 1: first\n\nbody\n`;
	const { root, cleanup } = makeTree({
		".trellis/.developer": "name=d\n",
		".trellis/workspace/d/journal-1.md": existing,
		".trellis/workspace/d/index.md": INDEX,
	});
	try {
		const result = appendJournal(
			root,
			{ title: "Add | pricing", summary: "Did it.\n\nNext: more.\n", commits: ["abc1234", "fff0000"] },
			git,
			"2026-10-10",
		);
		assert.deepEqual(result, { path: ".trellis/workspace/d/journal-1.md", session: 2, newFile: false, indexUpdated: true });
		const text = readFileSync(join(root, ".trellis/workspace/d/journal-1.md"), "utf8");
		assert.ok(text.startsWith(existing));
		assert.equal(
			text.slice(existing.length),
			[
				"",
				"",
				"## Session 2: Add \\| pricing",
				"",
				"**Date**: 2026-10-10",
				"**Task**: Add \\| pricing",
				"**Branch**: `dev`",
				"",
				"### Summary",
				"",
				"Did it.",
				"",
				"Next: more.",
				"",
				"### Git Commits",
				"",
				"| Hash | Message |",
				"|------|---------|",
				"| `abc1234` | feat: thing |",
				"| `fff0000` | (see git log) |",
				"",
				"### Status",
				"",
				"[OK] **Completed**",
				"",
			].join("\n"),
		);
		const index = readFileSync(join(root, ".trellis/workspace/d/index.md"), "utf8");
		assert.match(index, /\*\*Total Sessions\*\*: 2\n- \*\*Last Active\*\*: 2026-10-10/u);
		assert.match(index, /\|---\|------\|-------\|---------\|--------\|\n\| 2 \| 2026-10-10 \| Add \\\| pricing \| `abc1234`, `fff0000` \| `dev` \|\n\| 1 \|/u);
		assert.match(index, /\| `journal-1.md` \| ~\d+ \| Active \|/u);
		assert.ok(index.endsWith("Hand-written notes stay.\n"));
	} finally {
		cleanup();
	}
});

test("journal: a full file rolls over to journal-N+1; the first entry creates journal-1", () => {
	const { root, cleanup } = makeTree({
		".trellis/.developer": "name=d\n",
		".trellis/config.yaml": "max_journal_lines: 30\n",
		".trellis/workspace/d/journal-1.md": `${journalHeader("d", 1, "2026-10-01")}\n## Session 7: x\n${"line\n".repeat(15)}`,
	});
	try {
		const result = appendJournal(root, { title: "t", summary: "s", status: "In progress" }, git, "2026-10-10");
		assert.equal(result.path, ".trellis/workspace/d/journal-2.md");
		assert.equal(result.session, 8);
		assert.equal(result.newFile, true);
		assert.equal(result.indexUpdated, false);
		const text = readFileSync(join(root, ".trellis/workspace/d/journal-2.md"), "utf8");
		assert.ok(text.startsWith("# Journal - d (Part 2)\n\n> AI development session journal\n> Started: 2026-10-10\n"));
		assert.match(text, /\(No commits\)\n\n### Status\n\n\*\*In progress\*\*\n$/u);
	} finally {
		cleanup();
	}

	const fresh = makeTree({ ".trellis/.developer": "name=new\n" });
	try {
		assert.equal(appendJournal(fresh.root, { title: "t", summary: "s" }, git, "2026-10-10").path, ".trellis/workspace/new/journal-1.md");
	} finally {
		fresh.cleanup();
	}
});

test("journal: refuses without a developer, title, or summary", () => {
	const { root, cleanup } = makeTree({ ".trellis/spec/": "" });
	try {
		assert.throws(() => appendJournal(root, { title: "t", summary: "s" }, git, "2026-10-10"), /trellis-lite init/u);
		writeFileSync(join(root, ".trellis/.developer"), "name=d\n");
		assert.throws(() => appendJournal(root, { title: " ", summary: "s" }, git, "2026-10-10"), /title/u);
		assert.throws(() => appendJournal(root, { title: "t", summary: "\n" }, git, "2026-10-10"), /summary/u);
	} finally {
		cleanup();
	}
});

test("CLI: argument parsing and a real journal run", () => {
	assert.deepEqual(parseArgs(["journal", "--title", "A b", "--commits=a,b", "--apply"]), {
		command: "journal",
		flags: new Map<string, string | true>([
			["title", "A b"],
			["commits", "a,b"],
			["apply", true],
		]),
	});
	const { root, cleanup } = makeTree({ "p/.trellis/.developer": "name=d\n", "p/src/": "" });
	try {
		execFileSync("git", ["init", "-q", "-b", "main", join(root, "p")]);
		const cli = fileURLToPath(new URL("../trellis-lite/bin/trellis-lite.ts", import.meta.url));
		const out = execFileSync(process.execPath, [cli, "journal", "--title", "CLI run"], {
			cwd: join(root, "p", "src"),
			input: "Summary from stdin\n",
			encoding: "utf8",
		});
		assert.match(out, /Recorded session 1 in \.trellis\/workspace\/d\/journal-1\.md \(new file\)\. Not committed\./u);
		assert.match(readFileSync(join(root, "p/.trellis/workspace/d/journal-1.md"), "utf8"), /\*\*Branch\*\*: `main`/u);
	} finally {
		cleanup();
	}
});

test("init: plans only missing pieces and is idempotent", () => {
	const { root, cleanup } = makeTree({ ".trellis/.gitignore": "*.tmp\n" });
	try {
		const steps = planInit(root, "Zidou Kiyn", "2026-10-10", "2026-10-10T12:00:00");
		assert.deepEqual(
			steps.map((step) => `${step.append ? "append" : "create"} ${step.path}`),
			[
				"create .trellis/spec/index.md",
				"create .trellis/.developer",
				"create .trellis/workspace/Zidou Kiyn/journal-1.md",
				"append .trellis/.gitignore",
			],
		);
		applyInit(root, steps);
		assert.equal(readFileSync(join(root, ".trellis/.gitignore"), "utf8"), "*.tmp\n.developer\n");
		assert.equal(readFileSync(join(root, ".trellis/.developer"), "utf8"), "name=Zidou Kiyn\ninitialized_at=2026-10-10T12:00:00\n");
		assert.deepEqual(planInit(root, "someone-else", "2026-10-11", "x"), []);
		assert.equal(developerId(" Zidou Kiyn/x "), "Zidou-Kiyn-x");
	} finally {
		cleanup();
	}
});

test("/trellis-lite init creates the skeleton after confirmation", async () => {
	const { root, cleanup } = makeTree({ "repo/README.md": "" });
	try {
		execFileSync("git", ["init", "-q", join(root, "repo")]);
		execFileSync("git", ["-C", join(root, "repo"), "config", "user.name", "Test User"]);
		const pi = fakePi();
		trellisLite(pi.api);
		const ctx = fakeCtx(join(root, "repo"));
		await pi.commands.get("trellis-lite")!.handler("init", ctx);
		assert.ok(existsSync(join(root, "repo/.trellis/spec/index.md")));
		assert.equal(readFileSync(join(root, "repo/.trellis/.developer"), "utf8").split("\n")[0], "name=Test-User");
		assert.ok(existsSync(join(root, "repo/.trellis/workspace/Test-User/journal-1.md")));
		assert.match(ctx.notes.at(-1)!.text, /Not committed/u);
		await pi.commands.get("trellis-lite")!.handler("init", ctx);
		assert.match(ctx.notes.at(-1)!.text, /already initialized/u);
	} finally {
		cleanup();
	}
});
