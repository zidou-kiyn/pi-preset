/**
 * One-time migration to the vendored preset (0.2.0).
 *
 * The extensions the preset used to install as packages are now loaded from
 * the preset itself. Leaving the old packages[] entries in place would make pi
 * load both copies, and a duplicate tool name stops pi before any extension
 * (including /pi-preset) can run. So this runs outside pi:
 *
 *   1. settings.json packages[]: drop every SUPERSEDED_PACKAGES entry.
 *   2. grill-me / grilling copies that older presets installed from upstream
 *      into ~/.agents/skills or <agent>/skills (they would shadow the bundled
 *      skills), plus their entries in the skills CLI lock file.
 *   3. Leftover data directories of removed extensions under <agent>/extensions/.
 *
 * Nothing is deleted: files and directories move into
 * <agent>/preset-migration-backup/<timestamp>/, and settings.json is backed up
 * there before it is rewritten. planMigration() is read-only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isPlainObject, type JsonObject, readJsonObject, writeJsonObjectAtomic } from "./json-merge.ts";
import { BUNDLED_SKILLS } from "./manifest.ts";
import { getAgentDir, getLegacySkillRoots, getSettingsPath, getUserExtensionsDir } from "./paths.ts";
import { packageEntrySource, packageIdentity, supersededReason } from "./plan.ts";

/** Extension data directories left behind by packages the preset dropped. */
export const STALE_EXTENSION_DIRS: readonly string[] = ["pi-tool-display", "pi-permission-system"];

export interface MigrationPlan {
	settingsPath: string;
	/** packages[] entries to drop, with the reason. */
	packages: { source: string; reason: string }[];
	/** Directories to move into the backup. */
	moves: { path: string; why: string }[];
	/** Skills lock files and the skill names to drop from each. */
	locks: { path: string; names: string[] }[];
	backupDir: string;
}

/** The skills CLI lock: $XDG_STATE_HOME/skills/.skill-lock.json or ~/.agents/.skill-lock.json. */
export function skillLockPaths(): string[] {
	const paths = [join(homedir(), ".agents", ".skill-lock.json")];
	if (process.env.XDG_STATE_HOME) paths.unshift(join(process.env.XDG_STATE_HOME, "skills", ".skill-lock.json"));
	return paths;
}

export function planMigration(now = new Date()): MigrationPlan {
	const settingsPath = getSettingsPath();
	const baseDir = dirname(settingsPath);
	const plan: MigrationPlan = {
		settingsPath,
		packages: [],
		moves: [],
		locks: [],
		backupDir: join(getAgentDir(), "preset-migration-backup", now.toISOString().replace(/[:.]/g, "-")),
	};

	const packages = readJsonObject(settingsPath).data.packages;
	if (Array.isArray(packages)) {
		for (const entry of packages) {
			const source = packageEntrySource(entry);
			if (!source) continue;
			const reason = supersededReason(packageIdentity(source, baseDir), baseDir);
			if (reason !== undefined) plan.packages.push({ source, reason });
		}
	}

	for (const root of getLegacySkillRoots()) {
		for (const name of BUNDLED_SKILLS) {
			const path = join(root, name);
			if (existsSync(path)) plan.moves.push({ path, why: "would shadow the bundled skill" });
		}
	}

	for (const lockPath of skillLockPaths()) {
		if (!existsSync(lockPath)) continue;
		const skills = readJsonObject(lockPath).data.skills;
		if (!isPlainObject(skills)) continue;
		const names = BUNDLED_SKILLS.filter((name) => {
			const entry = skills[name];
			return isPlainObject(entry) && entry.source === "mattpocock/skills";
		});
		if (names.length > 0) plan.locks.push({ path: lockPath, names });
	}

	for (const name of STALE_EXTENSION_DIRS) {
		const path = join(getUserExtensionsDir(), name);
		if (existsSync(path)) plan.moves.push({ path, why: "data of an extension the preset no longer installs" });
	}

	return plan;
}

export function isEmptyMigration(plan: MigrationPlan): boolean {
	return plan.packages.length === 0 && plan.moves.length === 0 && plan.locks.length === 0;
}

export function renderMigration(plan: MigrationPlan): string {
	if (isEmptyMigration(plan)) return "Nothing to migrate.";
	const lines: string[] = [];
	if (plan.packages.length > 0) {
		lines.push(`${plan.settingsPath}: remove from packages[]`);
		for (const pkg of plan.packages) lines.push(`  - ${pkg.source}  (${pkg.reason})`);
	}
	if (plan.moves.length > 0) {
		lines.push(`Move into ${plan.backupDir}`);
		for (const move of plan.moves) lines.push(`  - ${move.path}  (${move.why})`);
	}
	for (const lock of plan.locks) lines.push(`${lock.path}: drop ${lock.names.join(", ")}`);
	return lines.join("\n");
}

function backupTarget(plan: MigrationPlan, path: string): string {
	const home = homedir();
	// Mirror the path under the backup dir: <backup>/.agents/skills/grilling.
	const relative = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : basename(path);
	return join(plan.backupDir, relative);
}

function backupCopy(plan: MigrationPlan, path: string): void {
	const target = backupTarget(plan, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, readFileSync(path));
}

/** Apply a plan from planMigration(). Returns the backup directory. */
export function applyMigration(plan: MigrationPlan): string {
	if (isEmptyMigration(plan)) return plan.backupDir;
	mkdirSync(plan.backupDir, { recursive: true });

	if (plan.packages.length > 0) {
		backupCopy(plan, plan.settingsPath);
		const settings = readJsonObject(plan.settingsPath).data;
		const drop = new Set(plan.packages.map((pkg) => pkg.source));
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		const next: JsonObject = {
			...settings,
			packages: packages.filter((entry) => {
				const source = packageEntrySource(entry);
				return source === undefined || !drop.has(source);
			}),
		};
		writeJsonObjectAtomic(plan.settingsPath, next);
	}

	for (const move of plan.moves) {
		const target = backupTarget(plan, move.path);
		mkdirSync(dirname(target), { recursive: true });
		renameSync(move.path, target);
	}

	for (const lock of plan.locks) {
		backupCopy(plan, lock.path);
		const data = readJsonObject(lock.path).data;
		const skills = isPlainObject(data.skills) ? { ...data.skills } : {};
		for (const name of lock.names) delete skills[name];
		writeJsonObjectAtomic(lock.path, { ...data, skills });
	}

	return plan.backupDir;
}
