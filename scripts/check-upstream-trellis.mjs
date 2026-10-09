#!/usr/bin/env node
/**
 * check-upstream-trellis — what changed upstream since trellis-lite's baselines.
 *
 * Why: trellis-lite is a clean-room rewrite, so nothing is merged; upstream is
 * followed for behavior and format changes worth adopting (see
 * docs/trellis-lite-upstream.md for the evaluation rules and decision log).
 *
 * Effect (read-only for this repository): clones or fetches Trellis and
 * mini-trellis into ~/.cache/pi-preset/upstream/ (no remotes are added here),
 * then prints, per tracked branch, the commits and diff stat on the watched
 * paths since the baseline in trellis-lite/upstream.json, the npm dist-tags,
 * and new beta branches or tags.
 *
 * Command: node scripts/check-upstream-trellis.mjs [--diff] [--no-fetch]
 *   --diff      also print the full diff of the watched paths
 *   --no-fetch  use the cached clones as they are
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "..", "trellis-lite", "upstream.json"), "utf8"));
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-preset", "upstream");
const args = new Set(process.argv.slice(2));

const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();
const tryRun = (cmd, argv, cwd) => {
	try {
		return run(cmd, argv, cwd);
	} catch (error) {
		return `(failed: ${String(error.stderr || error.message).trim().split("\n")[0]})`;
	}
};

mkdirSync(cache, { recursive: true });

for (const [name, repo] of Object.entries(config.repos)) {
	const dir = join(cache, name);
	if (!existsSync(join(dir, ".git"))) {
		console.error(`cloning ${repo.url} into ${dir} …`);
		run("git", ["clone", "-q", "--filter=blob:none", repo.url, dir]);
	} else if (!args.has("--no-fetch")) {
		run("git", ["fetch", "-q", "--tags", "--prune", "origin"], dir);
	}

	console.log(`\n# ${name}  (${repo.url})`);
	console.log(`npm ${repo.npm}: ${tryRun("npm", ["view", repo.npm, "dist-tags", "--json"]).replace(/\s+/gu, " ")}`);

	for (const track of repo.tracks) {
		const head = tryRun("git", ["rev-parse", "--short", `origin/${track.branch}`], dir);
		console.log(`\n## ${track.name}: origin/${track.branch} @ ${head}  (baseline ${track.ref} ${track.baseline.slice(0, 8)}, ${track.date})`);
		const range = `${track.baseline}..origin/${track.branch}`;
		const log = tryRun("git", ["log", "--no-merges", "--date=short", "--format=%h %ad %s", range, "--", ...repo.paths], dir);
		console.log(log ? `commits on watched paths:\n${log}` : "commits on watched paths: none");
		const stat = tryRun("git", ["diff", "--stat", track.baseline, `origin/${track.branch}`, "--", ...repo.paths], dir);
		if (stat) console.log(`\ndiff stat:\n${stat}`);
		const all = tryRun("git", ["rev-list", "--count", range], dir);
		console.log(`(all commits since baseline: ${all})`);
		if (args.has("--diff") && stat) {
			console.log(`\n${tryRun("git", ["diff", track.baseline, `origin/${track.branch}`, "--", ...repo.paths], dir)}`);
		}
	}

	if (repo.betaBranchPattern) {
		const known = new Set(repo.tracks.map((track) => `origin/${track.branch}`));
		const branches = tryRun("git", ["branch", "-r", "--list", `origin/${repo.betaBranchPattern}`], dir)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const newer = branches.filter((branch) => !known.has(branch) && versionOf(branch) > versionOf(`origin/${repo.tracks[0].branch}`));
		console.log(`\nbeta branches: ${branches.join(", ") || "none"}${newer.length ? `\nNEW beta line(s): ${newer.join(", ")}` : ""}`);
	}
	const oldest = repo.tracks.map((track) => track.date).sort()[0];
	const tags = tryRun("git", ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short) %(creatordate:short)", "refs/tags"], dir)
		.split("\n")
		.filter((line) => (line.split(" ")[1] ?? "") >= oldest)
		// Tags already contained in a baseline are not news.
		.filter((line) => !repo.tracks.some((track) => isAncestor(dir, line.split(" ")[0], track.baseline)));
	console.log(`tags since ${oldest} besides the baselines: ${tags.length ? tags.join(", ") : "none"}`);
}

function isAncestor(dir, ref, of) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ref, of], { cwd: dir, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function versionOf(branch) {
	const match = branch.match(/v(\d+)\.(\d+)/u);
	return match ? Number(match[1]) * 1000 + Number(match[2]) : 0;
}
