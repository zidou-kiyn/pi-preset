/** /termius → Recent activity: the log, newest first, a page at a time. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MenuItem, type Notice, showMenu } from "../preset-menu.ts";
import type { ActivityEntry } from "./activity.ts";
import { shortRoute } from "./format.ts";
import { type Messages, messages } from "./messages.ts";

export const PAGE_SIZE = 15;

function two(n: number): string {
	return String(n).padStart(2, "0");
}

/** One log line: "10-29 14:03 web · auto · exit 0 · bastion · systemctl status nginx". */
export function formatEntry(entry: ActivityEntry, m: Messages = messages()): string {
	const time = new Date(entry.time);
	const when = Number.isNaN(time.getTime()) ? entry.time : `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
	const parts = [`${when} ${entry.host}`, m.decision(entry.decision)];
	if (entry.error) parts.push(entry.error);
	else if (entry.exit !== undefined) parts.push(m.exitCode(entry.exit));
	if (entry.decision !== "refused" && entry.decision !== "denied" && entry.decision !== "no-ui") parts.push(shortRoute(entry.route, m));
	parts.push(entry.tool === "exec" ? entry.detail : `files ${entry.detail}`);
	return parts.join(" · ");
}

export async function runActivityView(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	deps: { read(): ActivityEntry[]; clear(): void },
): Promise<Notice | undefined> {
	let page = 0;
	let notice: Notice | undefined;
	let selected: string | undefined;
	for (;;) {
		const entries = deps.read();
		const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
		page = Math.min(page, pages - 1);
		const choice = await showMenu(ctx, () => {
			const m = messages();
			const shown = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
			const status = entries.length === 0 ? [m.activityEmpty] : [m.activityPage(page * PAGE_SIZE + 1, page * PAGE_SIZE + shown.length, entries.length), ...shown.map((entry) => formatEntry(entry, m))];
			const items: MenuItem[] = [];
			if (page < pages - 1) items.push({ value: "older", label: m.activityOlder });
			if (page > 0) items.push({ value: "newer", label: m.activityNewer });
			if (entries.length > 0) items.push({ value: "clear", label: m.activityClear });
			return { title: m.activityTitle, status, notice, items, selected, cancelLabel: m.back };
		});
		if (!choice) return undefined;
		selected = choice;
		if (choice === "older") page++;
		else if (choice === "newer") page--;
		else if (choice === "clear") {
			deps.clear();
			page = 0;
			notice = { text: messages().activityCleared, type: "success" };
		}
	}
}
