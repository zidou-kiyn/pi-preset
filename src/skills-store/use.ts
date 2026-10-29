/**
 * "Use now": the message `/skill:name` sends, built for a store skill so the
 * instructions reach the model without a reload. pi renders this exact shape
 * as the collapsible skill box.
 */

import { readFileSync } from "node:fs";
import type { StoreSkill } from "./catalog.ts";

export function skillMessage(skill: StoreSkill, request?: string): string {
	const content = readFileSync(skill.filePath, "utf8").trim();
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${content}\n</skill>`;
	const extra = request?.trim();
	return extra ? `${block}\n\n${extra}` : block;
}

/** What the `skills` tool returns for `use` / `enable`: the instructions plus where the files are. */
export function skillForModel(skill: StoreSkill): string {
	const content = readFileSync(skill.filePath, "utf8").trim();
	return `Skill "${skill.name}" (files in ${skill.dir}; resolve relative paths against that directory):\n\n${content}`;
}
