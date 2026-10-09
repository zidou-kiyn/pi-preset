#!/usr/bin/env node
/**
 * Cut a release: bump package.json, commit "release: vX.Y.Z", tag vX.Y.Z.
 *
 *   npm run release -- patch|minor|major|X.Y.Z [--skip-tests]
 *
 * Refuses with uncommitted changes or an existing tag. Runs `npm test` first.
 * Never pushes: `git push --follow-tags` afterwards.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

export function nextVersion(current, bump) {
	if (/^\d+\.\d+\.\d+$/u.test(bump)) return bump;
	const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(current);
	if (!match) throw new Error(`package.json version "${current}" is not X.Y.Z`);
	const [major, minor, patch] = match.slice(1).map(Number);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
	throw new Error(`Unknown bump "${bump}". Use patch, minor, major, or X.Y.Z.`);
}

function main(argv) {
	const bump = argv.find((arg) => !arg.startsWith("--"));
	if (!bump) throw new Error("Usage: npm run release -- patch|minor|major|X.Y.Z [--skip-tests]");
	if (git("status", "--porcelain")) throw new Error("Uncommitted changes; commit or stash them first.");

	const text = readFileSync(PKG, "utf8");
	const current = JSON.parse(text).version;
	const version = nextVersion(current, bump);
	const tag = `v${version}`;
	if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists.`);

	const last = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0];
	const log = git("log", "--oneline", "--no-merges", last ? `${last}..HEAD` : "HEAD");

	if (!argv.includes("--skip-tests")) execFileSync("npm", ["test"], { cwd: ROOT, stdio: "inherit" });

	// Replace only the version line so the file's formatting is kept.
	const updated = text.replace(/("version"\s*:\s*")[^"]*(")/u, `$1${version}$2`);
	if (updated === text && current !== version) throw new Error("Could not find the version field in package.json.");
	writeFileSync(PKG, updated);
	git("add", "package.json");
	git("commit", "-m", `release: ${tag}`, "--allow-empty");
	git("tag", "-a", tag, "-m", `${tag}\n\n${log}`);

	console.log(`\n${current} -> ${version}, tagged ${tag}${last ? ` (changes since ${last}):` : ":"}\n${log || "(no commits)"}`);
	console.log("\nPush with: git push --follow-tags");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
