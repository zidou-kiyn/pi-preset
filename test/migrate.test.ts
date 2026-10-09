import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyMigration, isEmptyMigration, planMigration, renderMigration } from "../src/migrate.ts";

/** Run with HOME and PI_CODING_AGENT_DIR pointing into a sandbox. */
function sandbox<T>(callback: (home: string, agentDir: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), "pi-preset-migrate-test-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const saved = { HOME: process.env.HOME, PI: process.env.PI_CODING_AGENT_DIR, XDG: process.env.XDG_STATE_HOME };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.XDG_STATE_HOME;
	try {
		return callback(home, agentDir);
	} finally {
		for (const [key, value] of [["HOME", saved.HOME], ["PI_CODING_AGENT_DIR", saved.PI], ["XDG_STATE_HOME", saved.XDG]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	}
}

function writeSkill(root: string, name: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
}

test("migration drops superseded packages, legacy skills, their lock entries, and stale extension data", () => {
	sandbox((home, agentDir) => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:pi-wtf@0.3.0", "git:github.com/zidou-kiyn/pi-preset", "npm:pi-statusline", "npm:pi-tool-display"],
			}),
		);
		writeSkill(join(home, ".agents", "skills"), "grill-me");
		writeSkill(join(home, ".agents", "skills"), "grilling");
		writeSkill(join(home, ".agents", "skills"), "my-own-skill");
		writeFileSync(
			join(home, ".agents", ".skill-lock.json"),
			JSON.stringify({
				version: 3,
				skills: {
					"grill-me": { source: "mattpocock/skills" },
					grilling: { source: "mattpocock/skills" },
					"my-own-skill": { source: "someone/else" },
				},
			}),
		);
		mkdirSync(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "pi-tool-display", "config.json"), "{}");

		const plan = planMigration(new Date("2026-10-09T00:00:00Z"));
		assert.deepEqual(
			plan.packages.map((pkg) => pkg.source),
			["npm:pi-wtf@0.3.0", "npm:pi-tool-display"],
		);
		assert.equal(plan.moves.length, 3);
		assert.deepEqual(plan.locks.map((lock) => lock.names), [["grill-me", "grilling"]]);
		assert.match(renderMigration(plan), /npm:pi-wtf@0\.3\.0/);

		const backup = applyMigration(plan);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.packages, ["git:github.com/zidou-kiyn/pi-preset", "npm:pi-statusline"]);
		assert.equal(settings.theme, "dark");
		assert.ok(!existsSync(join(home, ".agents", "skills", "grilling")));
		assert.ok(existsSync(join(home, ".agents", "skills", "my-own-skill")), "other skills stay");
		assert.ok(existsSync(join(backup, ".agents", "skills", "grilling", "SKILL.md")), "moved, not deleted");
		assert.ok(existsSync(join(backup, ".pi", "agent", "settings.json")), "settings.json backed up");
		assert.ok(!existsSync(join(agentDir, "extensions", "pi-tool-display")));
		const lock = JSON.parse(readFileSync(join(home, ".agents", ".skill-lock.json"), "utf8"));
		assert.deepEqual(Object.keys(lock.skills), ["my-own-skill"]);
		assert.equal(lock.version, 3);

		assert.ok(isEmptyMigration(planMigration()), "a second run has nothing left to do");
	});
});

test("a clean machine has nothing to migrate", () => {
	sandbox(() => {
		const plan = planMigration();
		assert.ok(isEmptyMigration(plan));
		assert.equal(renderMigration(plan), "Nothing to migrate.");
	});
});
