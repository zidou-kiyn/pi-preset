import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import trellisLite from "../extensions/trellis-lite.ts";
import { cleanPiSettings, cleanRootGitignore, cleanTrellisGitignore, removeManagedBlock } from "../src/trellis-lite/migrate/edits.ts";
import { applyMigration, findStaleReferences, isTrellisOwned, scanMigration } from "../src/trellis-lite/migrate/run.ts";
import { fakeCtx, fakePi, makeTree, writeTree } from "./trellis-lite-fixtures.ts";

// ── exact edits ─────────────────────────────────────────────────────────────

test("AGENTS.md: only the managed block goes; the rest is byte-identical", () => {
	const before = "# Project\r\n\r\nIntro.\n\n";
	const block = "<!-- TRELLIS:START -->\n# Trellis Instructions\nstuff\n<!-- TRELLIS:END -->\n\n";
	const after = "## Our rules\n\n- never X\n";
	const outcome = removeManagedBlock(before + block + after);
	assert.equal(outcome.kind, "edit");
	assert.equal(outcome.kind === "edit" && outcome.text, before + after);
	assert.deepEqual(outcome.kind === "edit" && outcome.removed, ["<!-- TRELLIS:START -->", "# Trellis Instructions", "stuff", "<!-- TRELLIS:END -->", ""]);

	assert.deepEqual(removeManagedBlock("no block\n"), { kind: "unchanged" });
	assert.equal(removeManagedBlock(block).kind, "delete");
	assert.equal(removeManagedBlock(`${block}${block}`).kind, "review");
	assert.equal(removeManagedBlock("<!-- TRELLIS:END -->\n<!-- TRELLIS:START -->\n").kind, "review");
	assert.equal(removeManagedBlock("text <!-- TRELLIS:START -->\n<!-- TRELLIS:END -->\n").kind, "review");
});

test(".pi/settings.json: Trellis entries go, other keys stay; defaults-only file is deleted", () => {
	const trellisOnly = JSON.stringify({ enableSkillCommands: true, extensions: ["./extensions/trellis/index.ts"], prompts: ["./prompts"] });
	assert.equal(cleanPiSettings(trellisOnly).kind, "delete");

	const mixed = cleanPiSettings(
		JSON.stringify({
			theme: "dark",
			extensions: ["./extensions/trellis/index.ts", "./extensions/mine.ts"],
			prompts: ["./prompts", "./more/x.md"],
			skills: ["./skills/trellis-check", "./skills/own"],
		}),
	);
	assert.equal(mixed.kind, "edit");
	assert.deepEqual(JSON.parse(mixed.kind === "edit" ? mixed.text : "{}"), {
		theme: "dark",
		extensions: ["./extensions/mine.ts"],
		prompts: ["./more/x.md"],
		skills: ["./skills/own"],
	});
	assert.deepEqual(cleanPiSettings('{"theme":"dark"}'), { kind: "unchanged" });
	assert.equal(cleanPiSettings("{ // jsonc\n}").kind, "review");
});

test(".gitignore files: Trellis runtime rules and their comments go", () => {
	const trellis = "# Developer identity\n.developer\n\n# Runtime\n.runtime/\n.current-task\n\n# Mine\nlocal.txt\n";
	const outcome = cleanTrellisGitignore(trellis);
	assert.equal(outcome.kind === "edit" && outcome.text, "# Developer identity\n.developer\n\n# Mine\nlocal.txt\n");
	assert.deepEqual(cleanRootGitignore("node_modules/\n.trellis/.runtime/\n.trellis/spec/\n"), {
		kind: "edit",
		text: "node_modules/\n.trellis/spec/\n",
		removed: [".trellis/.runtime/"],
	});
	assert.deepEqual(cleanRootGitignore("node_modules/\n"), { kind: "unchanged" });
});

test("stale references need word boundaries", () => {
	const text = "Run `python3 .trellis/scripts/task.py start`.\n| `test_calculate_cost_from_task.py` |\nsee /trellis:finish-work and trellis-check-extended\n";
	assert.deepEqual(
		findStaleReferences("spec.md", text).map((ref) => `${ref.line}:${ref.term}`),
		["1:task.py", "3:/trellis:finish-work"],
	);
});

test("Trellis-owned paths", () => {
	for (const path of [
		".trellis/scripts/x.py",
		".trellis/workflow.md",
		".pi/extensions/trellis/index.ts",
		".agents/skills/trellis-meta/SKILL.md",
		".claude/commands/trellis/start.md",
		".pi/prompts/mini-trellis-remember.md",
	]) {
		assert.ok(isTrellisOwned(path), path);
	}
	for (const path of [".pi/prompts/release.md", ".agents/skills/mine/SKILL.md", ".trellis/notes.md", "src/trellis.ts/x"]) {
		assert.ok(!isTrellisOwned(path), path);
	}
});

// ── classification and apply ────────────────────────────────────────────────

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function legacyProject() {
	const files: Record<string, string> = {
		".trellis/.developer": "name=d\n",
		".trellis/.version": "0.6.17",
		".trellis/.gitignore": ".developer\n.runtime/\n**/*.pyc\n",
		".trellis/config.yaml": "max_journal_lines: 2000\n",
		".trellis/workflow.md": "# Workflow\nPhase 3.6 release (ours)\n",
		".trellis/scripts/task.py": "print()\n",
		".trellis/scripts/common/__pycache__/x.cpython-313.pyc": "bytes-now",
		".trellis/scripts/own_helper.py": "# not registered\n",
		".trellis/.runtime/sessions/a.json": "{}",
		".trellis/.backup-2026-08-01/x": "old",
		".trellis/spec/backend/index.md": "# Backend\nSee `src/app/main.py` and `src/app/db.py`.\n",
		".trellis/workspace/d/journal-1.md": "# Journal\n",
		".trellis/tasks/10-09-open/task.json": "{}",
		".trellis/tasks/10-09-open/prd.md": "# PRD\n",
		".trellis/tasks/10-09-open/implement.jsonl": "",
		".trellis/notes.md": "user notes\n",
		".pi/settings.json": JSON.stringify({ extensions: ["./extensions/trellis/index.ts"], prompts: ["./prompts"] }),
		".pi/extensions/trellis/index.ts": "export default () => {}\n",
		".pi/prompts/trellis-start.md": "start\n",
		".pi/prompts/release.md": "user prompt\n",
		".agents/skills/trellis-check/SKILL.md": "check\n",
		".agents/skills/mine/SKILL.md": "mine\n",
		".claude/settings.json": "{}\n",
		".claude/commands/trellis/start.md": "start\n",
		".claude/hooks/__pycache__/h.pyc": "x",
		"AGENTS.md": "<!-- TRELLIS:START -->\nmanaged, see task.py\n<!-- TRELLIS:END -->\n\n## Ours\n- direct on dev, journal via add_session.py\n",
		"src/app/main.py": "",
		"src/app/db.py": "",
	};
	const registered = [
		".trellis/config.yaml",
		".trellis/workflow.md",
		".trellis/scripts/task.py",
		".trellis/scripts/common/__pycache__/x.cpython-313.pyc",
		".pi/settings.json",
		".pi/extensions/trellis/index.ts",
		".pi/prompts/trellis-start.md",
		".agents/skills/trellis-check/SKILL.md",
		".claude/settings.json",
		".claude/commands/trellis/start.md",
		"AGENTS.md",
	];
	const hashes: Record<string, string> = {};
	for (const path of registered) hashes[path] = sha(files[path] ?? "");
	hashes[".trellis/workflow.md"] = sha("# Workflow\n");
	hashes[".trellis/scripts/common/__pycache__/x.cpython-313.pyc"] = sha("bytes-then");
	files[".trellis/.template-hashes.json"] = JSON.stringify({ __version: 2, hashes });
	const tree = makeTree(files);
	execFileSync("git", ["init", "-q", tree.root]);
	writeFileSync(join(tree.root, ".gitignore"), ".trellis/.runtime/\n.trellis/.backup-*\n**/__pycache__/\n.trellis/.developer\n");
	execFileSync("git", ["-C", tree.root, "add", "-A"]);
	execFileSync("git", ["-C", tree.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
	return tree;
}

function userDataDigest(root: string): string {
	return execFileSync("sh", ["-c", "cd .trellis && find spec workspace tasks -type f -exec sha256sum {} + | sort"], { cwd: root, encoding: "utf8" });
}

test("scan: every category is classified", () => {
	const { root, cleanup } = legacyProject();
	try {
		const plan = scanMigration(root);
		assert.equal(plan.trellisVersion, "0.6.17");
		assert.equal(plan.git.clean, true);
		assert.deepEqual(
			plan.delete.map((item) => item.path),
			[
				".trellis/.backup-2026-08-01/",
				".trellis/.runtime/",
				".trellis/scripts/common/__pycache__/",
				".agents/skills/trellis-check/SKILL.md",
				".pi/extensions/trellis/index.ts",
				".pi/prompts/trellis-start.md",
				".trellis/.version",
				".trellis/config.yaml",
				".trellis/scripts/task.py",
			],
		);
		assert.deepEqual(
			plan.needsReview.map((item) => `${item.path}: ${item.reason}`),
			[".trellis/scripts/own_helper.py: not in Trellis's hash table", ".trellis/workflow.md: modified template"],
		);
		assert.deepEqual(
			plan.edit.map((item) => `${item.path} ${item.action}`),
			[".pi/settings.json delete", ".trellis/.gitignore edit", "AGENTS.md edit", ".gitignore edit"],
		);
		assert.deepEqual(Object.keys(plan.hosts), [".claude"]);
		assert.deepEqual(
			plan.hosts[".claude"]?.delete.map((item) => item.path),
			[".claude/hooks/__pycache__/", ".claude/commands/trellis/start.md", ".claude/settings.json"],
		);
		// Stale references come from AGENTS.md as edited (the managed block is excluded).
		assert.deepEqual(plan.staleReferences.map((ref) => ref.term), ["add_session.py"]);
		assert.deepEqual(plan.activeTasks, [{ path: ".trellis/tasks/10-09-open/", trellisFiles: ["implement.jsonl", "task.json"] }]);
		assert.deepEqual(plan.pathHints, [{ spec: ".trellis/spec/backend/index.md", dirs: ["src/app/** (2)"] }]);
		assert.equal(plan.nothingToDo, false);
	} finally {
		cleanup();
	}
});

test("apply: deletes and edits, keeps user data and review files, then converges", () => {
	const { root, cleanup } = legacyProject();
	try {
		const digest = userDataDigest(root);
		const report = applyMigration(root, { date: "2026-10-10", now: "2026-10-10T00:00:00" });
		assert.equal(report.trellisVersion, "0.6.17");
		assert.equal(userDataDigest(root), digest);
		for (const gone of [".pi/settings.json", ".pi/extensions", ".pi/prompts/trellis-start.md", ".agents/skills/trellis-check", ".trellis/.runtime", ".trellis/config.yaml", ".trellis/.version"]) {
			assert.ok(!existsSync(join(root, gone)), gone);
		}
		for (const kept of [".pi/prompts/release.md", ".trellis/workflow.md", ".trellis/scripts/own_helper.py", ".agents/skills/mine/SKILL.md", ".trellis/notes.md", ".claude/settings.json"]) {
			assert.ok(existsSync(join(root, kept)), kept);
		}
		assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "## Ours\n- direct on dev, journal via add_session.py\n");
		assert.equal(readFileSync(join(root, ".trellis/.gitignore"), "utf8"), ".developer\n");
		assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "**/__pycache__/\n.trellis/.developer\n");
		// The hash table stays for the files still left (other host, review).
		const left = Object.keys(JSON.parse(readFileSync(join(root, ".trellis/.template-hashes.json"), "utf8")).hashes).sort();
		assert.deepEqual(left, [".claude/commands/trellis/start.md", ".claude/settings.json", ".trellis/workflow.md"]);
		// Existing layer indexes mean no generic spec/index.md is added.
		assert.ok(!existsSync(join(root, ".trellis/spec/index.md")));

		// Dirty tree: refused.
		assert.throws(() => applyMigration(root), /uncommitted changes/u);

		// After the review step removed the reviewed files and everything is committed: nothing to do.
		execFileSync("git", ["-C", root, "rm", "-q", ".trellis/workflow.md"]);
		execFileSync("git", ["-C", root, "rm", "-q", ".trellis/scripts/own_helper.py"]);
		execFileSync("git", ["-C", root, "add", "-A"]);
		execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "migrate"]);
		const again = scanMigration(root);
		assert.equal(again.nothingToDo, true, JSON.stringify(again, null, 1));
		assert.equal(again.hosts[".claude"]?.delete.length, 3, "kept host files stay verifiable");

		// Removing the other host later works and drops the hash table with it.
		const hosts = applyMigration(root, { removeHosts: [".claude"] });
		assert.ok(!existsSync(join(root, ".claude")));
		assert.ok(hosts.deleted.includes(".trellis/.template-hashes.json"));
	} finally {
		cleanup();
	}
});

test("apply: refused outside git", () => {
	const { root, cleanup } = makeTree({ ".trellis/spec/": "", ".pi/extensions/trellis/index.ts": "" });
	try {
		assert.throws(() => applyMigration(root), /Not a git repository/u);
		assert.equal(scanMigration(root).hashTable, false);
		assert.deepEqual(scanMigration(root).needsReview.map((item) => item.path), [".pi/extensions/trellis/index.ts"]);
	} finally {
		cleanup();
	}
});

test("CLI: dry run by default, --apply needs --yes, --json is parseable", () => {
	const { root, cleanup } = legacyProject();
	try {
		const cli = new URL("../trellis-lite/bin/trellis-lite.ts", import.meta.url).pathname;
		const run = (...args: string[]) => {
			try {
				return { code: 0, out: execFileSync(process.execPath, [decodeURIComponent(cli), "migrate", ...args], { cwd: join(root, "src"), encoding: "utf8", stdio: "pipe" }) };
			} catch (error) {
				const failure = error as { status: number; stderr: string };
				return { code: failure.status, out: failure.stderr };
			}
		};
		assert.match(run().out, /dry run/u);
		assert.equal(JSON.parse(run("--json").out).trellisVersion, "0.6.17");
		assert.equal(run("--apply").code, 2);
		assert.ok(existsSync(join(root, ".pi/settings.json")));
		assert.match(run("--apply", "--yes").out, /Not committed/u);
		assert.ok(!existsSync(join(root, ".pi/settings.json")));
	} finally {
		cleanup();
	}
});

test("/trellis-lite-migrate sends the prompt with the CLI path; /trellis-lite migrate shows the plan", async () => {
	const { root, cleanup } = legacyProject();
	try {
		writeTree(root, {});
		const pi = fakePi();
		trellisLite(pi.api);
		const ctx = fakeCtx(root);
		await pi.commands.get("trellis-lite-migrate")!.handler("", ctx);
		assert.equal(pi.sent.length, 1);
		assert.match(pi.sent[0]!, /node "\/.*trellis-lite\/bin\/trellis-lite\.ts" migrate --json/u);
		assert.ok(!pi.sent[0]!.includes("{{CLI}}"));
		await pi.commands.get("trellis-lite")!.handler("migrate", ctx);
		assert.match(ctx.notes.at(-1)!.text, /Needs review/u);
		assert.ok(existsSync(join(root, ".pi/settings.json")), "the command only shows the plan");
	} finally {
		cleanup();
	}
});
