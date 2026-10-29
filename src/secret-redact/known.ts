/**
 * Secrets pi itself knows, found by value rather than by shape: pattern
 * rules miss internal tokens and plain passwords, but these exact strings
 * can be looked for anywhere.
 *
 *   - environment variables of the pi process whose name says secret
 *     (OPENAI_API_KEY, GITHUB_TOKEN, DB_PASSWORD, ...), skipping values that
 *     are paths or sockets (SSH_AUTH_SOCK);
 *   - pi's credential files in the agent directory: auth.json (every
 *     string), models.json and mcp.json (strings under a secret-sounding key:
 *     apiKey, headers.Authorization, env.*_TOKEN, ...), skipping `$VAR`
 *     references and `!command` values, which are not the secret itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../paths.ts";
import { type KnownValue, MIN_SECRET_LENGTH } from "./detect.ts";

const SECRET_NAME = /(?:^|[_\-.])(?:api[_-]?key|apikey|key|token|secret|password|passwd|pass|pwd|private[_-]?key|access[_-]?key|credentials?|auth(?:orization)?|bearer|cookie)(?:$|[_\-.])/iu;
const SECRET_KEY = /api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|credential|private[_-]?key|access[_-]?key/iu;
const NOT_SECRET_NAME = /(?:_SOCK|_PATH|_FILE|_DIR|_HOME|_URL|_URI|_HOST|_PORT|_USER|_USERNAME|_ID|_REGION|_TYPE|_MODE)$/iu;

function plausibleValue(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < MIN_SECRET_LENGTH) return false;
	if (/^[$!%]/u.test(trimmed)) return false; // $VAR, ${VAR}, !command, %VAR%
	if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)/u.test(trimmed)) return false; // a path
	if (/^(?:true|false|null|none|yes|no)$/iu.test(trimmed)) return false;
	// The name of an environment variable (models.json allows that as apiKey).
	if (/^[A-Z_][A-Z0-9_]*$/u.test(trimmed)) return false;
	return true;
}

/** Secret-looking environment variables. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): KnownValue[] {
	const out: KnownValue[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!value || !SECRET_NAME.test(name) || NOT_SECRET_NAME.test(name)) continue;
		if (!plausibleValue(value)) continue;
		out.push({ value: value.trim(), label: `env-${name}` });
	}
	return out;
}

function walk(value: unknown, path: string[], take: (path: string[], value: string) => void, depth = 0): void {
	if (depth > 12 || value === null || value === undefined) return;
	if (typeof value === "string") {
		take(path, value);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => walk(item, [...path, String(index)], take, depth + 1));
		return;
	}
	if (typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, [...path, key], take, depth + 1);
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Secrets in pi's credential files. `everything` takes every string (auth.json). */
export function fileSecrets(path: string, labelBase: string, everything: boolean): KnownValue[] {
	const out: KnownValue[] = [];
	walk(readJson(path), [], (keys, value) => {
		const key = keys[keys.length - 1] ?? "";
		const parent = keys[keys.length - 2] ?? "";
		const secretKey = SECRET_KEY.test(key) || (/^(?:env|headers)$/iu.test(parent) && SECRET_NAME.test(key));
		if (!everything && !secretKey) return;
		if (everything && /^(?:type|provider|expires|scope|token_type)$/iu.test(key)) return;
		if (!plausibleValue(value)) return;
		const where = keys.filter((part) => !/^\d+$/u.test(part)).slice(-2).join(".");
		out.push({ value: value.trim(), label: `${labelBase}-${where}` });
	});
	return out;
}

/** Everything pi knows to be secret, longest first. */
export function collectKnownSecrets(env: NodeJS.ProcessEnv = process.env, agentDir = getAgentDir()): KnownValue[] {
	const all = [
		...fileSecrets(join(agentDir, "auth.json"), "pi-auth", true),
		...fileSecrets(join(agentDir, "models.json"), "pi-models", false),
		...fileSecrets(join(agentDir, "mcp.json"), "pi-mcp", false),
		...envSecrets(env),
	];
	const seen = new Set<string>();
	const unique = all.filter((item) => !seen.has(item.value) && seen.add(item.value));
	return unique.sort((a, b) => b.value.length - a.value.length);
}
