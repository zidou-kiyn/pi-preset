/**
 * Install and run the vendored termius-mcp (Python) for pi.
 *
 * The server lives in vendor/termius-mcp. It is installed into its own
 * virtual environment under <agent dir>/termius-mcp/venv, outside the preset
 * checkout so `pi update` never touches it. uv creates the environment and
 * fetches a Python when the machine has none, which is what makes the setup
 * one step on Linux, macOS, and Windows; without uv a local python3 (3.9+)
 * with venv/pip is used.
 *
 * installed.json records a hash of the vendored source. When the preset
 * updates the vendored code, the next session reinstalls it.
 */

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../paths.ts";
import { type ApprovalMode, DEFAULT_APPROVAL_MODE, isApprovalMode } from "./approval.ts";
import type { ProxySettings } from "./proxy.ts";

const PRESET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR_DIR = join(PRESET_ROOT, "vendor", "termius-mcp");
const IS_WINDOWS = platform() === "win32";

export function installDir(): string {
	return join(getAgentDir(), "termius-mcp");
}

export function venvDir(): string {
	return join(installDir(), "venv");
}

export function serverBinary(): string {
	return IS_WINDOWS ? join(venvDir(), "Scripts", "termius.exe") : join(venvDir(), "bin", "termius");
}

function venvPython(): string {
	return IS_WINDOWS ? join(venvDir(), "Scripts", "python.exe") : join(venvDir(), "bin", "python");
}

function stampPath(): string {
	return join(installDir(), "installed.json");
}

function configPath(): string {
	return join(installDir(), "config.json");
}

// ── source hash ─────────────────────────────────────────────────────────────

/** Build output and tests: never part of the hash or the staged copy. */
function isSkipped(name: string): boolean {
	return name === "__pycache__" || name.endsWith(".egg-info") || name === "tests" || name === "build" || name === "dist";
}

function sourceFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (isSkipped(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path, base));
		else if (/\.(py|toml|cfg|in)$/.test(entry.name) || entry.name === "setup.py") out.push(relative(base, path));
	}
	return out.sort();
}

/** Hash of everything that ends up in the installed package. */
export function sourceHash(dir = VENDOR_DIR): string {
	const hash = createHash("sha256");
	for (const file of sourceFiles(dir)) {
		hash.update(file.replace(/\\/g, "/"));
		hash.update("\0");
		hash.update(readFileSync(join(dir, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export type InstallState = "missing" | "outdated" | "current";

export function installState(): InstallState {
	if (!existsSync(serverBinary())) return "missing";
	try {
		const stamp = JSON.parse(readFileSync(stampPath(), "utf8"));
		return stamp.sourceHash === sourceHash() ? "current" : "outdated";
	} catch {
		return "outdated";
	}
}

// ── tools: uv or python ─────────────────────────────────────────────────────

function runs(command: string, args: string[]): boolean {
	const result = spawnSync(command, args, { stdio: "ignore", timeout: 15_000, windowsHide: true });
	return result.status === 0;
}

/** uv on PATH or in its default install locations. */
export function findUv(): string | undefined {
	const candidates = [
		"uv",
		join(homedir(), ".local", "bin", IS_WINDOWS ? "uv.exe" : "uv"),
		join(homedir(), ".cargo", "bin", IS_WINDOWS ? "uv.exe" : "uv"),
	];
	return candidates.find((candidate) => runs(candidate, ["--version"]));
}

/** A python3 >= 3.9 with venv, for machines without uv. */
export function findPython(): string | undefined {
	const candidates = IS_WINDOWS ? ["py", "python", "python3"] : ["python3", "python"];
	const check = "import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 9) else 1)";
	return candidates.find((candidate) => runs(candidate, IS_WINDOWS && candidate === "py" ? ["-3", "-c", check] : ["-c", check]));
}

/** The official uv installer command for this OS (astral.sh). */
export function uvInstallerCommand(): { command: string; args: string[]; display: string } {
	if (IS_WINDOWS) {
		const script = "irm https://astral.sh/uv/install.ps1 | iex";
		return {
			command: "powershell",
			args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", script],
			display: `powershell -ExecutionPolicy ByPass -c "${script}"`,
		};
	}
	const script = "curl -LsSf https://astral.sh/uv/install.sh | sh";
	return { command: "sh", args: ["-c", script], display: script };
}

// ── process helper ──────────────────────────────────────────────────────────

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export function run(command: string, args: string[], options: SpawnOptions & { input?: string } = {}): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const { input, ...spawnOptions } = options;
		const child = spawn(command, args, { windowsHide: true, ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
		});
		child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
		child.stdin?.end(input ?? "");
	});
}

function lastLines(text: string, count = 8): string {
	return text.trim().split("\n").slice(-count).join("\n");
}

// ── install ─────────────────────────────────────────────────────────────────

export interface InstallOptions {
	/** Progress lines for the UI. */
	log?: (line: string) => void;
}

/**
 * Create or refresh the virtual environment and install the vendored server.
 * Throws with the tail of the failing tool's output.
 */
export async function install(options: InstallOptions = {}): Promise<void> {
	const log = options.log ?? (() => {});
	mkdirSync(installDir(), { recursive: true });
	// setuptools builds in the source tree (build/, *.egg-info). Build from a
	// staged copy so the preset checkout stays untouched.
	const source = join(installDir(), "src");
	rmSync(source, { recursive: true, force: true });
	cpSync(VENDOR_DIR, source, { recursive: true, filter: (path) => !isSkipped(path.split(/[\\/]/).pop() ?? "") });
	const uv = findUv();
	const step = async (label: string, command: string, args: string[]) => {
		log(label);
		const result = await run(command, args);
		if (result.code !== 0) throw new Error(`${label} failed:\n${lastLines(result.stderr || result.stdout)}`);
	};

	if (uv) {
		await step("Creating the Python environment (uv)", uv, ["venv", "--quiet", "--allow-existing", "--python", "3.12", venvDir()]);
		// --refresh-package: uv caches the wheel it built from a local directory
		// and would reuse it after a .py-only change.
		await step("Installing termius-mcp", uv, [
			"pip",
			"install",
			"--quiet",
			"--python",
			venvPython(),
			"--reinstall-package",
			"termius-mcp",
			"--refresh-package",
			"termius-mcp",
			source,
		]);
	} else {
		const python = findPython();
		if (!python) {
			throw new Error(`Neither uv nor Python 3.9+ was found. Install uv with:\n  ${uvInstallerCommand().display}`);
		}
		const pyArgs = IS_WINDOWS && python === "py" ? ["-3"] : [];
		if (!existsSync(venvPython())) await step("Creating the Python environment (venv)", python, [...pyArgs, "-m", "venv", venvDir()]);
		await step("Installing termius-mcp", venvPython(), ["-m", "pip", "install", "--quiet", "--upgrade", "--force-reinstall", "--no-deps", source]);
		await step("Installing dependencies", venvPython(), ["-m", "pip", "install", "--quiet", source]);
	}
	if (!existsSync(serverBinary())) throw new Error(`Install finished but ${serverBinary()} is missing`);
	writeFileSync(stampPath(), `${JSON.stringify({ sourceHash: sourceHash(), installedAt: new Date().toISOString() }, null, 2)}\n`);
}

export async function installUv(): Promise<void> {
	const installer = uvInstallerCommand();
	const result = await run(installer.command, installer.args);
	if (result.code !== 0) throw new Error(`uv installer failed:\n${lastLines(result.stderr || result.stdout)}`);
	if (!findUv()) throw new Error("uv was installed but is not on PATH yet; restart the terminal and run /termius setup again.");
}

// ── login bridge ────────────────────────────────────────────────────────────

export interface LoginResponse {
	ok: boolean;
	code?:
		| "otp_required"
		| "approve_required"
		| "invalid_request"
		| "login_failed"
		| "not_signed_in"
		| "vault_password_required"
		| "sync_failed";
	error?: string;
	[key: string]: unknown;
}

/**
 * Send one request to `termius login-json`. Credentials travel on the child's
 * stdin only: not in argv, not in the environment, never through the model.
 */
export async function loginJson(request: Record<string, unknown>): Promise<LoginResponse> {
	const result = await run(serverBinary(), ["login-json"], { input: JSON.stringify(request) });
	const line = result.stdout.trim().split("\n").pop() ?? "";
	try {
		return JSON.parse(line) as LoginResponse;
	} catch {
		return { ok: false, code: "login_failed", error: lastLines(result.stderr) || `termius exited with ${result.code}` };
	}
}

// ── config ──────────────────────────────────────────────────────────────────

export interface TermiusConfig extends ProxySettings {
	mode: ApprovalMode;
}

export function readConfig(): TermiusConfig {
	try {
		const data = JSON.parse(readFileSync(configPath(), "utf8"));
		const config: TermiusConfig = { mode: isApprovalMode(data.mode) ? data.mode : DEFAULT_APPROVAL_MODE };
		if (typeof data.proxy === "string" && data.proxy.trim()) config.proxy = data.proxy.trim();
		if (Array.isArray(data.proxyBypass)) config.proxyBypass = data.proxyBypass.filter((item: unknown) => typeof item === "string");
		return config;
	} catch {
		return { mode: DEFAULT_APPROVAL_MODE };
	}
}

export function writeConfig(config: TermiusConfig): void {
	mkdirSync(installDir(), { recursive: true });
	// 0600: a proxy URL can carry a password.
	writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(configPath(), 0o600);
}

/** Size check used by tests and status: is the vendored tree present at all. */
export function vendorPresent(): boolean {
	try {
		return statSync(join(VENDOR_DIR, "setup.py")).isFile();
	} catch {
		return false;
	}
}
