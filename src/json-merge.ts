/**
 * JSON read / deep merge / atomic write.
 *
 * The files this touches (web-search.json, settings.json) hold provider API
 * keys, so the rules are strict:
 *   - never overwrite a whole file; merge only the leaf keys of a patch
 *   - a JSON.parse failure aborts the step instead of starting from {}
 *     (starting from {} is exactly how a file full of keys gets erased)
 *   - back up to <file>.preset-bak before writing, then tmp + rename
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ReadJsonResult {
	/** False when the file does not exist; data is then an empty object. */
	exists: boolean;
	data: JsonObject;
}

/**
 * Read a JSON object file.
 *
 * Throws when the file exists but does not parse, or parses to a non-object.
 * Callers must let that abort their step: silently treating an unreadable
 * key-bearing file as {} would drop every key on the next write.
 */
export function readJsonObject(filePath: string): ReadJsonResult {
	if (!existsSync(filePath)) return { exists: false, data: {} };

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`cannot read ${filePath}: ${(error as Error).message}`);
	}

	if (raw.trim() === "") return { exists: true, data: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${filePath} is not valid JSON (${(error as Error).message}); refusing to write over it`);
	}

	if (!isPlainObject(parsed)) {
		throw new Error(`${filePath} does not contain a JSON object; refusing to write over it`);
	}

	return { exists: true, data: parsed };
}

/**
 * Deep merge `patch` into `base`, returning a new object.
 *
 * Only keys present in the patch are touched. Two plain objects recurse;
 * anything else (including arrays) is replaced by the patch value. Arrays are
 * never merged element-wise here — packages[] is handled by an explicit append
 * in plan/apply so ordering and user-added entries are preserved.
 */
export function deepMerge(base: JsonObject, patch: JsonObject): JsonObject {
	const result: JsonObject = { ...base };
	for (const [key, patchValue] of Object.entries(patch)) {
		const baseValue = result[key];
		if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
			result[key] = deepMerge(baseValue, patchValue);
		} else {
			result[key] = patchValue;
		}
	}
	return result;
}

/** Read a nested value by key path. Returns undefined if any segment is missing. */
export function getPath(source: JsonObject, keyPath: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = source;
	for (const key of keyPath) {
		if (!isPlainObject(current)) return undefined;
		current = current[key];
	}
	return current;
}

/** Flatten a patch object into leaf key paths, so a diff can be reported per key. */
export function flattenLeaves(patch: JsonObject, prefix: readonly string[] = []): Array<{ path: string[]; value: JsonValue }> {
	const leaves: Array<{ path: string[]; value: JsonValue }> = [];
	for (const [key, value] of Object.entries(patch)) {
		const keyPath = [...prefix, key];
		if (isPlainObject(value)) {
			leaves.push(...flattenLeaves(value, keyPath));
		} else {
			leaves.push({ path: keyPath, value });
		}
	}
	return leaves;
}

/**
 * Resolve a symlinked target to the file it points at.
 *
 * rename() replaces a symlink rather than writing through it, which would
 * silently detach a dotfiles-managed config from its repository. Writing to the
 * resolved path keeps the link intact. A dangling link resolves to nothing and
 * is treated as an absent file.
 */
function resolveTarget(filePath: string): string {
	try {
		if (lstatSync(filePath).isSymbolicLink()) return realpathSync(filePath);
	} catch {
		// missing, or a dangling link: write the path as given
	}
	return filePath;
}

/**
 * Write a JSON object atomically, keeping a .preset-bak of the previous content.
 *
 * Backup first, then write a sibling tmp file and rename it over the target, so
 * an interrupted write can never leave a truncated file in place. The tmp file
 * inherits the target's permissions before the rename: these files hold provider
 * API keys, and a 0600 config must not silently widen to 0644 because a fresh
 * file was created under the process umask.
 */
export function writeJsonObjectAtomic(inputPath: string, data: JsonObject): void {
	const filePath = resolveTarget(inputPath);
	mkdirSync(dirname(filePath), { recursive: true });

	let mode: number | undefined;
	if (existsSync(filePath)) {
		mode = statSync(filePath).mode & 0o777;
		copyFileSync(filePath, `${filePath}.preset-bak`);
	}

	const tmpPath = `${filePath}.preset.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		if (mode !== undefined) chmodSync(tmpPath, mode);
		renameSync(tmpPath, filePath);
	} catch (error) {
		if (existsSync(tmpPath)) {
			try {
				unlinkSync(tmpPath);
			} catch {
				// best effort; the write error below is the one that matters
			}
		}
		throw error;
	}
}
