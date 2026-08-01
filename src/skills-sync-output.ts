/** Maximum amount of untrusted installer text retained in memory or reports. */
export const MAX_CAPTURED_OUTPUT_CHARS = 8_000;

type EscapeState = "normal" | "escape" | "csi" | "string" | "string-escape";

function isBidiControl(code: number): boolean {
	return (
		(code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f
	);
}

/**
 * Remove ANSI/ECMA-48 control strings and unsafe control characters while
 * preserving ordinary Unicode diagnostics. Output is bounded by UTF-16 code
 * units because that is how JavaScript strings are measured elsewhere here.
 */
export function sanitizeTerminalText(value: string, maxChars = MAX_CAPTURED_OUTPUT_CHARS): string {
	let output = "";
	let state: EscapeState = "normal";

	const append = (character: string): void => {
		if (output.length + character.length > maxChars) return;
		output += character;
	};

	for (const character of value) {
		if (output.length >= maxChars) break;
		const code = character.codePointAt(0) ?? 0;

		if (state === "csi") {
			if (code >= 0x40 && code <= 0x7e) state = "normal";
			continue;
		}
		if (state === "string") {
			if (code === 0x07 || code === 0x9c) state = "normal";
			else if (code === 0x1b) state = "string-escape";
			continue;
		}
		if (state === "string-escape") {
			state = code === 0x5c ? "normal" : code === 0x1b ? "string-escape" : "string";
			continue;
		}
		if (state === "escape") {
			if (character === "[") state = "csi";
			else if (
				character === "]" ||
				character === "P" ||
				character === "X" ||
				character === "^" ||
				character === "_"
			) {
				state = "string";
			} else if (code >= 0x30 && code <= 0x7e) {
				state = "normal";
			}
			continue;
		}

		if (code === 0x1b) {
			state = "escape";
			continue;
		}
		if (code === 0x9b) {
			state = "csi";
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			state = "string";
			continue;
		}
		if ((code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f)) {
			continue;
		}
		if ((code >= 0x7f && code <= 0x9f) || isBidiControl(code)) continue;
		if (code === 0x0d || code === 0x2028 || code === 0x2029) {
			append("\n");
			continue;
		}
		append(character);
	}

	return output;
}

/** Redact common credential forms that may appear in third-party diagnostics. */
export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(Authorization)\s*:\s*[^\r\n]+/gi, "$1: [redacted]")
		.replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/\b(Bearer)\s+[^\s]+/gi, "$1 [redacted]")
		.replace(
			/\b(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|API[_-]?KEY|PASSWORD|AUTHORIZATION)\s*[:=]\s*[^\s]+/gi,
			"$1=[redacted]",
		)
		.replace(/\b(?:github_pat_|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.replace(/([?&](?:access_?token|auth|key|token)=)[^\s&#]+/gi, "$1[redacted]");
}
