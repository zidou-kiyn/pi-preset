#!/usr/bin/env node
/**
 * Migrate an existing machine to the vendored preset (0.2.0). Run it with pi
 * closed, before the first start after updating the preset:
 *
 *   node scripts/migrate-vendored.ts           show what would change
 *   node scripts/migrate-vendored.ts --apply   change it (backups first)
 *
 * Runs on the Node pi already needs (22.19+ strips TypeScript natively). See src/migrate.ts for
 * what it touches; PI_CODING_AGENT_DIR is honoured like in pi.
 */

import { applyMigration, isEmptyMigration, planMigration, renderMigration } from "../src/migrate.ts";

const plan = planMigration();
console.log(renderMigration(plan));

if (isEmptyMigration(plan)) {
	process.exit(0);
}
if (!process.argv.includes("--apply")) {
	console.log("\nDry run. Re-run with --apply to make these changes.");
	process.exit(0);
}
const backup = applyMigration(plan);
console.log(`\nDone. Backups are in ${backup}. Start pi; /pi-preset → Sync preset writes the remaining config.`);
