/**
 * Character budgets. A "character" is a UTF-16 code unit (JavaScript string
 * length): CJK text counts one per character, not three as in UTF-8 bytes.
 * Truncation never splits a surrogate pair.
 */

export function truncateChars(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = Math.max(0, max);
	const code = text.charCodeAt(end - 1);
	if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate without its pair
	return text.slice(0, end);
}
