import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway directory tree; `files` maps relative paths to contents (a trailing "/" makes a directory). */
export function makeTree(files: Record<string, string> = {}): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "trellis-lite-"));
	writeTree(root, files);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		if (path.endsWith("/")) {
			mkdirSync(full, { recursive: true });
			continue;
		}
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

type Handler = (event: any, ctx: any) => unknown;

/** Minimal ExtensionAPI stand-in: records handlers, commands, entries, and sent messages. */
export function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const sent: string[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, options);
		},
		sendUserMessage(text: string) {
			sent.push(text);
		},
	};
	const emit = async (event: string, payload: any, ctx: any = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const value = await handler(payload, ctx);
			if (value !== undefined) result = value;
		}
		return result as any;
	};
	return { api: api as any, handlers, commands, sent, emit };
}

export function fakeCtx(cwd: string, extra: Record<string, unknown> = {}) {
	const notes: Array<{ text: string; level: string }> = [];
	return {
		cwd,
		hasUI: true,
		notes,
		ui: {
			notify: (text: string, level = "info") => notes.push({ text, level }),
			confirm: async () => true,
			input: async (_title: string, placeholder?: string) => placeholder,
			select: async (_title: string, options: string[]) => options[0],
		},
		...extra,
	};
}
