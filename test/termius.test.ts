import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyCommand,
	classifyTermiusCall,
	describeCall,
	needsApproval,
	parseCommand,
} from "../src/termius/approval.ts";
import { guardToolCall } from "../src/termius/guard.ts";
import { sourceHash, VENDOR_DIR } from "../src/termius/install.ts";
import { describeProxy, proxyServerEnv, proxyUrlError, redactProxyUrl } from "../src/termius/proxy.ts";

test("read-only commands are recognised", () => {
	for (const command of [
		"ls -la /var/log",
		"df -h && free -m",
		"tail -n 200 /var/log/nginx/error.log | grep -i timeout",
		"systemctl status nginx --no-pager",
		"docker ps -a",
		"docker logs --tail 50 web 2>&1",
		"journalctl -u app -n 100 --no-pager",
		"kubectl get pods -A",
		"ps aux | sort -rk 3 | head",
		"cat /etc/os-release; uname -a",
		"find /srv -name '*.log' -mtime +7",
		"git -C /srv/app log --oneline -5",
		"top -b -n 1",
		"ip addr",
		"curl -s http://localhost:8080/health",
		"LANG=C df -h",
		"grep foo bar > /dev/null",
		"sed -n '1,20p' /etc/hosts",
		"echo 'a > b'",
	]) {
		assert.equal(classifyCommand(command), "read", command);
	}
});

test("anything that can change the host counts as a write", () => {
	for (const command of [
		"rm -rf /tmp/x",
		"systemctl restart nginx",
		"docker compose up -d",
		"docker rm web",
		"echo hi > /etc/motd",
		"cat a >> b",
		"ls; reboot",
		"ls && apt-get upgrade -y",
		"find / -name x -delete",
		"find . -exec rm {} \\;",
		"sed -i 's/a/b/' f",
		"sudo cat /etc/shadow",
		"ls $(rm -rf /)",
		"ls `id`",
		"echo \"$(whoami)\"",
		"sleep 100 &",
		"curl -X POST http://x",
		"curl -o /tmp/f http://x",
		"ip addr add 10.0.0.2/24 dev eth0",
		"git branch newbranch",
		"awk '{ system(\"rm x\") }' f",
		"top",
		"mount /dev/sdb1 /mnt",
		"crontab -e",
		"python3 -c 'print(1)'",
		"unknowncmd --flag",
		"echo 'unterminated",
	]) {
		assert.equal(classifyCommand(command), "write", command);
	}
});

test("parsing keeps quoted operators inside words", () => {
	const parsed = parseCommand("grep 'a|b' file | wc -l");
	assert.equal(parsed.unsafe, false);
	assert.deepEqual(parsed.segments.map((segment) => segment.words), [["grep", "a|b", "file"], ["wc", "-l"]]);
});

test("files actions and modes", () => {
	assert.equal(classifyTermiusCall("files", { action: "read", path: "/etc/hosts" }), "read");
	assert.equal(classifyTermiusCall("files", { action: "get", path: "x", local_path: "/tmp/x" }), "read");
	assert.equal(classifyTermiusCall("files", { action: "rm", path: "x" }), "write");
	assert.equal(classifyTermiusCall("files", { action: "put", path: "x" }), "write");
	assert.equal(classifyTermiusCall("exec", { command: "uptime" }), "read");

	assert.equal(needsApproval("review", "read"), true);
	assert.equal(needsApproval("auto", "read"), false);
	assert.equal(needsApproval("auto", "write"), true);
	assert.equal(needsApproval("dangerously", "write"), false);
	assert.equal(describeCall("exec", { name: "web", command: "uptime" }), "web$ uptime");
	assert.equal(describeCall("files", { name: "web", action: "rename", path: "a", dest: "b" }), "web: files rename a -> b");
});

test("guard blocks local access to the vault cache, keychain, and process memory", () => {
	const home = "/home/u";
	const blocked = [
		["bash", { command: "cat ~/.termius/secrets" }],
		["bash", { command: "ls -la /home/u/.termius" }],
		["bash", { command: "cd ~ && tar czf x.tgz .termius" }],
		["read", { path: "/home/u/.termius/config" }],
		["ffgrep", { pattern: "x", path: "~/.termius/" }],
		["bash", { command: "secret-tool lookup service termius-mcp:vault" }],
		["bash", { command: "python3 -c 'import keyring; print(keyring.get_password(\"termius-mcp\", \"x\"))'" }],
		["bash", { command: "cat /proc/1234/environ" }],
		["bash", { command: "gdb -p 4321" }],
		["mcp__termius__files", { name: "web", action: "put", local_path: "/home/u/.termius/secrets", path: "/tmp/s" }],
	] as const;
	for (const [tool, input] of blocked) {
		assert.equal(guardToolCall(tool, input, home).block, true, `${tool} ${JSON.stringify(input)}`);
	}
	const allowed = [
		["write", { path: "README.md", content: "Data lives in ~/.termius" }],
		["edit", { path: "src/termius/guard.ts", oldText: "~/.termius", newText: "~/.termius/" }],
		["bash", { command: "ls vendor/termius-mcp" }],
		["bash", { command: "grep -rn termius src" }],
		["mcp__termius__exec", { name: "web", command: "cat ~/.termius/notes" }],
		["mcp__termius__files", { name: "web", action: "get", path: "/var/log/x", local_path: "/tmp/x" }],
	] as const;
	for (const [tool, input] of allowed) {
		assert.equal(guardToolCall(tool, input, home).block, false, `${tool} ${JSON.stringify(input)}`);
	}
});

test("the vendored server hash is stable and covers the Python source", () => {
	const first = sourceHash(VENDOR_DIR);
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.equal(sourceHash(VENDOR_DIR), first);
});

// ── proxy settings ──────────────────────────────────────────────────────────


test("proxy: a configured URL goes to the server; bypass only when set", () => {
	assert.deepEqual(proxyServerEnv({ proxy: "socks5://127.0.0.1:7890" }, {}), {
		TERMIUS_MCP_PROXY: "socks5://127.0.0.1:7890",
		TERMIUS_MCP_PROXY_SOURCE: "/termius proxy",
	});
	assert.equal(proxyServerEnv({ proxy: "http://p:3128", proxyBypass: ["a.example", "10.0.0.0/8"] }, {}).TERMIUS_MCP_NO_PROXY, "a.example,10.0.0.0/8");
	assert.deepEqual(proxyServerEnv({ proxy: "off" }, { ALL_PROXY: "socks5://x:1" }), { TERMIUS_MCP_PROXY: "off" });
});

test("proxy: unset follows pi's system variables, passed explicitly", () => {
	assert.deepEqual(proxyServerEnv({}, { https_proxy: "http://127.0.0.1:7890", NO_PROXY: "corp.example, 10.0.0.0/8" }), {
		TERMIUS_MCP_PROXY: "http://127.0.0.1:7890",
		TERMIUS_MCP_PROXY_SOURCE: "https_proxy",
		TERMIUS_MCP_NO_PROXY: "corp.example,10.0.0.0/8,localhost,127.0.0.0/8,::1",
	});
	assert.equal(proxyServerEnv({}, { ALL_PROXY: "socks5://a:1", HTTPS_PROXY: "http://b:2" }).TERMIUS_MCP_PROXY, "socks5://a:1");
	assert.deepEqual(proxyServerEnv({}, {}), { TERMIUS_MCP_PROXY: "off" });
});

test("proxy: URLs are validated and never shown with credentials", () => {
	assert.equal(proxyUrlError("socks5://user:pw@127.0.0.1:1080"), undefined);
	assert.match(proxyUrlError("ftp://x:1") ?? "", /unsupported scheme ftp/u);
	assert.match(proxyUrlError("127.0.0.1:7890") ?? "", /unsupported scheme|not a URL/u);
	assert.equal(redactProxyUrl("socks5://user:pw@127.0.0.1:1080"), "socks5://***@127.0.0.1:1080");
	const text = describeProxy({ proxy: "socks5://user:pw@127.0.0.1:1080" }, {});
	assert.ok(!text.includes("pw"), text);
	assert.match(describeProxy({}, { ALL_PROXY: "socks5://u:secret@h:1" }), /system ALL_PROXY/u);
	assert.ok(!describeProxy({}, { ALL_PROXY: "socks5://u:secret@h:1" }).includes("secret"));
	assert.equal(describeProxy({}, {}), "direct (no system proxy variables)");
});
