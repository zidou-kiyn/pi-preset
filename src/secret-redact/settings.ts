/**
 * secret-redact settings: `secretRedact` in the preset's own settings file
 * (<agent dir>/pi-preset/settings.json, shared with the language choice).
 *
 *   enabled  false = no redaction at all (default true)
 *   named    true = also the rules that guess from a variable name,
 *            generic-api-key and generic-password (default false)
 *
 * PI_PRESET_SECRET_REDACT=off turns it off for one process, whatever the file says.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { presetSettingsPath } from "../i18n.ts";

export interface SecretRedactSettings {
	enabled: boolean;
	named: boolean;
}

function readFile(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function readSettings(path = presetSettingsPath()): SecretRedactSettings {
	const section = readFile(path).secretRedact;
	const data = section && typeof section === "object" ? (section as Record<string, unknown>) : {};
	return { enabled: data.enabled !== false, named: data.named === true };
}

/** Save, keeping every other key of the file; defaults are left out. */
export function writeSettings(settings: SecretRedactSettings, path = presetSettingsPath()): void {
	const data = readFile(path);
	const section: Record<string, boolean> = {};
	if (!settings.enabled) section.enabled = false;
	if (settings.named) section.named = true;
	if (Object.keys(section).length > 0) data.secretRedact = section;
	else delete data.secretRedact;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Off for this process through the environment. */
export function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:off|0|false|no)$/iu.test(env.PI_PRESET_SECRET_REDACT ?? "");
}
