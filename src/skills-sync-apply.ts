import { spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_CAPTURED_OUTPUT_CHARS, redactSensitiveText, sanitizeTerminalText } from "./skills-sync-output.ts";
import {
	formatRunnerCommand,
	inspectSkillState,
	REQUIRED_SKILLS,
	runnerSpawnArgs,
	runnerUsesFixedContract,
	type SkillName,
	type SkillState,
	type SkillSyncPlan,
	validateSkillState,
} from "./skills-sync-plan.ts";

export const SKILLS_CLI_TIMEOUT_MS = 180_000;
export { MAX_CAPTURED_OUTPUT_CHARS };

export interface CommandRunOptions {
	cwd: string;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

export interface CommandRunResult {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, args: string[], options: CommandRunOptions) => Promise<CommandRunResult>;

function boundedAppend(current: string, chunk: string): string {
	if (current.length >= MAX_CAPTURED_OUTPUT_CHARS) return current;
	return current + chunk.slice(0, MAX_CAPTURED_OUTPUT_CHARS - current.length);
}

/** Remove terminal control sequences and cap untrusted installer output. */
export function sanitizeCliOutput(value: string): string {
	return sanitizeTerminalText(
		redactSensitiveText(sanitizeTerminalText(value, MAX_CAPTURED_OUTPUT_CHARS)),
		MAX_CAPTURED_OUTPUT_CHARS,
	);
}

export function createChildEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		DISABLE_TELEMETRY: "1",
		DO_NOT_TRACK: "1",
		npm_config_ignore_scripts: "true",
	};
}

/** Run the official CLI without a shell and with telemetry/lifecycle opt-outs. */
export const runExternalCommand: CommandRunner = (command, args, options) =>
	new Promise((resolvePromise) => {
		const useProcessGroup = process.platform !== "win32";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				detached: useProcessGroup,
				env: options.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolvePromise({
				code: 1,
				killed: false,
				stdout: "",
				stderr: sanitizeCliOutput(`cannot start ${command}: ${(error as Error).message}`),
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let closeCode: number | undefined;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;

		const signalProcessTree = (signal: NodeJS.Signals): void => {
			if (useProcessGroup && child.pid) {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// Fall back to the direct child when the process group is already gone.
				}
			}
			try {
				child.kill(signal);
			} catch {
				// The process already exited.
			}
		};

		const processTreeMayStillExist = (): boolean => {
			if (!useProcessGroup || !child.pid) return killed;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		const settle = (result: CommandRunResult): void => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillId) clearTimeout(forceKillId);
			resolvePromise({
				...result,
				stdout: sanitizeCliOutput(stdout),
				stderr: sanitizeCliOutput(stderr),
			});
		};

		const forceKill = (): void => {
			forceKillId = undefined;
			if (process.platform === "win32" && child.pid) {
				let taskkill: ReturnType<typeof spawn>;
				try {
					taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
						shell: false,
						stdio: "ignore",
						windowsHide: true,
					});
				} catch {
					signalProcessTree("SIGKILL");
					if (closeCode !== undefined) settle({ code: closeCode, killed: true, stdout, stderr });
					return;
				}
				const finish = (): void => {
					signalProcessTree("SIGKILL");
					if (closeCode !== undefined) settle({ code: closeCode, killed: true, stdout, stderr });
				};
				taskkill.once("error", finish);
				taskkill.once("close", finish);
				return;
			}
			signalProcessTree("SIGKILL");
			if (closeCode !== undefined) settle({ code: closeCode, killed: true, stdout, stderr });
		};

		const kill = (): void => {
			if (killed || settled) return;
			killed = true;
			signalProcessTree("SIGTERM");
			forceKillId = setTimeout(forceKill, 5_000);
			forceKillId.unref?.();
		};

		if (options.timeoutMs > 0) {
			timeoutId = setTimeout(kill, options.timeoutMs);
			timeoutId.unref?.();
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = boundedAppend(stdout, String(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = boundedAppend(stderr, String(chunk));
		});
		child.once("error", (error) => {
			stderr = boundedAppend(stderr, `cannot start ${command}: ${error.message}`);
			settle({ code: 1, killed, stdout, stderr });
		});
		child.once("close", (code) => {
			closeCode = code ?? 1;
			if (killed && forceKillId && processTreeMayStillExist()) return;
			settle({ code: closeCode, killed, stdout, stderr });
		});
	});

interface FollowedSymlinkSnapshot {
	targetPath: string;
	snapshotPath: string;
	present: boolean;
}

interface SnapshotEntry {
	originalPath: string;
	snapshotPath: string;
	present: boolean;
	followedSymlink?: FollowedSymlinkSnapshot;
}

interface RootSnapshot {
	path: string;
	existed: boolean;
	children: string[];
}

export interface SkillSyncSnapshot {
	tempDir: string;
	baseline: SkillState;
	entries: SnapshotEntry[];
	roots: RootSnapshot[];
}

interface SkillSyncLease {
	path: string;
	parentPath: string;
	parentExisted: boolean;
}

function copyResource(source: string, destination: string): void {
	const stats = lstatSync(source);
	mkdirSync(dirname(destination), { recursive: true });

	if (stats.isSymbolicLink()) {
		symlinkSync(readlinkSync(source), destination);
		try {
			lutimesSync(destination, stats.atime, stats.mtime);
		} catch {
			// Symlink timestamp preservation is not supported on every filesystem.
		}
		return;
	}
	if (stats.isDirectory()) {
		mkdirSync(destination, { recursive: true, mode: stats.mode & 0o7777 });
		for (const child of readdirSync(source)) copyResource(join(source, child), join(destination, child));
		chmodSync(destination, stats.mode & 0o7777);
		try {
			utimesSync(destination, stats.atime, stats.mtime);
		} catch {
			// Timestamp preservation is best effort on filesystems that reject it.
		}
		return;
	}
	if (stats.isFile()) {
		copyFileSync(source, destination);
		chmodSync(destination, stats.mode & 0o7777);
		try {
			utimesSync(destination, stats.atime, stats.mtime);
		} catch {
			// Timestamp preservation is best effort on filesystems that reject it.
		}
		return;
	}
	throw new Error(`cannot snapshot unsupported filesystem entry ${source}`);
}

function removeResource(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function rootSnapshot(path: string): RootSnapshot {
	if (!pathExists(path)) return { path, existed: false, children: [] };
	try {
		const children = readdirSync(path).sort();
		return { path, existed: true, children };
	} catch {
		return { path, existed: true, children: [] };
	}
}

function trackedPaths(plan: SkillSyncPlan): string[] {
	return [
		plan.paths.skillPaths["grill-me"].pi,
		plan.paths.skillPaths.grilling.pi,
		plan.paths.skillPaths["grill-me"].agents,
		plan.paths.skillPaths.grilling.agents,
		plan.paths.lockPath,
	];
}

function resolveSymlinkTarget(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const target = readlinkSync(path);
		return isAbsolute(target) ? target : resolve(dirname(path), target);
	}
}

function createSnapshotEntry(originalPath: string, snapshotPath: string, followSymlink: boolean): SnapshotEntry {
	const present = pathExists(originalPath);
	if (present) copyResource(originalPath, snapshotPath);
	const entry: SnapshotEntry = { originalPath, snapshotPath, present };

	if (present && followSymlink && lstatSync(originalPath).isSymbolicLink()) {
		const targetPath = resolveSymlinkTarget(originalPath);
		const targetSnapshotPath = `${snapshotPath}-target`;
		const targetPresent = pathExists(targetPath);
		if (targetPresent) copyResource(targetPath, targetSnapshotPath);
		entry.followedSymlink = { targetPath, snapshotPath: targetSnapshotPath, present: targetPresent };
	}

	return entry;
}

export function createSkillSyncSnapshot(plan: SkillSyncPlan, baseDir = tmpdir()): SkillSyncSnapshot {
	const tempDir = mkdtempSync(join(baseDir, "pi-preset-skills-sync-"));
	try {
		const entriesDir = join(tempDir, "entries");
		mkdirSync(entriesDir, { recursive: true });
		const entries = trackedPaths(plan).map((originalPath, index) =>
			createSnapshotEntry(originalPath, join(entriesDir, String(index)), originalPath === plan.paths.lockPath),
		);

		return {
			tempDir,
			baseline: inspectSkillState(plan.paths),
			entries,
			roots: [rootSnapshot(plan.paths.piSkillsRoot), rootSnapshot(plan.paths.agentsSkillsRoot)],
		};
	} catch (error) {
		removeResource(tempDir);
		throw error;
	}
}

export function restoreSkillSyncSnapshot(snapshot: SkillSyncSnapshot): void {
	for (const entry of snapshot.entries) {
		removeResource(entry.originalPath);
		if (entry.followedSymlink) {
			removeResource(entry.followedSymlink.targetPath);
			if (entry.followedSymlink.present) {
				copyResource(entry.followedSymlink.snapshotPath, entry.followedSymlink.targetPath);
			}
		}
		if (entry.present) copyResource(entry.snapshotPath, entry.originalPath);
	}

	for (const root of snapshot.roots) {
		if (!root.existed && pathExists(root.path)) {
			const stats = lstatSync(root.path);
			if (stats.isDirectory() && !stats.isSymbolicLink() && readdirSync(root.path).length === 0)
				removeResource(root.path);
			continue;
		}
		if (!root.existed) continue;
		if (!pathExists(root.path)) throw new Error(`rollback did not restore skill root ${root.path}`);
		const current = new Set(readdirSync(root.path));
		const missing = root.children.filter((child) => !current.has(child));
		if (missing.length > 0) {
			throw new Error(`rollback could not restore untracked resources in ${root.path}: ${missing.join(", ")}`);
		}
	}
}

export function disposeSkillSyncSnapshot(snapshot: SkillSyncSnapshot): void {
	try {
		removeResource(snapshot.tempDir);
	} catch {
		// The transaction result matters more than best-effort temp cleanup.
	}
}

function leaseOwnerIsAlive(path: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		if (!Number.isSafeInteger(pid) || pid <= 0) return true;
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function acquireSkillSyncLease(plan: SkillSyncPlan): SkillSyncLease {
	const path = `${plan.paths.lockPath}.pi-preset-sync.lock`;
	const parentPath = dirname(path);
	const parentExisted = pathExists(parentPath);
	mkdirSync(parentPath, { recursive: true });

	for (let attempt = 0; attempt < 2; attempt++) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, "wx", 0o600);
			writeFileSync(descriptor, `${process.pid}\n`, "utf8");
			const openDescriptor = descriptor;
			descriptor = undefined;
			closeSync(openDescriptor);
			return { path, parentPath, parentExisted };
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" && attempt === 0 && !leaseOwnerIsAlive(path)) {
				removeResource(path);
				continue;
			}
			if (!parentExisted && pathExists(parentPath) && readdirSync(parentPath).length === 0)
				removeResource(parentPath);
			if (code === "EEXIST") throw new Error(`another preset-skills-sync transaction is active (${path})`);
			throw new Error(`cannot create transaction lock ${path}: ${(error as Error).message}`);
		}
	}

	throw new Error(`cannot create transaction lock ${path}`);
}

function releaseSkillSyncLease(lease: SkillSyncLease): void {
	removeResource(lease.path);
	if (!lease.parentExisted && pathExists(lease.parentPath) && readdirSync(lease.parentPath).length === 0) {
		removeResource(lease.parentPath);
	}
}

export type SkillSyncStatus = "installed" | "updated" | "already-current";

export interface SkillSyncStatusEntry {
	name: SkillName;
	status: SkillSyncStatus;
}

export interface SkillSyncApplyResult {
	ok: boolean;
	changed: boolean;
	rollbackAttempted: boolean;
	rolledBack: boolean;
	operation: SkillSyncPlan["operation"];
	statuses: SkillSyncStatusEntry[];
	output: string;
	error?: string;
	recoveryCommand?: string;
	rollbackError?: string;
}

export interface ApplySkillSyncOptions {
	cwd?: string;
	timeoutMs?: number;
	run?: CommandRunner;
	tempBaseDir?: string;
}

function summarizeOutput(result: CommandRunResult): string {
	const text = sanitizeCliOutput(result.stderr || result.stdout).trim();
	if (!text) return "installer returned no diagnostic output";
	return text.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 600);
}

function statusFor(name: SkillName, before: SkillState, after: SkillState): SkillSyncStatusEntry {
	const beforeLocation = before.locations[name].pi;
	const afterLocation = after.locations[name].pi;
	if (!beforeLocation.present || !beforeLocation.skillFileExists) return { name, status: "installed" };
	if (beforeLocation.folderHash !== afterLocation.folderHash) return { name, status: "updated" };
	return { name, status: "already-current" };
}

function rollback(snapshot: SkillSyncSnapshot): string | undefined {
	try {
		restoreSkillSyncSnapshot(snapshot);
		return undefined;
	} catch (error) {
		return sanitizeCliOutput((error as Error).message);
	}
}

function failureResult(
	plan: SkillSyncPlan,
	error: string,
	output: string,
	rollbackAttempted: boolean,
	rollbackError?: string,
	includeRecovery = true,
): SkillSyncApplyResult {
	return {
		ok: false,
		changed: false,
		rollbackAttempted,
		rolledBack: rollbackAttempted && rollbackError === undefined,
		operation: plan.operation,
		statuses: [],
		output: sanitizeCliOutput(output),
		error: sanitizeCliOutput(error),
		recoveryCommand: includeRecovery && plan.runner ? formatRunnerCommand(plan.runner) : undefined,
		rollbackError,
	};
}

/** Apply the filtered CLI inside a filesystem transaction. */
export async function applySkillSync(
	plan: SkillSyncPlan,
	options: ApplySkillSyncOptions = {},
): Promise<SkillSyncApplyResult> {
	if (plan.blockers.length > 0) {
		return failureResult(plan, plan.blockers.join("; "), "not run", false, undefined, false);
	}
	if (!plan.runner)
		return failureResult(plan, "no usable skills CLI runner found", "not run", false, undefined, false);
	if (!runnerUsesFixedContract(plan.runner)) {
		return failureResult(
			plan,
			"skills CLI runner no longer matches the fixed Pi-only argv contract",
			"not run",
			false,
			undefined,
			false,
		);
	}

	let lease: SkillSyncLease;
	try {
		lease = acquireSkillSyncLease(plan);
	} catch (error) {
		return failureResult(plan, (error as Error).message, "not run", false, undefined, false);
	}

	let snapshot: SkillSyncSnapshot;
	try {
		snapshot = createSkillSyncSnapshot(plan, options.tempBaseDir);
	} catch (error) {
		try {
			releaseSkillSyncLease(lease);
		} catch {
			// The snapshot error is the actionable failure; a stale lease is reported on the next run.
		}
		return failureResult(
			plan,
			`cannot snapshot current skill state: ${(error as Error).message}`,
			"not run",
			false,
			undefined,
			false,
		);
	}

	try {
		const duplicateIssues = validateSkillState(plan.paths).issues.filter(
			(issue) => issue.code === "duplicate" || issue.code === "invalid-resource",
		);
		if (duplicateIssues.length > 0) {
			return failureResult(
				plan,
				duplicateIssues.map((issue) => issue.message).join("; "),
				"not run",
				false,
				undefined,
				false,
			);
		}

		const runner = options.run ?? runExternalCommand;
		const commandResult = await runner(plan.runner.command, runnerSpawnArgs(plan.runner), {
			cwd: options.cwd ?? process.cwd(),
			timeoutMs: options.timeoutMs ?? SKILLS_CLI_TIMEOUT_MS,
			env: createChildEnvironment(),
		});
		const output = summarizeOutput(commandResult);

		if (commandResult.code !== 0 || commandResult.killed) {
			const rollbackError = rollback(snapshot);
			return failureResult(
				plan,
				commandResult.killed
					? `skills CLI timed out or was terminated (${output})`
					: `skills CLI exited with code ${commandResult.code} (${output})`,
				output,
				true,
				rollbackError,
			);
		}

		const validation = validateSkillState(plan.paths, snapshot.baseline);
		if (!validation.valid) {
			const reason = validation.issues.map((issue) => issue.message).join("; ");
			const rollbackError = rollback(snapshot);
			return failureResult(plan, `post-install validation failed: ${reason}`, output, true, rollbackError);
		}

		const statuses = REQUIRED_SKILLS.map((name) => statusFor(name, snapshot.baseline, validation.state));
		return {
			ok: true,
			changed: statuses.some((entry) => entry.status !== "already-current"),
			rollbackAttempted: false,
			rolledBack: false,
			operation: plan.operation,
			statuses,
			output,
		};
	} catch (error) {
		const rollbackError = rollback(snapshot);
		return failureResult(
			plan,
			`skills CLI failed: ${(error as Error).message}`,
			"installer threw an error",
			true,
			rollbackError,
		);
	} finally {
		disposeSkillSyncSnapshot(snapshot);
		try {
			releaseSkillSyncLease(lease);
		} catch {
			// A stale lease is safer than overwriting the transaction result.
		}
	}
}

export function renderSkillSyncApplyResult(result: SkillSyncApplyResult): string {
	if (!result.ok) {
		const lines = [`preset-skills-sync: failed: ${sanitizeCliOutput(result.error ?? "unknown error")}`];
		if (result.rolledBack) lines.push("previous skill and lock state restored");
		else if (result.rollbackAttempted) lines.push("rollback was attempted but did not complete");
		if (result.rollbackError) lines.push(`rollback error: ${sanitizeCliOutput(result.rollbackError)}`);
		if (result.recoveryCommand) lines.push(`recovery command: ${sanitizeCliOutput(result.recoveryCommand)}`);
		return lines.join("\n");
	}

	const statuses = result.statuses.map((entry) => `${entry.name}: ${entry.status}`).join(", ");
	return `preset-skills-sync: ${statuses.replaceAll("already-current", "already current")}`;
}
