import assert from "node:assert/strict";
import { statSync } from "node:fs";

export type SimulatedPlatform = "darwin" | "linux" | "win32";

export async function withPlatform<T>(platform: SimulatedPlatform, callback: () => T | Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (descriptor === undefined || descriptor.configurable !== true) {
		throw new Error("process.platform is not configurable in this runtime");
	}

	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try {
		return await callback();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

export function assertModeOnPosix(path: string, expectedMode: number): void {
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, expectedMode);
}
