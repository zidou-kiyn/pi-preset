// Termius per-host policy: config v2, access levels, catastrophic rules,
// session grants, and the host index.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-termius-policy-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const { configPath, markKnown, parseConfig, readConfig, updateConfig, updateHost, writeConfig } = await import("../src/termius/config.ts");
const { decide, effectiveLevel, parseGlobalLevel, stricter } = await import("../src/termius/levels.ts");
const { catastrophicRule, commandWriteReason, isSystemPath, writeReason } = await import("../src/termius/approval.ts");
const { lastSnapshot, SESSION_ENTRY, SessionGrants } = await import("../src/termius/session-state.ts");
const { HostIndex } = await import("../src/termius/host-index.ts");
const { ACTIVITY_LIMIT, activityPath, activityToday, appendActivity, clearActivity, readActivity } = await import("../src/termius/activity.ts");
const { formatEntry } = await import("../src/termius/activity-view.ts");
process.env.PI_PRESET_LANG = "en";

// ── config ──────────────────────────────────────────────────────────────────

test("config: dangerously reads as trusted; invalid fields are dropped", () => {
	const config = parseConfig({
		mode: "dangerously",
		route: "termius",
		proxy: " socks5://h:1 ",
		enabled: true,
		hosts: { "1": { level: "off", route: "direct", proxy: "", label: "a" }, "2": { level: "bogus" }, "3": "x" },
		knownHosts: ["1", 2],
	});
	assert.deepEqual(config, {
		mode: "trusted",
		proxy: "socks5://h:1",
		hosts: { "1": { level: "off", route: "direct", label: "a" }, "2": {} },
		knownHosts: ["1"],
	});
	assert.deepEqual(parseConfig(null), { mode: "auto" });
	assert.equal(parseConfig({ route: "proxy" }).route, "proxy");
});

test("config: writes are atomic, 0600, and re-read before a change", () => {
	writeConfig({ mode: "review" });
	assert.equal(readConfig().mode, "review");
	if (process.platform !== "win32") assert.equal(statSync(configPath()).mode & 0o777, 0o600);
	// Another window changed the file; an update starts from that.
	writeConfig({ mode: "review", route: "direct" });
	const saved = updateConfig((config) => ({ ...config, mode: "trusted" }));
	assert.deepEqual(saved, { mode: "trusted", route: "direct" });
	assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), saved);
});

test("config: host settings; an empty entry is removed", () => {
	let config = updateHost({ mode: "auto" }, "7", { level: "read-only" }, "web");
	assert.deepEqual(config.hosts, { "7": { level: "read-only", label: "web" } });
	config = updateHost(config, "7", { route: "direct", proxy: "socks5://x:1" });
	assert.deepEqual(config.hosts?.["7"], { level: "read-only", label: "web", route: "direct", proxy: "socks5://x:1" });
	config = updateHost(config, "7", { level: undefined, route: undefined, proxy: undefined });
	assert.equal(config.hosts, undefined);
});

test("config: known hosts", () => {
	const config = markKnown({ mode: "auto" }, ["2", "1"]);
	assert.deepEqual(config.knownHosts, ["1", "2"]);
	assert.equal(markKnown(config, ["1"]), config, "unchanged when nothing is new");
});

// ── levels ──────────────────────────────────────────────────────────────────

test("levels: precedence is temporary, host, global", () => {
	assert.deepEqual(effectiveLevel({ globalLevel: "auto" }), { level: "auto", source: "global", sessionAllowed: false });
	assert.equal(effectiveLevel({ globalLevel: "auto", hostLevel: "read-only" }).level, "read-only");
	assert.deepEqual(effectiveLevel({ globalLevel: "auto", hostLevel: "read-only", temporaryLevel: "trusted", sessionAllowed: true }), {
		level: "trusted",
		source: "temporary",
		sessionAllowed: true,
	});
	assert.equal(parseGlobalLevel("dangerously"), "trusted");
	assert.equal(parseGlobalLevel("off"), undefined, "off is not a global level");
});

test("levels: what each level decides", () => {
	const at = (level: "off" | "read-only" | "review" | "auto" | "trusted", sessionAllowed = false) => ({ level, source: "host" as const, sessionAllowed });
	const run = { action: "run" };
	const ask = { action: "ask", catastrophic: false };
	const askCatastrophic = { action: "ask", catastrophic: true };
	assert.deepEqual(decide(at("off"), "read", false), { action: "refuse", because: "off" });
	assert.deepEqual(decide(at("read-only"), "read", false), run);
	assert.deepEqual(decide(at("read-only"), "write", false), { action: "refuse", because: "read-only" });
	assert.deepEqual(decide(at("read-only", true), "write", false), { action: "refuse", because: "read-only" }, "a session allow does not lift read-only");
	assert.deepEqual(decide(at("review"), "read", false), ask);
	assert.deepEqual(decide(at("review", true), "write", false), run);
	assert.deepEqual(decide(at("auto"), "read", false), run);
	assert.deepEqual(decide(at("auto"), "write", false), ask);
	assert.deepEqual(decide(at("trusted"), "write", false), run);
	assert.deepEqual(decide(at("trusted"), "write", true), askCatastrophic);
	assert.deepEqual(decide(at("auto", true), "write", true), askCatastrophic, "catastrophic asks despite a session allow");
	assert.deepEqual(decide(at("read-only"), "write", true), { action: "refuse", because: "read-only" });
	assert.equal(stricter(at("auto"), at("read-only")).level, "read-only");
	assert.equal(stricter(at("auto", true), at("auto")).sessionAllowed, false);
});

// ── classification ──────────────────────────────────────────────────────────

test("write reasons name what made a call a write", () => {
	assert.deepEqual(commandWriteReason("echo hi > /etc/motd"), { code: "construct" });
	assert.deepEqual(commandWriteReason("ls; systemctl restart nginx"), { code: "subcommand", program: "systemctl", subcommand: "restart" });
	assert.deepEqual(commandWriteReason("sed -i s/a/b/ f"), { code: "argument", program: "sed" });
	assert.deepEqual(commandWriteReason("apt-get upgrade"), { code: "program", program: "apt-get" });
	assert.equal(commandWriteReason("df -h | sort"), undefined);
	assert.deepEqual(writeReason("files", { action: "put" }), { code: "file-action", action: "put" });
	assert.equal(writeReason("files", { action: "read" }), undefined);
});

test("catastrophic commands are caught behind sudo, sh -c, and substitutions", () => {
	const cases: [string, string][] = [
		["rm -rf /", "wipe-system-path"],
		["sudo rm -rf --no-preserve-root /", "wipe-system-path"],
		["rm -fr /etc", "wipe-system-path"],
		["rm -r -f /var/*", "wipe-system-path"],
		["rm -rf ~", "wipe-system-path"],
		["sudo -u root rm -rf /usr/", "wipe-system-path"],
		["mkfs.ext4 /dev/sdb1", "format-disk"],
		["wipefs -a /dev/sdb", "format-disk"],
		["dd if=/dev/zero of=/dev/sda bs=1M", "write-disk"],
		["cat image > /dev/nvme0n1", "write-disk"],
		["fdisk /dev/sda", "partition"],
		["parted /dev/sda mklabel gpt", "partition"],
		["reboot", "power"],
		["sudo shutdown -h now", "power"],
		["init 6", "power"],
		["systemctl reboot", "power"],
		["iptables -F", "firewall"],
		["iptables -P INPUT DROP", "firewall"],
		["nft flush ruleset", "firewall"],
		["ufw disable", "firewall"],
		["systemctl stop sshd", "ssh-daemon"],
		["systemctl disable ssh.service", "ssh-daemon"],
		["service ssh stop", "ssh-daemon"],
		["pkill sshd", "ssh-daemon"],
		["userdel -r bob", "delete-user"],
		["chmod -R 777 /", "system-permissions"],
		["chown -R nobody /etc", "system-permissions"],
		["kill -9 1", "kill-init"],
		[":(){ :|:& };:", "fork-bomb"],
		["bash -c 'reboot'", "power"],
		["sudo sh -c \"rm -rf /\"", "wipe-system-path"],
		["echo $(reboot)", "power"],
		["timeout 5 nice -n 10 reboot", "power"],
		["env FOO=1 reboot", "power"],
	];
	for (const [command, rule] of cases) assert.equal(catastrophicRule("exec", { command }), rule, command);
});

test("ordinary commands are not catastrophic", () => {
	for (const command of [
		"rm -rf /tmp/build",
		"rm -rf ./node_modules",
		"rm /etc/nginx/sites-enabled/default",
		"grep reboot /var/log/syslog",
		"echo 'reboot later'",
		"systemctl restart nginx",
		"systemctl status sshd",
		"fdisk -l",
		"parted /dev/sda print",
		"dd if=/dev/sda of=/tmp/mbr bs=512 count=1",
		"dd if=x of=/dev/null",
		"iptables -L -n",
		"kill -9 1234",
		"chmod -R 755 /srv/app",
		"docker restart web",
	]) {
		assert.equal(catastrophicRule("exec", { command }), undefined, command);
	}
	assert.equal(catastrophicRule("files", { action: "rm", path: "/", recursive: true }), "wipe-system-path");
	assert.equal(catastrophicRule("files", { action: "rm", path: "/srv/app/tmp", recursive: true }), undefined);
	assert.equal(isSystemPath("/home/u/project"), false);
	assert.equal(isSystemPath("/etc/"), true);
});

// ── session grants ──────────────────────────────────────────────────────────

test("session grants snapshot and come back from the newest entry", () => {
	const grants = new SessionGrants();
	grants.allow("1");
	grants.setTemporary("2", "trusted");
	assert.equal(grants.count, 2);
	const snapshot = grants.snapshot();
	assert.deepEqual(snapshot, { allowed: ["1"], temporary: { "2": "trusted" } });
	const entries = [
		{ type: "custom", customType: SESSION_ENTRY, data: { allowed: ["9"], temporary: {} } },
		{ type: "message" },
		{ type: "custom", customType: SESSION_ENTRY, data: { ...snapshot, temporary: { ...snapshot.temporary, "3": "bogus" } } },
		{ type: "custom", customType: "other", data: {} },
	];
	const restored = new SessionGrants();
	restored.restore(lastSnapshot(entries));
	assert.deepEqual(restored.snapshot(), snapshot);
	assert.equal(lastSnapshot([]), undefined);
	grants.revoke("1");
	grants.setTemporary("2", undefined);
	assert.equal(grants.count, 0);
});

// ── host index ──────────────────────────────────────────────────────────────

const ROWS = [
	{ id: 1, cloud_id: "101", label: "bastion", address: "1.2.3.4", port: 22, route: { mode: "termius", source: "global", jump_hosts: [], proxy: null }, via: [] },
	{ id: 2, cloud_id: "102", label: "web", address: "10.0.0.2", route: { mode: "direct", source: "host", jump_hosts: [] }, via: ["101"], tags: ["prod"] },
	{ id: 3, cloud_id: "103", label: "web", address: "10.0.0.3", via: ["101"] },
	{ id: 4, cloud_id: "104", label: "2", address: "10.0.0.4" },
	{ label: "no cloud id" },
];

test("the host index resolves ids and labels, and counts jump host use", async () => {
	let calls = 0;
	const index = new HostIndex(async (sync) => {
		calls++;
		assert.equal(sync, true);
		return { ok: true, logged_in: true, hosts: ROWS, last_synced: "2026-10-29T00:00:00" };
	});
	const [first, second] = await Promise.all([index.refresh(true), index.refresh(true)]);
	assert.equal(calls, 1, "concurrent refreshes share one load");
	assert.equal(first, second);
	assert.deepEqual(index.current?.rows.map((row) => row.label), ["2", "bastion", "web", "web"]);
	assert.deepEqual(index.resolve("bastion").map((row) => row.cloud_id), ["101"]);
	assert.deepEqual(index.resolve("web").map((row) => row.cloud_id).sort(), ["102", "103"]);
	assert.deepEqual(index.resolve("2").map((row) => row.cloud_id).sort(), ["102", "104"], "id 2 and the host labelled 2");
	assert.equal(index.find("102")?.route.mode, "direct");
	assert.deepEqual(index.find("102")?.tags, ["prod"]);
	assert.equal(index.jumpHostFor("101"), 2);
	assert.equal(index.jumpHostFor("102"), 0);
});

// ── activity ──

test("the activity log keeps the newest entries, 0600, newest first", () => {
	clearActivity();
	const base = Date.parse("2026-10-29T08:00:00");
	for (let i = 0; i < 600; i++) {
		appendActivity({ time: new Date(base + i * 1000).toISOString(), host: `h${i}`, tool: "exec", detail: "uptime", decision: "auto", exit: 0 });
	}
	const entries = readActivity();
	assert.equal(entries.length, ACTIVITY_LIMIT);
	assert.equal(entries[0]!.host, "h599");
	if (process.platform !== "win32") assert.equal(statSync(activityPath()).mode & 0o777, 0o600);
	appendActivity({ time: new Date(base).toISOString(), host: "x", tool: "exec", detail: "y".repeat(800), decision: "denied" });
	assert.equal(readActivity()[0]!.detail.length, 501, "long commands are cut");
	const today = activityToday(readActivity(), new Date(base + 3_600_000));
	assert.equal(today.denied, 1);
	clearActivity();
	assert.deepEqual(readActivity(), []);
});

test("an activity line has time, host, decision, result, route, and command", () => {
	const line = formatEntry({
		time: new Date(2026, 9, 29, 14, 3).toISOString(),
		host: "web",
		tool: "exec",
		detail: "systemctl status nginx",
		decision: "auto",
		route: "proxy socks5://127.0.0.1:7890 (ALL_PROXY) → jump host bastion (1.2.3.4)",
		exit: 0,
	});
	assert.equal(line, "10-29 14:03 web · auto · exit 0 · proxy → bastion · systemctl status nginx");
	const refused = formatEntry({ time: "x", host: "db", tool: "files", detail: "put /etc/x", decision: "refused" });
	assert.equal(refused, "x db · refused · files put /etc/x");
});

test("the footer text: route and grants at rest, the host while a call runs", async () => {
	const { footerIsEmpty, footerText } = await import("../src/termius/footer-state.ts");
	const name = (mode: string) => mode;
	assert.equal(footerIsEmpty({ grants: 0, moreActive: 0 }), true);
	assert.equal(footerText({ route: "direct", grants: 2, moreActive: 0 }, name), "direct +2");
	assert.equal(footerText({ route: "direct", grants: 2, moreActive: 0 }, name, true), "+2");
	assert.equal(footerText({ route: "direct", grants: 0, moreActive: 0 }, name, true), "direct");
	assert.equal(footerText({ grants: 1, active: "web", moreActive: 1 }, name), "web +1");
});

test("a failed refresh keeps the last list and reports why", async () => {
	let fail = false;
	const index = new HostIndex(async () => {
		if (fail) return { ok: false, code: "policy_unreadable", error: "bad file" };
		return { ok: true, logged_in: true, hosts: ROWS };
	});
	await index.refresh();
	fail = true;
	const list = await index.refresh();
	assert.equal(list?.rows.length, 4);
	assert.equal(index.error, "bad file");
});
