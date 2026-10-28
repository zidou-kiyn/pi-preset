// The termius approval gate: levels, dialogs, session allows, refusals,
// result annotation, and the activity it records.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PI_PRESET_LANG = "en";

const { TermiusGate } = await import("../src/termius/gate.ts");
const { HostIndex } = await import("../src/termius/host-index.ts");
const { SessionGrants } = await import("../src/termius/session-state.ts");
type Config = import("../src/termius/config.ts").TermiusConfig;
type Entry = import("../src/termius/activity.ts").ActivityEntry;

const ROWS = [
	{ id: 1, cloud_id: "101", label: "bastion", address: "1.2.3.4", route: { mode: "termius", source: "global", jump_hosts: [], proxy: null }, via: [] },
	{ id: 2, cloud_id: "102", label: "web", address: "10.0.0.2", route: { mode: "termius", source: "global", jump_hosts: ["bastion"], proxy: null }, via: ["101"] },
	{ id: 3, cloud_id: "103", label: "db", address: "10.0.0.3", route: { mode: "direct", source: "host", jump_hosts: [], proxy: null }, via: [] },
];

function setup(config: Config = { mode: "auto" }, pick: (labels: string[], title: string) => string | undefined = () => undefined) {
	const records: Entry[] = [];
	const saved: [string, string][] = [];
	const dialogs: { title: string; labels: string[] }[] = [];
	let active: string[] = [];
	let grantsChanged = 0;
	const hosts = new HostIndex(async () => ({ ok: true, logged_in: true, hosts: ROWS }));
	const grants = new SessionGrants();
	const gate = new TermiusGate({
		config: () => config,
		grants,
		hosts,
		saveHostLevel: (key, level) => {
			saved.push([key, level]);
			config.hosts = { ...config.hosts, [key]: { level } };
		},
		grantsChanged: () => grantsChanged++,
		record: (entry) => records.push(entry),
		activeChanged: (labels) => {
			active = labels;
		},
	});
	let reasonText: string | undefined = "use reload";
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: async (title: string, labels: string[]) => {
				dialogs.push({ title, labels });
				return pick(labels, title);
			},
			input: async () => reasonText,
		},
	};
	let id = 0;
	const call = (tool: string, input: Record<string, unknown>, context: object = ctx) =>
		gate.onToolCall({ toolName: `mcp__termius__${tool}`, toolCallId: `c${++id}`, input }, context as never).then((result) => ({ result, id: `c${id}` }));
	const finish = (callId: string, tool: string, data: Record<string, unknown>, isError = false) =>
		gate.onToolResult({ toolName: `mcp__termius__${tool}`, toolCallId: callId, input: {}, content: [], structuredContent: data, isError });
	return {
		gate,
		grants,
		hosts,
		config,
		records,
		saved,
		dialogs,
		call,
		finish,
		active: () => active,
		grantsChanged: () => grantsChanged,
		setReason: (text: string | undefined) => {
			reasonText = text;
		},
	};
}

const pickLabel = (pattern: RegExp) => (labels: string[]) => labels.find((label) => pattern.test(label));

test("a read on an auto host runs and is logged with its route and exit code", async () => {
	const t = setup();
	const { result, id } = await t.call("exec", { name: "web", command: "uptime" });
	assert.equal(result, undefined);
	assert.deepEqual(t.active(), ["web"]);
	t.finish(id, "exec", { command: "uptime", route: ["jump host bastion (1.2.3.4)"], exit_code: 0 });
	assert.deepEqual(t.active(), []);
	assert.equal(t.dialogs.length, 0);
	assert.equal(t.records.length, 1);
	assert.deepEqual({ ...t.records[0], time: "" }, {
		time: "",
		host: "web",
		key: "102",
		tool: "exec",
		detail: "uptime",
		decision: "auto",
		route: "jump host bastion (1.2.3.4)",
		exit: 0,
	});
});

test("a write asks; a session allow covers the host under any name", async () => {
	const t = setup({ mode: "auto" }, pickLabel(/for this session/));
	const first = await t.call("exec", { name: "web", command: "systemctl restart nginx" });
	assert.equal(first.result, undefined);
	assert.equal(t.dialogs.length, 1);
	assert.match(t.dialogs[0]!.title, /termius \(auto\): run on web\?/);
	assert.match(t.dialogs[0]!.title, /Why: systemctl restart is not a read-only subcommand/);
	assert.match(t.dialogs[0]!.title, /route bastion/);
	assert.equal(t.grantsChanged(), 1);
	const second = await t.call("exec", { name: "2", command: "rm /tmp/x" });
	assert.equal(second.result, undefined);
	assert.equal(t.dialogs.length, 1, "no second question");
	t.finish(first.id, "exec", { exit_code: 0 });
	t.finish(second.id, "exec", { exit_code: 0 });
	assert.deepEqual(t.records.map((entry) => entry.decision), ["session", "session"]);
});

test("calls waiting behind a dialog are re-checked when their turn comes", async () => {
	let release: (value: string | undefined) => void = () => {};
	const t = setup({ mode: "review" });
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: (_title: string, labels: string[]) => {
				t.dialogs.push({ title: "", labels });
				return new Promise<string | undefined>((resolve) => {
					release = () => resolve(labels.find((label) => /for this session/.test(label)));
				});
			},
		},
	};
	const a = t.call("exec", { name: "db", command: "uptime" }, ctx);
	const b = t.call("exec", { name: "db", command: "df -h" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(t.dialogs.length, 1, "one dialog at a time");
	release(undefined);
	assert.equal((await a).result, undefined);
	assert.equal((await b).result, undefined);
	assert.equal(t.dialogs.length, 1, "the queued call was settled by the session allow");
});

test("read-only refuses writes without asking; off refuses everything", async () => {
	const t = setup({ mode: "auto", hosts: { "102": { level: "read-only" }, "103": { level: "off" } } });
	assert.equal((await t.call("exec", { name: "web", command: "cat /etc/hosts" })).result, undefined);
	const write = (await t.call("files", { name: "web", action: "put", path: "/etc/x" })).result;
	assert.match(write!.reason, /web is read-only/);
	const off = (await t.call("exec", { name: "db", command: "uptime" })).result;
	assert.match(off!.reason, /db is disabled by the user in \/termius/);
	assert.equal(t.dialogs.length, 0);
	assert.deepEqual(t.records.map((entry) => entry.decision), ["refused", "refused"]);
});

test("a temporary level beats the host level", async () => {
	const t = setup({ mode: "auto", hosts: { "102": { level: "read-only" } } });
	t.grants.setTemporary("102", "trusted");
	assert.equal((await t.call("exec", { name: "web", command: "systemctl restart nginx" })).result, undefined);
	assert.equal(t.dialogs.length, 0);
});

test("catastrophic commands ask on a trusted host, with fewer choices", async () => {
	const t = setup({ mode: "trusted" }, pickLabel(/^Deny$/));
	const { result } = await t.call("exec", { name: "web", command: "sudo reboot" });
	assert.match(result!.reason, /denied/);
	assert.match(t.dialogs[0]!.title, /catastrophic command on web/);
	assert.match(t.dialogs[0]!.title, /reboots or powers off the host/);
	assert.ok(!t.dialogs[0]!.labels.some((label) => /session|Always trust/.test(label)), t.dialogs[0]!.labels.join(" | "));
	assert.equal((await t.call("exec", { name: "web", command: "systemctl restart nginx" })).result, undefined, "ordinary writes run");
});

test("always trust and deny-and-disable save the host level", async () => {
	const trust = setup({ mode: "review" }, pickLabel(/Always trust/));
	await trust.call("exec", { name: "web", command: "uptime" });
	assert.deepEqual(trust.saved, [["102", "trusted"]]);
	assert.equal((await trust.call("exec", { name: "web", command: "rm x" })).result, undefined);
	assert.equal(trust.dialogs.length, 1);

	const disable = setup({ mode: "review" }, pickLabel(/Deny and disable/));
	const { result } = await disable.call("exec", { name: "db", command: "uptime" });
	assert.deepEqual(disable.saved, [["103", "off"]]);
	assert.match(result!.reason, /disabled db/);
});

test("deny with a reason passes the reason to the agent", async () => {
	const t = setup({ mode: "auto" }, pickLabel(/tell the agent why/));
	const { result } = await t.call("exec", { name: "web", command: "systemctl restart nginx" });
	assert.match(result!.reason, /said: "use reload"/);
	t.setReason("");
	const plain = await t.call("exec", { name: "web", command: "systemctl restart nginx" });
	assert.match(plain.result!.reason, /The user denied this remote command\. Ask/);
});

test("without a UI a question becomes a block", async () => {
	const t = setup({ mode: "review" });
	const { result } = await t.call("exec", { name: "web", command: "uptime" }, { hasUI: false, mode: "print", ui: {} });
	assert.match(result!.reason, /no UI to ask in/);
	assert.equal(t.records[0]!.decision, "no-ui");
});

test("an unknown name refreshes the list once, then falls back to the global level", async () => {
	let loads = 0;
	const t = setup({ mode: "auto" });
	const gate = new TermiusGate({
		config: () => t.config,
		grants: t.grants,
		hosts: new HostIndex(async () => {
			loads++;
			return { ok: true, logged_in: true, hosts: ROWS };
		}),
		saveHostLevel() {},
		grantsChanged() {},
		record() {},
		activeChanged() {},
	});
	assert.equal(await gate.onToolCall({ toolName: "mcp__termius__exec", toolCallId: "x", input: { name: "nope", command: "uptime" } }, { hasUI: false } as never), undefined);
	assert.equal(loads, 1);
});

test("hosts and host results get the effective level", async () => {
	const t = setup({ mode: "auto", hosts: { "103": { level: "read-only" } } });
	t.grants.allow("102");
	const data = { hosts: [{ cloud_id: "102", label: "web" }, { cloud_id: "103", label: "db" }], count: 2 };
	const result = t.gate.onToolResult({
		toolName: "mcp__termius__hosts",
		toolCallId: "h",
		input: {},
		content: [{ type: "text", text: "2 hosts." }, { type: "text", text: JSON.stringify(data) }],
		structuredContent: data,
		isError: false,
	});
	const rows = (result!.structuredContent as { hosts: Record<string, unknown>[] }).hosts;
	assert.deepEqual(rows[0], { cloud_id: "102", label: "web", access: "auto", access_source: "global", session_allowed: true });
	assert.deepEqual(rows[1], { cloud_id: "103", label: "db", access: "read-only", access_source: "host" });
	assert.equal(result!.content![0]!.text, "2 hosts.");
	assert.deepEqual(JSON.parse(result!.content![1]!.text!), result!.structuredContent);

	const one = t.gate.onToolResult({
		toolName: "mcp__termius__host",
		toolCallId: "h2",
		input: {},
		content: [],
		structuredContent: { cloud_id: "103" },
		isError: false,
	});
	assert.equal((one!.structuredContent as Record<string, unknown>).access, "read-only");
});

test("a failed call is logged with its error code", async () => {
	const t = setup();
	const { id } = await t.call("files", { name: "web", action: "list", path: "/srv" });
	t.finish(id, "files", { error: "boom", code: "ssh_failed" }, true);
	assert.equal(t.records[0]!.error, "ssh_failed");
	assert.equal(t.records[0]!.detail, "list /srv");
});
