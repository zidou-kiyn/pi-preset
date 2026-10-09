#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

/**
 * Reviewed false positives in vendored upstream code (public client ids, test
 * fixtures). Matched by the SHA-256 of the trimmed line, with a leading diff
 * marker (+/-/space) removed, so the same line passes in the working tree and
 * in `git log -p`. Every entry carries a reason.
 */
const allowPath = join(dirname(fileURLToPath(import.meta.url)), "scan-secrets-allow.json");
const allowed = new Set(
	existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")).map((entry) => entry.sha256) : [],
);

function lineFingerprint(source, index) {
	const start = source.lastIndexOf("\n", index - 1) + 1;
	const end = source.indexOf("\n", index);
	const line = source.slice(start, end === -1 ? source.length : end);
	return createHash("sha256").update(line.replace(/^[+\- ]/, "").trim()).digest("hex");
}
const scannerFiles = new Set(["scripts/scan-secrets.sh", "scripts/scan-secrets.mjs"]);

const highConfidencePatterns = [
	{ label: "OpenAI-style key", pattern: /sk-[A-Za-z0-9_-]{20,}/giu },
	{ label: "private identifier", pattern: /heixiaohu/giu },
	{ label: "private host", pattern: /anyrouter|sub2api|127\.0\.0\.1:8317/giu },
];

const credentialAssignmentPattern =
	/(api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*(["'`])((?:\\.|(?!\2)[^\r\n]){20,})\2/giu;

function containsEnvironmentReference(value) {
	return /(^|[^$])\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/u.test(value);
}

function isAllowedReference(credentialName, value) {
	const normalized = value.trim();
	return (
		containsEnvironmentReference(normalized) ||
		// A template interpolation (`Bearer ${auth.apiKey}`) builds the value at
		// runtime; a literal credential never contains one.
		/\$\{[^}]+\}/u.test(normalized) ||
		normalized.startsWith("process.env.") ||
		normalized.startsWith("<redacted") ||
		normalized.startsWith("command:") ||
		normalized.startsWith("cmd:") ||
		normalized.startsWith("env:") ||
		(normalized.startsWith("!") && /api[_-]?key/iu.test(credentialName))
	);
}

function lineNumberAt(source, index) {
	let line = 1;
	for (let offset = 0; offset < index; offset++) {
		if (source.charCodeAt(offset) === 10) line++;
	}
	return line;
}

function scanSource(sourceName, source) {
	const findings = [];
	const seen = new Set();

	const addFinding = (index, label) => {
		if (allowed.has(lineFingerprint(source, index))) return;
		const line = lineNumberAt(source, index);
		const key = `${line}:${label}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push(`${sourceName}:${line}: ${label} [redacted]`);
	};

	for (const { label, pattern } of highConfidencePatterns) {
		pattern.lastIndex = 0;
		for (const match of source.matchAll(pattern)) addFinding(match.index, label);
	}

	credentialAssignmentPattern.lastIndex = 0;
	for (const match of source.matchAll(credentialAssignmentPattern)) {
		const credentialName = match[1] ?? "";
		const value = match[3] ?? "";
		if (!isAllowedReference(credentialName, value)) addFinding(match.index, "credential-like literal");
	}

	return findings;
}

let findings = [];
if (mode === "--files") {
	const paths = readFileSync(0).toString("utf8").split("\0").filter(Boolean);
	for (const path of paths) {
		if (scannerFiles.has(path)) continue;
		let source;
		try {
			source = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		findings.push(...scanSource(path, source));
	}
} else if (mode === "--stream") {
	findings = scanSource(process.argv[3] ?? "stream", readFileSync(0, "utf8"));
} else {
	console.error("usage: scan-secrets.mjs --files | --stream <label>");
	process.exit(2);
}

if (findings.length > 0) {
	console.log(findings.join("\n"));
	process.exit(1);
}
