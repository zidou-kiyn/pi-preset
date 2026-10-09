/**
 * The minimal `.trellis/` skeleton: a spec index, the developer identity,
 * the developer's first journal, and a `.gitignore` that keeps the identity
 * local. Only missing pieces are planned; existing files are never touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { journalFiles, readDeveloper } from "./root.ts";
import { journalHeader } from "./journal.ts";
import { specIndexes } from "./snapshot.ts";

export const SPEC_INDEX = `# Project specs

Rules for code in this repository that should still hold next week. Each area
gets a directory with its own \`index.md\` (for example \`backend/\`,
\`frontend/\`, \`guides/\` for cross-cutting thinking checklists); each index
links its spec files with one line on when to read them.

Read the index for the area you are about to change before editing code there.

A spec can be attached automatically when matching files are read or edited:

\`\`\`markdown
---
description: one line shown when the spec is listed instead of attached
paths:
  - src/db/**
---
\`\`\`
`;

export interface InitStep {
	path: string;
	content: string;
	/** Append to an existing file instead of creating it. */
	append?: boolean;
}

/** Turn a display name into a directory-safe developer id. */
export function developerId(name: string): string {
	return name
		.trim()
		.replace(/[\s/\\:*?"<>|]+/gu, "-")
		.replace(/^[.-]+|-+$/gu, "");
}

export function gitUserName(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function gitToplevel(cwd: string): string | undefined {
	try {
		return (
			execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
			undefined
		);
	} catch {
		return undefined;
	}
}

/** Missing skeleton pieces under `root`. `developer` is used only when `.developer` is absent. */
export function planInit(root: string, developer: string | undefined, date: string, now: string): InitStep[] {
	const steps: InitStep[] = [];
	const trellis = join(root, ".trellis");
	// An entry point for specs, unless the project already has layer indexes.
	if (!existsSync(join(trellis, "spec", "index.md")) && specIndexes(root).length === 0) {
		steps.push({ path: ".trellis/spec/index.md", content: SPEC_INDEX });
	}

	const existing = readDeveloper(root);
	const name = existing ?? developer;
	if (!existing && name) steps.push({ path: ".trellis/.developer", content: `name=${name}\ninitialized_at=${now}\n` });
	if (name && journalFiles(root, name).length === 0) {
		steps.push({ path: `.trellis/workspace/${name}/journal-1.md`, content: journalHeader(name, 1, date) });
	}

	const gitignore = join(trellis, ".gitignore");
	if (!existsSync(gitignore)) {
		steps.push({ path: ".trellis/.gitignore", content: "# Developer identity is per machine\n.developer\n" });
	} else {
		const lines = readFileSync(gitignore, "utf8").split(/\r?\n/u).map((line) => line.trim());
		if (!lines.includes(".developer") && !lines.includes("/.developer")) {
			steps.push({ path: ".trellis/.gitignore", content: ".developer\n", append: true });
		}
	}
	return steps;
}

export function applyInit(root: string, steps: readonly InitStep[]): void {
	for (const step of steps) {
		const full = join(root, step.path);
		mkdirSync(dirname(full), { recursive: true });
		if (step.append) {
			const current = readFileSync(full, "utf8");
			writeFileSync(full, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${step.content}`);
		} else if (!existsSync(full)) {
			writeFileSync(full, step.content);
		}
	}
}
