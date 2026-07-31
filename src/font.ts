/**
 * Font detection and installation.
 *
 * No version is hardcoded anywhere. Detection keys on the family name, which is
 * stable across releases; installation asks the GitHub API for whatever the
 * latest release currently is and matches the asset by pattern. A machine that
 * already has an older build is therefore left alone (detection is a local
 * check and issues no network request) rather than being churned to keep up
 * with upstream.
 */

import { spawn } from "node:child_process";
import { copyFileSync, type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FONT } from "./manifest.ts";
import { getFontInstallDir, getFontPlatform, getFontSearchDirs } from "./paths.ts";

const NETWORK_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, stdout: "", stderr: `cannot spawn ${command}` });
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});

		const settle = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};

		child.on("error", (error) => settle({ code: null, stdout, stderr: error.message }));
		child.on("close", (code) => settle({ code, stdout, stderr }));
	});
}

/** True when a directory tree contains a file whose name carries every hint fragment. */
function scanDirForFont(dir: string, hints: readonly string[], depth = 4): boolean {
	if (depth < 0 || !existsSync(dir)) return false;

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (scanDirForFont(full, hints, depth - 1)) return true;
			continue;
		}
		if (!entry.isFile()) continue;
		const name = entry.name.toLowerCase();
		if (!name.endsWith(".ttf") && !name.endsWith(".otf")) continue;
		if (hints.every((hint) => name.includes(hint))) return true;
	}

	return false;
}

/**
 * Is the font family already installed?
 *
 * Purely local: fc-list where available, otherwise a filename scan of the
 * platform font directories. Never touches the network, so an already-equipped
 * machine stays offline and keeps whatever version it has.
 */
export async function detectFont(): Promise<boolean> {
	const fontPlatform = getFontPlatform();
	if (fontPlatform === "win32" || fontPlatform === "unsupported") return false;

	if (fontPlatform === "linux") {
		const result = await runCommand("fc-list", [":", "family"], 15_000);
		if (result.code === 0 && result.stdout.toLowerCase().includes(FONT.family.toLowerCase())) {
			return true;
		}
		// A clean fc-list that does not report the family is NOT proof of absence:
		// fontconfig older than 2.13.94 ignores XDG_DATA_HOME, and a failed
		// fc-cache leaves installed files unindexed. Believing it would make the
		// font step permanently unsatisfiable, so the plan would never be empty and
		// every run would re-download 159 MB. Fall through to the disk scan.
	}

	return getFontSearchDirs().some((dir) => scanDirForFont(dir, FONT.fileHints));
}

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface LatestRelease {
	tag_name?: string;
	assets?: ReleaseAsset[];
}

/** Resolve the download URL for the matching asset of the CURRENT latest release. */
export async function resolveLatestAsset(): Promise<{ name: string; url: string; tag: string }> {
	const apiUrl = `https://api.github.com/repos/${FONT.repo}/releases/latest`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-preset",
	};

	const response = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`GitHub API returned ${response.status} for ${apiUrl}`);
	}

	const release = (await response.json()) as LatestRelease;
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const match = assets.find((asset) => typeof asset?.name === "string" && FONT.assetPattern.test(asset.name));
	if (!match) {
		throw new Error(
			`no asset matching ${String(FONT.assetPattern)} in the latest release (${assets.length} assets); ` +
				`install manually from ${FONT.releasesPage}`,
		);
	}

	return { name: match.name, url: match.browser_download_url, tag: release.tag_name ?? "latest" };
}

async function download(url: string, destination: string): Promise<void> {
	const response = await fetch(url, {
		headers: { "User-Agent": "pi-preset" },
		redirect: "follow",
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`download failed with ${response.status}: ${url}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	writeFileSync(destination, buffer);
}

/**
 * Extract a zip using system tools; no third-party dependency and no supply-chain layer.
 *
 * Order matters. GNU tar CANNOT read zip archives (verified: it reports that the
 * file does not look like a tar archive), so plain `tar` is only a last resort
 * for platforms where `tar` is actually bsdtar, which is the case on macOS.
 * bsdtar is tried by name first because it is the one portable zip-capable
 * fallback when unzip is absent.
 */
async function extractZip(archivePath: string, destination: string): Promise<void> {
	mkdirSync(destination, { recursive: true });

	const attempts: Array<{ command: string; args: string[] }> = [
		{ command: "unzip", args: ["-o", "-q", archivePath, "-d", destination] },
		{ command: "bsdtar", args: ["-xf", archivePath, "-C", destination] },
		{ command: "tar", args: ["-xf", archivePath, "-C", destination] },
	];

	const failures: string[] = [];
	for (const attempt of attempts) {
		const result = await runCommand(attempt.command, attempt.args);
		if (result.code === 0) return;
		const reason = result.stderr.trim().split("\n")[0] || `exit ${result.code}`;
		failures.push(`${attempt.command} (${reason})`);
	}

	throw new Error(`cannot extract ${archivePath}: ${failures.join(", ")}. Install unzip or bsdtar.`);
}

function collectTtfFiles(dir: string, depth = 4): string[] {
	if (depth < 0 || !existsSync(dir)) return [];

	const found: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...collectTtfFiles(full, depth - 1));
		} else if (entry.isFile() && /\.(ttf|otf)$/i.test(entry.name)) {
			found.push(full);
		}
	}

	return found;
}

export interface FontInstallResult {
	installed: boolean;
	message: string;
}

/** Instructions for platforms this package refuses to write fonts on. */
export function manualFontInstructions(): string {
	return [
		`Install ${FONT.family} manually:`,
		`  1. Open ${FONT.releasesPage}`,
		`  2. Download the asset matching ${String(FONT.assetPattern)}`,
		"  3. Extract it, select all .ttf files, right-click and choose Install",
		`  4. Set your terminal font to "${FONT.family}"`,
	].join("\n");
}

/**
 * Download and install the font. Only call after detectFont() returned false.
 *
 * Never writes on win32 or an unknown platform: it returns the manual steps
 * instead, so the "no font directory write attempted" guarantee holds.
 */
export async function installFont(): Promise<FontInstallResult> {
	const fontPlatform = getFontPlatform();
	if (fontPlatform === "win32" || fontPlatform === "unsupported") {
		return { installed: false, message: manualFontInstructions() };
	}

	const targetDir = getFontInstallDir(FONT.linuxDirName);
	if (!targetDir) {
		return { installed: false, message: manualFontInstructions() };
	}

	const asset = await resolveLatestAsset();
	const workDir = mkdtempSync(join(tmpdir(), "pi-preset-font-"));

	try {
		const archivePath = join(workDir, asset.name);
		await download(asset.url, archivePath);

		const extractDir = join(workDir, "extracted");
		await extractZip(archivePath, extractDir);

		const fontFiles = collectTtfFiles(extractDir);
		if (fontFiles.length === 0) {
			throw new Error(`no .ttf/.otf files inside ${asset.name}`);
		}

		mkdirSync(targetDir, { recursive: true });
		for (const file of fontFiles) {
			copyFileSync(file, join(targetDir, basename(file)));
		}

		let message = `installed ${fontFiles.length} font file(s) from ${asset.name} (${asset.tag}) into ${targetDir}`;

		if (fontPlatform === "linux") {
			const refresh = await runCommand("fc-cache", ["-f", targetDir]);
			if (refresh.code !== 0) {
				message += "; fc-cache failed, run it manually to refresh the font cache";
			}
		}

		message += `\nSet your terminal font to "${FONT.family}" to see the footer glyphs.`;
		return { installed: true, message };
	} finally {
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			// temp cleanup is best effort
		}
	}
}
