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

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
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

export interface WriteJsonObjectAtomicOptions {
	/** Exact mode for a newly created target file. */
	newFileMode?: number;
	/** Refuse to replace a dangling symlink instead of treating it as absent. */
	rejectDanglingSymlink?: boolean;
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

/**
 * Structural equality for JSON values.
 *
 * Leaf comparison cannot use `===`: an array-valued leaf (keybindings.json binds
 * an action to a LIST of keys) is a fresh object on every read, so `===` would
 * report a difference on every run and the step would never converge.
 */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => jsonEquals(item, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		if (aKeys.length !== Object.keys(b).length) return false;
		return aKeys.every((key) => key in b && jsonEquals(a[key], b[key]));
	}
	return false;
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
export function flattenLeaves(
	patch: JsonObject,
	prefix: readonly string[] = [],
): Array<{ path: string[]; value: JsonValue }> {
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
export function resolveJsonTargetPath(filePath: string, rejectDanglingSymlink = false): string {
	try {
		if (!lstatSync(filePath).isSymbolicLink()) return filePath;
		try {
			return realpathSync(filePath);
		} catch {
			if (rejectDanglingSymlink) {
				throw new Error(`${filePath} is a dangling symlink; point it at a file or remove the link before retrying`);
			}
			return filePath;
		}
	} catch (error) {
		if (rejectDanglingSymlink && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// missing, or a dangling link when rejection is disabled: write the path as given
	}
	return filePath;
}

interface UniqueSiblingFile {
	path: string;
	descriptor: number;
}

function openUniqueSibling(filePath: string, label: string, mode: number): UniqueSiblingFile {
	for (let attempt = 0; attempt < 10; attempt++) {
		const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
		const candidate = `${filePath}.${label}-${suffix}`;
		try {
			return { path: candidate, descriptor: openSync(candidate, "wx", mode & 0o777) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error(`cannot allocate a unique temporary path beside ${filePath}`);
}

function writeBackupAtomic(filePath: string, mode: number): void {
	const backupPath = `${filePath}.preset-bak`;
	const temporary = openUniqueSibling(filePath, "preset.bak-tmp", mode | 0o200);
	let descriptor: number | undefined = temporary.descriptor;
	let temporaryExists = true;
	try {
		writeFileSync(descriptor, readFileSync(filePath));
		fchmodSync(descriptor, mode);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary.path, backupPath);
		temporaryExists = false;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// best effort; the backup error below is the one that matters
			}
		}
		if (temporaryExists && existsSync(temporary.path)) {
			try {
				unlinkSync(temporary.path);
			} catch {
				// best effort; the backup error below is the one that matters
			}
		}
		throw error;
	}
}

/**
 * Write a JSON object atomically, keeping a .preset-bak of the previous content.
 *
 * Backup first, then write a sibling tmp file and rename it over the target, so
 * an interrupted write can never leave a truncated file in place. Unique files
 * are opened exclusively and kept open through write/chmod, preventing another
 * process from swapping in a symlink between allocation and writing.
 */
export function writeJsonObjectAtomic(
	inputPath: string,
	data: JsonObject,
	options: WriteJsonObjectAtomicOptions = {},
): void {
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	const filePath = resolveJsonTargetPath(inputPath, options.rejectDanglingSymlink ?? false);
	mkdirSync(dirname(filePath), { recursive: true });

	let mode: number | undefined;
	if (existsSync(filePath)) {
		mode = statSync(filePath).mode & 0o777;
		writeBackupAtomic(filePath, mode);
	}

	const tempMode =
		options.newFileMode !== undefined ? options.newFileMode | 0o200 : mode !== undefined ? mode | 0o200 : 0o666;
	const temporary = openUniqueSibling(filePath, "preset.tmp", tempMode);
	let descriptor: number | undefined = temporary.descriptor;
	let temporaryExists = true;
	try {
		writeFileSync(descriptor, serialized, "utf8");
		const finalMode = mode ?? options.newFileMode;
		if (finalMode !== undefined) fchmodSync(descriptor, finalMode & 0o777);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary.path, filePath);
		temporaryExists = false;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// best effort; the write error below is the one that matters
			}
		}
		if (temporaryExists && existsSync(temporary.path)) {
			try {
				unlinkSync(temporary.path);
			} catch {
				// best effort; the write error below is the one that matters
			}
		}
		throw error;
	}
}
