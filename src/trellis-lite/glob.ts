/**
 * Repository-relative globs for spec `paths:`.
 *
 * `*` matches inside one path segment, `?` one character of a segment, a
 * segment that is exactly `**` matches zero or more whole segments, and a
 * trailing `/` means "everything below". Everything else is literal, so
 * `[slug]`, `(group)`, `@scope` and non-ASCII names need no escaping. Matching
 * ignores case on macOS and Windows, whose file systems do.
 */

export function globError(glob: string): string | undefined {
	if (glob === "") return "empty glob";
	if (glob.startsWith("/")) return "globs are relative to the repository root";
	if (glob.includes("\\")) return "use / as the separator";
	if (glob.split("/").includes("..")) return "`..` is not allowed";
	if (/[\u0000-\u001f\u007f]/u.test(glob)) return "control characters are not allowed";
	return undefined;
}

const escapeChar = (ch: string) => (/[\\^$.|+(){}[\]]/u.test(ch) ? `\\${ch}` : ch);

export function compileGlob(glob: string, ignoreCase = process.platform === "darwin" || process.platform === "win32"): RegExp {
	const expanded = glob.endsWith("/") ? `${glob}**` : glob;
	const segments = expanded.split("/");
	let source = "";
	segments.forEach((segment, index) => {
		const last = index === segments.length - 1;
		if (segment === "**") {
			source += last ? ".*" : "(?:[^/]+/)*";
			return;
		}
		for (const ch of segment) source += ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : escapeChar(ch);
		if (!last) source += "/";
	});
	return new RegExp(`^${source}$`, ignoreCase ? "iu" : "u");
}

/**
 * Sort key: exact paths first, then globs with more literal segments, fewer
 * wildcards, and longer literal text. Lower sorts first.
 */
export function specificity(glob: string): number[] {
	const expanded = glob.endsWith("/") ? `${glob}**` : glob;
	const wildcards = (expanded.match(/[*?]/gu) ?? []).length;
	const literalSegments = expanded.split("/").filter((segment) => !/[*?]/u.test(segment)).length;
	return [wildcards === 0 ? 0 : 1, -literalSegments, wildcards, -(expanded.length - wildcards)];
}

export function compareSpecificity(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
