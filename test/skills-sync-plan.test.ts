import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildRunnerArgs,
	createSkillSyncPlan,
	discoverRunner,
	getSkillSyncPaths,
	renderSkillSyncPlan,
	type SkillsCliRunner,
} from "../src/skills-sync-plan.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-plan-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function writeSkill(path: string, name: string): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(`${path}/SKILL.md`, `---\nname: ${name}\ndescription: test\n---\n\nTest skill.\n`);
}

function writeLock(path: string, includeUnrelated = false): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const skills: Record<string, Record<string, unknown>> = {
		"grill-me": {
			source: "mattpocock/skills",
			sourceType: "github",
			sourceUrl: "https://github.com/mattpocock/skills.git",
			skillPath: "skills/productivity/grill-me/SKILL.md",
			skillFolderHash: "hash-grill-me",
		},
		grilling: {
			source: "mattpocock/skills",
			sourceType: "github",
			sourceUrl: "https://github.com/mattpocock/skills.git",
			skillPath: "skills/productivity/grilling/SKILL.md",
			skillFolderHash: "hash-grilling",
		},
	};
	if (includeUnrelated) skills.officecli = { source: "local" };
	writeFileSync(path, JSON.stringify({ version: 3, skills }, null, 2));
}

function validInstall(home: string, state: string): void {
	const paths = getSkillSyncPaths(home, state);
	writeSkill(paths.skillPaths["grill-me"].pi, "grill-me");
	writeSkill(paths.skillPaths.grilling.pi, "grilling");
	writeLock(paths.lockPath);
}

const runner: SkillsCliRunner = {
	kind: "npx",
	command: "/usr/bin/npx",
	name: "npx",
	args: [
		"--yes",
		"skills@latest",
		"add",
		"mattpocock/skills",
		"--skill",
		"grill-me",
		"--skill",
		"grilling",
		"--agent",
		"pi",
		"--global",
		"--copy",
		"--yes",
	],
};

test("clean state plans an install with the fixed filtered argv", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.equal(plan.operation, "install");
		assert.deepEqual(plan.blockers, []);
		assert.equal(plan.paths.lockPath, join(state, "skills", ".skill-lock.json"));
		assert.deepEqual(plan.runner?.args, runner.args);
		assert.match(renderSkillSyncPlan(plan), /--agent pi --global --copy/);
	} finally {
		cleanup(home);
	}
});

test("valid pair plans the same filtered add command as a refresh", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		validInstall(home, state);
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.equal(plan.operation, "refresh");
		assert.deepEqual(plan.blockers, []);
	} finally {
		cleanup(home);
	}
});

test("partial state plans repair without treating missing files as a blocker", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me");
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.equal(plan.operation, "repair");
		assert.deepEqual(plan.blockers, []);
	} finally {
		cleanup(home);
	}
});

test("runner discovery falls back from npx to npm and reports no runner", () => {
	const home = makeHome();
	try {
		const bin = join(home, "bin");
		mkdirSync(bin);
		const npm = join(bin, "npm");
		writeFileSync(npm, "#!/bin/sh\nexit 0\n");
		chmodSync(npm, 0o755);
		const fallback = discoverRunner({ PATH: bin }, "linux");
		assert.equal(fallback?.kind, "npm");
		assert.deepEqual(fallback?.args, buildRunnerArgs("npm"));
		assert.equal(discoverRunner({ PATH: join(home, "missing") }, "linux"), undefined);
	} finally {
		cleanup(home);
	}
});

test("independent same-name resources are a blocker", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me");
		writeSkill(paths.skillPaths["grill-me"].agents, "grill-me");
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.equal(plan.blockers.length, 1);
		const blocker = plan.blockers[0];
		assert.ok(blocker);
		assert.match(blocker, /independent same-name skills/);
	} finally {
		cleanup(home);
	}
});

test("a symlinked canonical resource is not reported as a duplicate", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		writeSkill(paths.skillPaths["grill-me"].agents, "grill-me");
		mkdirSync(paths.piSkillsRoot, { recursive: true });
		symlinkSync(paths.skillPaths["grill-me"].agents, paths.skillPaths["grill-me"].pi);
		writeSkill(paths.skillPaths.grilling.pi, "grilling");
		writeLock(paths.lockPath);
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.deepEqual(plan.blockers, []);
		assert.equal(plan.operation, "refresh");
	} finally {
		cleanup(home);
	}
});

test("Windows runner discovery resolves npx.cmd with fixed arguments", () => {
	const home = makeHome();
	try {
		const bin = join(home, "bin");
		mkdirSync(bin);
		const npx = join(bin, "npx.cmd");
		const node = join(bin, "node.exe");
		const npxCli = join(bin, "node_modules", "npm", "bin", "npx-cli.js");
		writeFileSync(npx, "@echo off\r\n");
		writeFileSync(node, "node binary");
		mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
		writeFileSync(npxCli, "// npm CLI");
		chmodSync(npx, 0o755);
		chmodSync(node, 0o755);
		const discovered = discoverRunner({ Path: `"${bin}"` }, "win32");
		assert.equal(discovered?.kind, "npx");
		assert.equal(discovered?.command, node);
		assert.deepEqual(discovered?.prefixArgs, [npxCli]);
		assert.deepEqual(discovered?.args, buildRunnerArgs("npx"));
	} finally {
		cleanup(home);
	}
});

test("unsupported Node versions block before installer execution", () => {
	const home = makeHome();
	try {
		const plan = createSkillSyncPlan({ home, xdgStateHome: join(home, "state"), runner, nodeVersion: "22.19.0" });
		assert.match(plan.blockers.join("\n"), /22\.20\.0 or newer/);
	} finally {
		cleanup(home);
	}
});

test("a mutated runner is blocked instead of weakening the fixed argv contract", () => {
	const home = makeHome();
	try {
		const mutated: SkillsCliRunner = { ...runner, args: [...runner.args, "--all"] };
		const plan = createSkillSyncPlan({ home, xdgStateHome: join(home, "state"), runner: mutated });
		assert.match(plan.blockers.join("\n"), /fixed Pi-only argv contract/);
	} finally {
		cleanup(home);
	}
});

test("rendered plans remove terminal controls from dynamic paths", () => {
	const home = `${makeHome()}\u001b[31m\nspoof`;
	try {
		const plan = createSkillSyncPlan({ home, xdgStateHome: join(home, "state"), runner });
		const rendered = renderSkillSyncPlan(plan);
		assert.equal(rendered.includes("\u001b"), false);
		assert.doesNotMatch(rendered, /\nspoof\/.pi/);
	} finally {
		cleanup(home.split("\u001b", 1)[0] ?? home);
	}
});

test("a symlinked Pi skills root still participates in unrelated-entry validation", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		symlinkSync(paths.agentsSkillsRoot, paths.piSkillsRoot);
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me");
		writeSkill(paths.skillPaths.grilling.pi, "grilling");
		writeSkill(join(paths.piSkillsRoot, "officecli"), "officecli");
		writeLock(paths.lockPath);
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.equal(plan.before.rootEntries.pi.includes("officecli"), true);
		assert.equal(plan.operation, "refresh");
	} finally {
		cleanup(home);
	}
});

test("non-directory global skill roots block before the installer", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(paths.piSkillsRoot, "not a directory");
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.match(plan.blockers.join("\n"), /not a usable directory/);
	} finally {
		cleanup(home);
	}
});

test("a directory at the global lock path blocks before the installer", () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		mkdirSync(paths.lockPath, { recursive: true });
		const plan = createSkillSyncPlan({ home, xdgStateHome: state, runner });
		assert.match(plan.blockers.join("\n"), /not a usable lock file/);
	} finally {
		cleanup(home);
	}
});
