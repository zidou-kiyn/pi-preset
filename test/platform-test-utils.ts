import assert from "node:assert/strict";
import { statSync } from "node:fs";

export function assertModeOnPosix(path: string, expectedMode: number): void {
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, expectedMode);
}
