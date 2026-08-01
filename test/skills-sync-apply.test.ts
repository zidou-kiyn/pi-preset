import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPresetSkillsSync } from "../extensions/preset-skills-sync.ts";
import {
	applySkillSync,
	type CommandRunner,
	type CommandRunResult,
	MAX_CAPTURED_OUTPUT_CHARS,
	renderSkillSyncApplyResult,
	runExternalCommand,
	sanitizeCliOutput,
} from "../src/skills-sync-apply.ts";
import {
	createSkillSyncPlan,
	getSkillSyncPaths,
	type SkillSyncPaths,
	type SkillsCliRunner,
} from "../src/skills-sync-plan.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-apply-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function writeSkill(path: string, name: string, body = "Test skill.\n"): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(`${path}/SKILL.md`, `---\nname: ${name}\ndescription: test\n---\n\n${body}`);
}

function lockEntry(name: "grill-me" | "grilling"): Record<string, unknown> {
	return {
		source: "mattpocock/skills",
		sourceType: "github",
		sourceUrl: "https://github.com/mattpocock/skills.git",
		skillPath: `skills/productivity/${name}/SKILL.md`,
		skillFolderHash: `upstream-${name}`,
	};
}

function writeLock(path: string, includeUnrelated = false): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const skills: Record<string, Record<string, unknown>> = {
		"grill-me": lockEntry("grill-me"),
		grilling: lockEntry("grilling"),
	};
	if (includeUnrelated) skills.officecli = { source: "local", marker: "keep" };
	writeFileSync(path, JSON.stringify({ version: 3, skills }, null, 2));
}

function makeRunner(): SkillsCliRunner {
	return {
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
}

function makePlan(home: string, state: string) {
	return createSkillSyncPlan({ home, xdgStateHome: state, runner: makeRunner() });
}

function writeValidPair(home: string, state: string, includeUnrelated = false): SkillSyncPaths {
	const paths = getSkillSyncPaths(home, state);
	writeSkill(paths.skillPaths["grill-me"].pi, "grill-me", "original grill-me\n");
	writeSkill(paths.skillPaths.grilling.pi, "grilling", "original grilling\n");
	writeLock(paths.lockPath, includeUnrelated);
	return paths;
}

function readLock(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function successResult(changed: boolean): Awaited<ReturnType<typeof applySkillSync>> {
	return {
		ok: true,
		changed,
		rollbackAttempted: false,
		rolledBack: false,
		operation: "refresh",
		statuses: [
			{ name: "grill-me", status: changed ? "updated" : "already-current" },
			{ name: "grilling", status: changed ? "updated" : "already-current" },
		],
		output: "ok",
	};
}

function fakeInstall(paths: SkillSyncPaths, includeUnrelated = false): CommandRunner {
	return async (_command, _args, _options): Promise<CommandRunResult> => {
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me", "installed grill-me\n");
		writeSkill(paths.skillPaths.grilling.pi, "grilling", "installed grilling\n");
		writeLock(paths.lockPath, includeUnrelated);
		return { code: 0, killed: false, stdout: "Installation complete", stderr: "" };
	};
}

test("successful install uses the exact argv and privacy environment", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
		const paths = plan.paths;
		const run: CommandRunner = async (command, args, options) => {
			calls.push({ command, args, env: options.env });
			return fakeInstall(paths)(command, args, options);
		};

		const result = await applySkillSync(plan, { run, cwd: home, tempBaseDir: home });
		assert.equal(result.ok, true);
		assert.equal(result.changed, true);
		assert.deepEqual(
			result.statuses.map((entry) => entry.status),
			["installed", "installed"],
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, makeRunner().command);
		assert.deepEqual(calls[0]?.args, makeRunner().args);
		assert.equal(calls[0]?.env.DISABLE_TELEMETRY, "1");
		assert.equal(calls[0]?.env.DO_NOT_TRACK, "1");
		assert.equal(calls[0]?.env.npm_config_ignore_scripts, "true");
		assert.equal(calls[0]?.args.includes("--metadata"), false);
		assert.deepEqual(readdirSync(paths.piSkillsRoot).sort(), ["grill-me", "grilling"]);
	} finally {
		cleanup(home);
	}
});

test("installer diagnostics are sanitized and bounded", () => {
	const output = sanitizeCliOutput(`\u001b[31m${"x".repeat(MAX_CAPTURED_OUTPUT_CHARS + 100)}\u001b[0m`);
	assert.equal(output.length, MAX_CAPTURED_OUTPUT_CHARS);
	assert.equal(output.includes("\u001b"), false);
});

test("no-change refresh still uses filtered add and reports current content", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		writeValidPair(home, state);
		const plan = makePlan(home, state);
		let calls = 0;
		const result = await applySkillSync(plan, {
			cwd: home,
			tempBaseDir: home,
			run: async () => {
				calls++;
				return { code: 0, killed: false, stdout: "Already current", stderr: "" };
			},
		});
		assert.equal(calls, 1);
		assert.equal(result.ok, true);
		assert.equal(result.changed, false);
		assert.deepEqual(
			result.statuses.map((entry) => entry.status),
			["already-current", "already-current"],
		);
		assert.match(renderSkillSyncApplyResult(result), /already current/);
	} finally {
		cleanup(home);
	}
});

test("process failure restores tracked state without deleting untracked root entries", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = writeValidPair(home, state, true);
		chmodSync(paths.skillPaths["grill-me"].pi, 0o750);
		chmodSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`, 0o640);
		chmodSync(paths.lockPath, 0o600);
		const preservedTime = new Date(1_700_000_000_000);
		utimesSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`, preservedTime, preservedTime);
		utimesSync(paths.lockPath, preservedTime, preservedTime);
		writeSkill(join(paths.piSkillsRoot, "officecli"), "officecli", "keep me\n");
		const beforeSkill = readFileSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`, "utf8");
		const beforeOfficecli = readFileSync(join(paths.piSkillsRoot, "officecli", "SKILL.md"), "utf8");
		const beforeLock = readFileSync(paths.lockPath, "utf8");
		const plan = makePlan(home, state);

		const result = await applySkillSync(plan, {
			cwd: home,
			tempBaseDir: home,
			run: async () => {
				writeSkill(paths.skillPaths["grill-me"].pi, "grill-me", "partially changed\n");
				writeSkill(join(paths.piSkillsRoot, "unrelated"), "unrelated");
				writeFileSync(paths.lockPath, JSON.stringify({ version: 3, skills: { broken: {} } }));
				return { code: 17, killed: false, stdout: "partial", stderr: "network failed" };
			},
		});

		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.equal(readFileSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`, "utf8"), beforeSkill);
		assert.equal(readFileSync(paths.lockPath, "utf8"), beforeLock);
		assert.equal(readFileSync(join(paths.piSkillsRoot, "officecli", "SKILL.md"), "utf8"), beforeOfficecli);
		assert.equal(existsSync(join(paths.piSkillsRoot, "unrelated")), true);
		assert.equal(statSync(paths.skillPaths["grill-me"].pi).mode & 0o777, 0o750);
		assert.equal(statSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`).mode & 0o777, 0o640);
		assert.equal(statSync(paths.lockPath).mode & 0o777, 0o600);
		assert.equal(statSync(`${paths.skillPaths["grill-me"].pi}/SKILL.md`).mtimeMs, preservedTime.getTime());
		assert.equal(statSync(paths.lockPath).mtimeMs, preservedTime.getTime());
		assert.match(renderSkillSyncApplyResult(result), /recovery command: npx/);
	} finally {
		cleanup(home);
	}
});

test("validation failure restores the complete previous absent state", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, {
			cwd: home,
			tempBaseDir: home,
			run: async () => {
				writeSkill(plan.paths.skillPaths["grill-me"].pi, "grill-me");
				writeLock(plan.paths.lockPath);
				return { code: 0, killed: false, stdout: "complete", stderr: "" };
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.equal(existsSync(plan.paths.skillPaths["grill-me"].pi), false);
		assert.equal(existsSync(plan.paths.skillPaths.grilling.pi), false);
		assert.equal(existsSync(plan.paths.lockPath), false);
	} finally {
		cleanup(home);
	}
});

test("unrelated lock entries survive a successful refresh", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = writeValidPair(home, state, true);
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, {
			cwd: home,
			tempBaseDir: home,
			run: async () => {
				const lock = readLock(paths.lockPath);
				const skills = lock.skills as Record<string, unknown>;
				skills["grill-me"] = lockEntry("grill-me");
				skills.grilling = lockEntry("grilling");
				writeFileSync(paths.lockPath, JSON.stringify(lock, null, 2));
				return { code: 0, killed: false, stdout: "updated", stderr: "" };
			},
		});
		assert.equal(result.ok, true);
		const lock = readLock(paths.lockPath);
		assert.deepEqual((lock.skills as Record<string, unknown>).officecli, { source: "local", marker: "keep" });
	} finally {
		cleanup(home);
	}
});

test("unrelated lock mutations invalidate the transaction", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = writeValidPair(home, state, true);
		const beforeLock = readFileSync(paths.lockPath, "utf8");
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: async () => {
				const lock = readLock(paths.lockPath);
				(lock.skills as Record<string, Record<string, unknown>>).officecli.marker = "changed";
				writeFileSync(paths.lockPath, JSON.stringify(lock, null, 2));
				return { code: 0, killed: false, stdout: "updated", stderr: "" };
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.equal(readFileSync(paths.lockPath, "utf8"), beforeLock);
	} finally {
		cleanup(home);
	}
});

test("duplicate resources are rejected before the runner is called", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me");
		writeSkill(paths.skillPaths["grill-me"].agents, "grill-me");
		const plan = makePlan(home, state);
		let calls = 0;
		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: async () => {
				calls++;
				return { code: 0, killed: false, stdout: "", stderr: "" };
			},
		});
		assert.equal(calls, 0);
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, false);
	} finally {
		cleanup(home);
	}
});

test("declining confirmation performs no apply call", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		let applyCalls = 0;
		const notifications: string[] = [];
		const ctx = {
			hasUI: true,
			mode: "tui",
			cwd: home,
			ui: {
				confirm: async () => false,
				notify: (message: string) => notifications.push(message),
			},
		};
		await runPresetSkillsSync(ctx as never, {
			createPlan: () => plan,
			apply: async () => {
				applyCalls++;
				return successResult(true);
			},
		});
		assert.equal(applyCalls, 0);
		assert.match(notifications.join("\n"), /cancelled/);
	} finally {
		cleanup(home);
	}
});

test("changed content is reported before reload", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		const events: string[] = [];
		let reloads = 0;
		const ctx = {
			hasUI: true,
			mode: "rpc",
			cwd: home,
			ui: {
				confirm: async () => true,
				notify: (message: string) => events.push(message),
			},
			reload: async () => {
				reloads++;
				events.push("reload");
			},
		};
		await runPresetSkillsSync(ctx as never, {
			createPlan: () => plan,
			apply: async () => successResult(true),
		});
		assert.equal(reloads, 1);
		assert.equal(events.at(-1), "reload");
		const firstEvent = events[0];
		assert.ok(firstEvent);
		assert.match(firstEvent, /grill-me: updated/);
	} finally {
		cleanup(home);
	}
});

test("terminal sanitization removes CSI, OSC, carriage returns, and bidi controls", () => {
	const output = sanitizeCliOutput("before\u001b[31mred\u001b[0m\u001b]52;c;secret\u0007后\rline\u202e");
	assert.equal(output, "beforered后\nline");
});

test("snapshot failure is reported and releases the transaction lease", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, { tempBaseDir: join(home, "missing", "nested") });
		assert.equal(result.ok, false);
		assert.equal(result.rollbackAttempted, false);
		assert.match(result.error ?? "", /cannot snapshot current skill state/);
		assert.equal(existsSync(`${plan.paths.lockPath}.pi-preset-sync.lock`), false);
	} finally {
		cleanup(home);
	}
});

test("a lock symlink and its target content are restored after failure", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = getSkillSyncPaths(home, state);
		writeSkill(paths.skillPaths["grill-me"].pi, "grill-me", "original grill-me\n");
		writeSkill(paths.skillPaths.grilling.pi, "grilling", "original grilling\n");
		const lockTarget = join(home, "managed", "skill-lock.json");
		writeLock(lockTarget, true);
		mkdirSync(join(paths.lockPath, ".."), { recursive: true });
		symlinkSync(lockTarget, paths.lockPath);
		const beforeTarget = readFileSync(lockTarget, "utf8");
		const plan = makePlan(home, state);

		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: async () => {
				writeFileSync(paths.lockPath, JSON.stringify({ version: 3, skills: { broken: {} } }));
				return { code: 9, killed: false, stdout: "", stderr: "failed" };
			},
		});

		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.equal(lstatSync(paths.lockPath).isSymbolicLink(), true);
		assert.equal(readlinkSync(paths.lockPath), lockTarget);
		assert.equal(readFileSync(lockTarget, "utf8"), beforeTarget);
	} finally {
		cleanup(home);
	}
});

test("concurrent preset transactions are rejected before a second runner starts", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		let releaseFirst: (() => void) | undefined;
		let signalStarted: (() => void) | undefined;
		const started = new Promise<void>((resolveStarted) => {
			signalStarted = resolveStarted;
		});
		const gate = new Promise<void>((resolveGate) => {
			releaseFirst = resolveGate;
		});
		const first = applySkillSync(plan, {
			tempBaseDir: home,
			run: async (command, args, options) => {
				signalStarted?.();
				await gate;
				return fakeInstall(plan.paths)(command, args, options);
			},
		});
		await started;

		let secondCalls = 0;
		const second = await applySkillSync(plan, {
			tempBaseDir: home,
			run: async () => {
				secondCalls++;
				return { code: 0, killed: false, stdout: "", stderr: "" };
			},
		});
		assert.equal(second.ok, false);
		assert.equal(secondCalls, 0);
		assert.match(second.error ?? "", /transaction is active/);
		assert.equal(second.recoveryCommand, undefined);

		releaseFirst?.();
		assert.equal((await first).ok, true);
	} finally {
		cleanup(home);
	}
});

test("print and JSON modes never invoke apply or reload", async () => {
	const home = makeHome();
	const originalLog = console.log;
	const originalError = console.error;
	console.log = () => {};
	console.error = () => {};
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		for (const mode of ["print", "json"] as const) {
			let applyCalls = 0;
			let reloads = 0;
			const ctx = {
				hasUI: false,
				mode,
				cwd: home,
				ui: {},
				reload: async () => {
					reloads++;
				},
			};
			await runPresetSkillsSync(ctx as never, {
				createPlan: () => plan,
				apply: async () => {
					applyCalls++;
					return successResult(true);
				},
			});
			assert.equal(applyCalls, 0);
			assert.equal(reloads, 0);
		}
	} finally {
		console.log = originalLog;
		console.error = originalError;
		cleanup(home);
	}
});

test("plan and apply exceptions are reported instead of escaping the command", async () => {
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui: {
			confirm: async () => true,
			notify: (message: string) => notifications.push(message),
		},
		reload: async () => {},
	};
	await runPresetSkillsSync(ctx as never, {
		createPlan: () => {
			throw new Error("bad\u001b[31m plan");
		},
	});
	assert.match(notifications.at(-1) ?? "", /bad plan/);
	assert.equal((notifications.at(-1) ?? "").includes("\u001b"), false);

	const home = makeHome();
	try {
		const plan = makePlan(home, join(home, "state"));
		await runPresetSkillsSync(ctx as never, {
			createPlan: () => plan,
			apply: async () => {
				throw new Error("apply exploded");
			},
		});
		assert.match(notifications.at(-1) ?? "", /apply exploded/);
	} finally {
		cleanup(home);
	}
});

test("already-current content does not reload resources", async () => {
	const home = makeHome();
	try {
		const plan = makePlan(home, join(home, "state"));
		let reloads = 0;
		const ctx = {
			hasUI: true,
			mode: "rpc",
			cwd: home,
			ui: { confirm: async () => true, notify: () => {} },
			reload: async () => {
				reloads++;
			},
		};
		await runPresetSkillsSync(ctx as never, {
			createPlan: () => plan,
			apply: async () => successResult(false),
		});
		assert.equal(reloads, 0);
	} finally {
		cleanup(home);
	}
});

test("timed-out commands terminate descendant processes before returning", async () => {
	if (process.platform === "win32") return;
	const home = makeHome();
	try {
		const marker = join(home, "late-write");
		const childScript = `import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "late"), 600); setInterval(() => {}, 1000);`;
		const parentScript = `import { spawn } from "node:child_process"; spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
		const result = await runExternalCommand(process.execPath, ["--input-type=module", "-e", parentScript], {
			cwd: home,
			timeoutMs: 100,
			env: process.env,
		});
		assert.equal(result.killed, true);
		await new Promise((resolveWait) => setTimeout(resolveWait, 900));
		assert.equal(existsSync(marker), false);
	} finally {
		cleanup(home);
	}
});

test("an invalid installed description fails validation and rolls back", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: async () => {
				mkdirSync(plan.paths.skillPaths["grill-me"].pi, { recursive: true });
				writeFileSync(
					join(plan.paths.skillPaths["grill-me"].pi, "SKILL.md"),
					"---\nname: grill-me\ndescription:\n---\n",
				);
				writeSkill(plan.paths.skillPaths.grilling.pi, "grilling");
				writeLock(plan.paths.lockPath);
				return { code: 0, killed: false, stdout: "done", stderr: "" };
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.match(result.error ?? "", /has no description/);
		assert.equal(existsSync(plan.paths.skillPaths["grill-me"].pi), false);
	} finally {
		cleanup(home);
	}
});

test("rollback failure reporting does not claim restoration", () => {
	const message = renderSkillSyncApplyResult({
		ok: false,
		changed: false,
		rollbackAttempted: true,
		rolledBack: false,
		operation: "repair",
		statuses: [],
		output: "failed",
		error: "installer failed",
		rollbackError: "permission denied",
	});
	assert.match(message, /rollback was attempted but did not complete/);
	assert.doesNotMatch(message, /state restored/);
});

test("apply rechecks the fixed argv contract after confirmation", async () => {
	const home = makeHome();
	try {
		const plan = makePlan(home, join(home, "state"));
		plan.runner?.args.push("--all");
		let calls = 0;
		const result = await applySkillSync(plan, {
			run: async () => {
				calls++;
				return { code: 0, killed: false, stdout: "", stderr: "" };
			},
		});
		assert.equal(result.ok, false);
		assert.equal(calls, 0);
		assert.match(result.error ?? "", /fixed Pi-only argv contract/);
	} finally {
		cleanup(home);
	}
});

test("installer diagnostics redact common credential forms", () => {
	const output = sanitizeCliOutput(
		"https://user:secret@example.com GITHUB_TOKEN=supersecretvalue Bearer abcdefghijklmnop ghp_abcdefghijklmnop",
	);
	assert.equal(output.includes("secret"), false);
	assert.equal(output.includes("abcdefghijklmnop"), false);
	assert.match(output, /\[redacted\]/);
});

test("a stale transaction lease is recovered automatically", async () => {
	const home = makeHome();
	try {
		const plan = makePlan(home, join(home, "state"));
		const leasePath = `${plan.paths.lockPath}.pi-preset-sync.lock`;
		mkdirSync(join(leasePath, ".."), { recursive: true });
		writeFileSync(leasePath, "999999999\n");
		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: fakeInstall(plan.paths),
		});
		assert.equal(result.ok, true);
		assert.equal(existsSync(leasePath), false);
	} finally {
		cleanup(home);
	}
});

test("changed refresh updates both skills and their upstream lock hashes", async () => {
	const home = makeHome();
	try {
		const state = join(home, "state");
		const paths = writeValidPair(home, state);
		const beforeLock = readLock(paths.lockPath);
		for (const entry of Object.values(beforeLock.skills as Record<string, Record<string, unknown>>)) {
			entry.skillFolderHash = "old-upstream-hash";
		}
		writeFileSync(paths.lockPath, JSON.stringify(beforeLock, null, 2));
		const plan = makePlan(home, state);
		const result = await applySkillSync(plan, {
			tempBaseDir: home,
			run: fakeInstall(paths),
		});
		assert.equal(result.ok, true);
		assert.equal(result.changed, true);
		assert.deepEqual(
			result.statuses.map((entry) => entry.status),
			["updated", "updated"],
		);
		const afterSkills = (readLock(paths.lockPath).skills ?? {}) as Record<string, Record<string, unknown>>;
		assert.equal(afterSkills["grill-me"]?.skillFolderHash, "upstream-grill-me");
		assert.equal(afterSkills.grilling?.skillFolderHash, "upstream-grilling");
	} finally {
		cleanup(home);
	}
});
