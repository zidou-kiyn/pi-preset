#!/usr/bin/env node
/**
 * upstream.mjs — track the upstream repositories of vendored extensions.
 *
 * Every directory under vendor/ is a copy of an upstream package at a recorded
 * commit (vendor/UPSTREAM.json). This script fetches upstream into a cache and
 * reports or merges what changed since that commit. It never commits: review
 * the working tree with `git diff` and commit yourself.
 *
 *   node scripts/upstream.mjs status [name...]      new upstream commits since the vendored one
 *   node scripts/upstream.mjs diff <name> [--to REV] upstream diff, base..REV (default: tracked head)
 *   node scripts/upstream.mjs pull <name> [--to REV] three-way merge upstream changes into vendor/<name>
 *   node scripts/upstream.mjs import <name> [--force] copy upstream at the recorded commit (fresh vendor)
 *   node scripts/upstream.mjs check [name...]       compare vendor/ with upstream at the recorded commit
 *
 * `pull` merges file by file with `git merge-file` (base = upstream at the
 * recorded commit, ours = vendor file, theirs = upstream at REV). Files edited
 * only upstream are replaced, files edited on both sides get conflict markers,
 * and the recorded commit moves to REV. Conflicts are listed at the end.
 *
 * The clone cache lives in $PI_PRESET_UPSTREAM_CACHE or ~/.cache/pi-preset-upstream.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "vendor", "UPSTREAM.json");
const CACHE = process.env.PI_PRESET_UPSTREAM_CACHE ?? join(homedir(), ".cache", "pi-preset-upstream");

// ── manifest ────────────────────────────────────────────────────────────────

function loadManifest() {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function saveManifest(manifest) {
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function entryOf(manifest, name) {
	const entry = manifest.packages[name];
	if (!entry) {
		const known = Object.keys(manifest.packages).join(", ");
		throw new Error(`unknown vendored package "${name}" (known: ${known})`);
	}
	return entry;
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(cwd, args, options = {}) {
	return execFileSync("git", args, {
		cwd,
		encoding: options.buffer ? "buffer" : "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function cloneDir(entry) {
	return join(CACHE, entry.repo.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_"));
}

const fetched = new Set();

/**
 * Clone (bare, blobless) or fetch the upstream repository; once per process.
 * With `offline`, an existing clone that already has the recorded commit is
 * used as is (check / import only need that commit).
 */
function ensureClone(entry, { offline = false } = {}) {
	const dir = cloneDir(entry);
	if (fetched.has(dir)) return dir;
	if (offline && existsSync(join(dir, "HEAD"))) {
		const has = spawnSync("git", ["cat-file", "-e", `${entry.commit}^{commit}`], { cwd: dir });
		if (has.status === 0) return dir;
	}
	if (!existsSync(join(dir, "HEAD"))) {
		mkdirSync(dirname(dir), { recursive: true });
		execFileSync("git", ["clone", "--quiet", "--bare", "--filter=blob:none", entry.repo, dir], { stdio: "inherit" });
	} else {
		execFileSync("git", ["fetch", "--quiet", "--tags", "--force", "origin", "+refs/heads/*:refs/heads/*"], {
			cwd: dir,
			stdio: "inherit",
		});
	}
	fetched.add(dir);
	return dir;
}

function revParse(dir, rev) {
	return git(dir, ["rev-parse", `${rev}^{commit}`]).trim();
}

/** The upstream revision this package follows: newest matching tag, or a branch head. */
function trackedHead(dir, entry) {
	if (entry.track?.tags) {
		const tags = git(dir, ["tag", "--list", entry.track.tags, "--sort=-version:refname"]).split("\n").filter(Boolean);
		if (tags.length === 0) throw new Error(`no tags match ${entry.track.tags}`);
		return { rev: tags[0], commit: revParse(dir, tags[0]) };
	}
	const branch = entry.track?.branch ?? "main";
	return { rev: branch, commit: revParse(dir, branch) };
}

// ── file selection ──────────────────────────────────────────────────────────

/** Minimal glob: `**` spans directories, `*` stays inside one segment. */
export function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				out += "(?:.*/)?";
			} else {
				out += ".*";
			}
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

function selector(entry) {
	const include = (entry.include ?? ["**"]).map(globToRegExp);
	const exclude = (entry.exclude ?? []).map(globToRegExp);
	return (rel) => include.some((re) => re.test(rel)) && !exclude.some((re) => re.test(rel));
}

/**
 * Files of one upstream package at a commit, as Map<vendorRelativePath, upstreamPath>.
 * `rootFiles` pulls repository-root files (a monorepo LICENSE) into the package.
 */
function upstreamFiles(dir, entry, commit) {
	const prefix = entry.path ? `${entry.path.replace(/\/$/, "")}/` : "";
	const pick = selector(entry);
	const files = new Map();
	const oids = [];
	const lsTree = (pathspec, recursive) =>
		git(dir, ["ls-tree", ...(recursive ? ["-r"] : []), commit, "--", pathspec])
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [meta, full] = line.split("\t");
				return { oid: meta.split(" ")[2], full };
			});
	for (const { oid, full } of lsTree(prefix || ".", true)) {
		const rel = full.slice(prefix.length);
		if (!pick(rel)) continue;
		files.set(rel, full);
		oids.push(oid);
	}
	for (const rootFile of entry.rootFiles ?? []) {
		if (files.has(rootFile)) continue;
		for (const { oid, full } of lsTree(rootFile, false)) {
			files.set(rootFile, full);
			oids.push(oid);
		}
	}
	prefetch(dir, oids);
	return files;
}

/**
 * The cache is a blobless clone, and reading a missing blob would fetch it
 * alone. Fetch every missing one in a single request instead.
 */
function prefetch(dir, oids) {
	if (oids.length === 0) return;
	const check = spawnSync("git", ["cat-file", "--batch-check"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
		encoding: "utf8",
		env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
		maxBuffer: 64 * 1024 * 1024,
	});
	const missing = check.stdout
		.split("\n")
		.filter((line) => line.endsWith(" missing"))
		.map((line) => line.split(" ")[0]);
	if (missing.length === 0) return;
	const fetch = spawnSync(
		"git",
		["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", "--stdin"],
		{ cwd: dir, input: `${missing.join("\n")}\n`, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] },
	);
	if (fetch.status !== 0) throw new Error(`fetching ${missing.length} upstream blob(s) failed`);
}

function blob(dir, commit, path) {
	return git(dir, ["show", `${commit}:${path}`], { buffer: true });
}

function destOf(entry) {
	return join(ROOT, entry.dest);
}

/** Files under a vendor dir that git tracks or would track (ignored build output excluded). */
function listFiles(root) {
	if (!existsSync(root)) return [];
	const rel = root.slice(ROOT.length + 1);
	return git(ROOT, ["ls-files", "--cached", "--others", "--exclude-standard", "--", rel])
		.split("\n")
		.filter(Boolean)
		.map((path) => path.slice(rel.length + 1));
}

function readLocal(path) {
	return existsSync(path) ? readFileSync(path) : undefined;
}

function writeLocal(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}

function readVersion(dir, entry, commit) {
	const pkg = entry.path ? `${entry.path}/package.json` : "package.json";
	try {
		return JSON.parse(blob(dir, commit, pkg).toString("utf8")).version;
	} catch {
		return undefined;
	}
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdImport(manifest, name, { force }) {
	const entry = entryOf(manifest, name);
	const dest = destOf(entry);
	const dir = ensureClone(entry, { offline: true });
	const files = upstreamFiles(dir, entry, entry.commit);
	if (!force) {
		const clash = [...files.keys()].filter((rel) => existsSync(join(dest, rel)));
		if (clash.length > 0) {
			throw new Error(`${entry.dest} already has ${clash.length} upstream file(s); pass --force to overwrite`);
		}
	}
	for (const [rel, full] of files) writeLocal(join(dest, rel), blob(dir, entry.commit, full));
	console.log(`${name}: imported ${files.size} file(s) at ${entry.commit.slice(0, 12)} into ${entry.dest}`);
}

function cmdCheck(manifest, names) {
	for (const name of names) {
		const entry = entryOf(manifest, name);
		const dir = ensureClone(entry, { offline: true });
		const files = upstreamFiles(dir, entry, entry.commit);
		const changed = [];
		const missing = [];
		for (const [rel, full] of files) {
			const local = readLocal(join(destOf(entry), rel));
			if (!local) missing.push(rel);
			else if (!local.equals(blob(dir, entry.commit, full))) changed.push(rel);
		}
		// Other vendored packages nested inside this one (wtf inside workspace-history).
		const nested = Object.values(manifest.packages)
			.filter((other) => other !== entry && other.dest.startsWith(`${entry.dest}/`))
			.map((other) => `${other.dest.slice(entry.dest.length + 1)}/`);
		const added = listFiles(destOf(entry)).filter(
			(rel) => !files.has(rel) && !nested.some((prefix) => rel.startsWith(prefix)),
		);
		console.log(
			`${name}: ${files.size} upstream file(s), ${changed.length} modified, ${added.length} added, ${missing.length} removed locally`,
		);
		for (const rel of changed) console.log(`  M ${rel}`);
		for (const rel of added) console.log(`  A ${rel}`);
		for (const rel of missing) console.log(`  D ${rel}`);
	}
}

function cmdStatus(manifest, names) {
	for (const name of names) {
		const entry = entryOf(manifest, name);
		const dir = ensureClone(entry);
		const head = trackedHead(dir, entry);
		const pathspec = entry.path ? [entry.path] : ["."];
		const log =
			head.commit === entry.commit
				? ""
				: git(dir, ["log", "--format=%h %ad %s", "--date=short", `${entry.commit}..${head.commit}`, "--", ...pathspec]).trim();
		const lines = log ? log.split("\n") : [];
		const label = `${name} (${entry.version ?? "?"} @ ${entry.commit.slice(0, 8)})`;
		if (lines.length === 0) {
			console.log(`${label}: up to date with ${head.rev}`);
			continue;
		}
		console.log(`${label}: ${lines.length} upstream commit(s) on ${head.rev} (${head.commit.slice(0, 8)}) touch this package`);
		for (const line of lines.slice(0, 15)) console.log(`  ${line}`);
		if (lines.length > 15) console.log(`  ... ${lines.length - 15} more`);
	}
}

function cmdDiff(manifest, name, to) {
	const entry = entryOf(manifest, name);
	const dir = ensureClone(entry);
	const target = to ? revParse(dir, to) : trackedHead(dir, entry).commit;
	const pathspec = entry.path ? [entry.path] : ["."];
	process.stdout.write(git(dir, ["diff", "--stat", "--patch", entry.commit, target, "--", ...pathspec]));
}

function mergeFile(ours, base, theirs) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-preset-merge-"));
	try {
		const paths = ["ours", "base", "theirs"].map((n) => join(tmp, n));
		writeFileSync(paths[0], ours);
		writeFileSync(paths[1], base);
		writeFileSync(paths[2], theirs);
		const result = spawnSync("git", ["merge-file", "-p", "-L", "vendor", "-L", "base", "-L", "upstream", ...paths], {
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.status === null || result.status < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
		return { data: result.stdout, conflicts: result.status };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function cmdPull(manifest, name, to) {
	const entry = entryOf(manifest, name);
	const dir = ensureClone(entry);
	const head = to ? { rev: to, commit: revParse(dir, to) } : trackedHead(dir, entry);
	if (head.commit === entry.commit) {
		console.log(`${name}: already at ${head.rev}`);
		return;
	}
	const dest = destOf(entry);
	const before = upstreamFiles(dir, entry, entry.commit);
	const after = upstreamFiles(dir, entry, head.commit);
	const report = { updated: [], merged: [], added: [], removed: [], conflict: [], kept: [] };

	for (const rel of new Set([...before.keys(), ...after.keys()])) {
		const local = join(dest, rel);
		const ours = readLocal(local);
		const base = before.has(rel) ? blob(dir, entry.commit, before.get(rel)) : undefined;
		const theirs = after.has(rel) ? blob(dir, head.commit, after.get(rel)) : undefined;

		if (base && theirs && base.equals(theirs)) continue;
		if (!base && theirs) {
			if (ours && !ours.equals(theirs)) {
				writeLocal(`${local}.upstream`, theirs);
				report.conflict.push(`${rel} (added upstream, differs from local: see ${rel}.upstream)`);
			} else if (!ours) {
				writeLocal(local, theirs);
				report.added.push(rel);
			}
			continue;
		}
		if (base && !theirs) {
			if (ours?.equals(base)) {
				unlinkSync(local);
				report.removed.push(rel);
			} else if (ours) {
				report.kept.push(`${rel} (removed upstream, modified locally: kept)`);
			}
			continue;
		}
		if (!ours) {
			report.kept.push(`${rel} (changed upstream, removed locally: skipped)`);
		} else if (ours.equals(base)) {
			writeLocal(local, theirs);
			report.updated.push(rel);
		} else {
			const merged = mergeFile(ours, base, theirs);
			writeLocal(local, merged.data);
			(merged.conflicts > 0 ? report.conflict : report.merged).push(rel);
		}
	}

	const version = readVersion(dir, entry, head.commit);
	entry.commit = head.commit;
	if (version) entry.version = version;
	saveManifest(manifest);

	console.log(`${name}: ${entry.dest} now follows ${head.rev} (${head.commit.slice(0, 12)})${version ? `, version ${version}` : ""}`);
	for (const [label, list] of Object.entries(report)) {
		for (const item of list) console.log(`  ${label.padEnd(8)} ${item}`);
	}
	if (report.conflict.length > 0) {
		console.log(`\n${report.conflict.length} conflict(s): resolve the <<<<<<< markers, then review with git diff.`);
		process.exitCode = 2;
	}
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
	return readFileSync(fileURLToPath(import.meta.url), "utf8")
		.split("\n")
		.slice(2, 22)
		.map((line) => line.replace(/^ \* ?/, ""))
		.join("\n");
}

function main(argv) {
	const [command, ...rest] = argv;
	const toIndex = rest.indexOf("--to");
	const to = toIndex >= 0 ? rest[toIndex + 1] : undefined;
	const names = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--to");
	const manifest = loadManifest();
	const all = Object.keys(manifest.packages);

	switch (command) {
		case "status":
			return cmdStatus(manifest, names.length ? names : all);
		case "check":
			return cmdCheck(manifest, names.length ? names : all);
		case "diff":
			if (names.length !== 1) throw new Error("usage: diff <name> [--to REV]");
			return cmdDiff(manifest, names[0], to);
		case "pull":
			if (names.length !== 1) throw new Error("usage: pull <name> [--to REV]");
			return cmdPull(manifest, names[0], to);
		case "import":
			for (const name of names.length ? names : all) cmdImport(manifest, name, { force: rest.includes("--force") });
			return;
		default:
			console.log(usage());
			process.exitCode = command ? 1 : 0;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`upstream: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
