#!/usr/bin/env node
/**
 * trellis-lite CLI, run by the model through bash (see the trellis-journal
 * skill and the /trellis-lite-migrate prompt). Node 22.18+ runs it directly.
 *
 *   journal --title T [--commits a,b] [--task DIR] [--status S]   summary on stdin
 *   migrate [--json] [--apply --yes] [--remove-hosts claude,...]
 *
 * Works on the Trellis project containing the current directory.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { appendJournal, realGit, today } from "../../src/trellis-lite/journal.ts";
import { findProjectRoot } from "../../src/trellis-lite/root.ts";

export interface ParsedArgs {
	command: string | undefined;
	flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags = new Map<string, string | true>();
	let command: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq > 0) {
				flags.set(arg.slice(2, eq), arg.slice(eq + 1));
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags.set(arg.slice(2), next);
					i++;
				} else {
					flags.set(arg.slice(2), true);
				}
			}
		} else if (command === undefined) {
			command = arg;
		}
	}
	return { command, flags };
}

const str = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const list = (value: string | true | undefined) =>
	(str(value) ?? "")
		.split(/[,\s]+/u)
		.map((item) => item.trim())
		.filter(Boolean);

function projectRoot(): string {
	const root = findProjectRoot(process.cwd(), homedir());
	if (!root) throw new Error("Not inside a Trellis project (no .trellis/ up to the repository root).");
	return root;
}

async function main(argv: readonly string[]): Promise<number> {
	const { command, flags } = parseArgs(argv);
	if (command === "journal") {
		const root = projectRoot();
		const summary = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
		const result = appendJournal(
			root,
			{
				title: str(flags.get("title")) ?? "",
				summary,
				commits: list(flags.get("commits")),
				task: str(flags.get("task")),
				status: str(flags.get("status")),
			},
			realGit(root),
			today(),
		);
		console.log(
			`Recorded session ${result.session} in ${result.path}${result.newFile ? " (new file)" : ""}${
				result.indexUpdated ? "; index.md updated" : ""
			}. Not committed.`,
		);
		return 0;
	}
	if (command === "migrate") {
		const { runMigrateCli } = await import("../../src/trellis-lite/migrate/cli.ts");
		return runMigrateCli(process.cwd(), flags);
	}
	console.error("usage: trellis-lite.ts journal --title T [--commits a,b] [--task DIR] [--status S] < summary\n       trellis-lite.ts migrate [--json] [--apply --yes] [--remove-hosts claude]");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: Error) => {
			console.error(`trellis-lite: ${error.message}`);
			process.exit(1);
		},
	);
}
