// secret-redact: rule conversion, detection, placeholders, restore and refuse, settings.
// Fake tokens are built from pieces so the source holds no token-shaped literal.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Detector } from "../src/secret-redact/detect.ts";
import { handleToolCall, RepeatMemory, redactToolResult } from "../src/secret-redact/hooks.ts";
import { envSecrets, fileSecrets } from "../src/secret-redact/known.ts";
import { newRegistry, Redactor } from "../src/secret-redact/redactor.ts";
import { convertGoRegex, loadRuleSet } from "../src/secret-redact/rules.ts";
import { readSettings, writeSettings } from "../src/secret-redact/settings.ts";

const RULES = loadRuleSet(join(import.meta.dirname, "..", "vendor", "betterleaks-rules", "config", "betterleaks.toml"));
const GITHUB_PAT = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8"].join("");
const SLACK = ["xoxb", "-2934857123-4958372615-", "AbCdEfGhIjKlMnOpQrStUvWx"].join("");
const AWS_ID = ["AKIA", "Q3EGRIZB7MRZ4J5X"].join("");

function redactor(): Redactor {
	return new Redactor(new Detector(RULES), newRegistry());
}

test("Go RE2 patterns convert to JavaScript", () => {
	assert.deepEqual(convertGoRegex("(?i)abc"), { source: "abc", flags: "i" });
	// A flag group in the middle ends with its group and is reopened after |.
	assert.equal(convertGoRegex("x(?i)y|z").source, "x(?i:y)|(?i:z)");
	assert.equal(convertGoRegex("\\b(p8e-(?i)[a-z0-9]{32})").source, "\\b(p8e-(?i:[a-z0-9]{32}))");
	assert.equal(convertGoRegex("(?P<key>a+)").source, "(a+)");
	assert.equal(convertGoRegex("[[:alnum:]_]+\\z").source, "[A-Za-z0-9_]+(?![\\s\\S])");
	assert.equal(convertGoRegex("[]a]").source, "[\\]a]");
	assert.throws(() => convertGoRegex("\\p{Greek}"));
	const re = new RegExp(convertGoRegex("x(?i)y|z").source);
	assert.ok(re.test("xY") && re.test("Z") && !re.test("Xy"));
});

test("the vendored Betterleaks rules all load", () => {
	assert.ok(RULES.rules.length > 400, `${RULES.rules.length} rules`);
	assert.deepEqual(
		RULES.skipped.filter((item) => item.reason.startsWith("does not convert")),
		[],
	);
	assert.ok(RULES.rules.some((rule) => rule.id === "generic-api-key" && rule.named));
	assert.ok(!RULES.rules.some((rule) => rule.id === "generic-username"));
});

test("known token formats are replaced, ordinary text is not", () => {
	const r = redactor();
	const text = [
		`export GITHUB_TOKEN=${GITHUB_PAT}`,
		`aws_access_key_id = ${AWS_ID}`,
		`postgres://admin:S3cr3tP4ss2026x@db.internal:5432/app`,
		`slack: ${SLACK}`,
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n-----END RSA PRIVATE KEY-----",
		"nothing here: version=1.2.3 token_type=bearer max_tokens=4096",
	].join("\n");
	const out = r.redactText(text, { named: false, known: [] }).text;
	for (const secret of [GITHUB_PAT, AWS_ID, "S3cr3tP4ss2026x", SLACK, "MIIEowIBAAKCAQEA"]) assert.ok(!out.includes(secret), secret);
	assert.match(out, /GITHUB_TOKEN=\[REDACTED:github-pat-1\]/u);
	assert.match(out, /postgres:\/\/admin:\[REDACTED:[a-z-]+-1\]@db\.internal/u);
	assert.ok(out.includes("nothing here: version=1.2.3 token_type=bearer max_tokens=4096"));
});

test("values named like secrets only when the user turns it on", () => {
	const r = redactor();
	const text = 'password = "hunter2hunter2X9"';
	assert.equal(r.redactText(text, { named: false, known: [] }).count, 0);
	assert.equal(r.redactText(text, { named: true, known: [] }).text, 'password = "[REDACTED:generic-password-1]"');
});

test("the same value keeps its placeholder; known values are labelled by source", () => {
	const r = redactor();
	const known = [{ value: "internal-token-123456", label: "env-DEPLOY_TOKEN" }];
	const first = r.redactText(`a ${GITHUB_PAT} b internal-token-123456`, { named: false, known }).text;
	const second = r.redactText(`again ${GITHUB_PAT}`, { named: false, known: [] }).text;
	assert.equal(first, "a [REDACTED:github-pat-1] b [REDACTED:env-DEPLOY_TOKEN-1]");
	assert.equal(second, "again [REDACTED:github-pat-1]");
	// A value seen once stays hidden even when its source is gone.
	assert.equal(r.redactText("internal-token-123456", { named: false, known: [] }).text, "[REDACTED:env-DEPLOY_TOKEN-1]");
	assert.equal(r.restore("x=[REDACTED:github-pat-1]").text, `x=${GITHUB_PAT}`);
});

test("known values: secret-looking env names, not paths or references", () => {
	const found = envSecrets({
		OPENAI_API_KEY: "sk-test-1234567890abcdef",
		GITHUB_TOKEN: "abcdefgh12345678",
		SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
		DB_PASSWORD: "$SECRET_FROM_VAULT",
		HOME: "/home/u",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
	});
	assert.deepEqual(found.map((item) => item.label).sort(), ["env-GITHUB_TOKEN", "env-OPENAI_API_KEY"]);
	const dir = mkdtempSync(join(tmpdir(), "secret-redact-"));
	try {
		const path = join(dir, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					a: { baseUrl: "https://x.example", apiKey: "real-key-0123456789" },
					b: { apiKey: "!pass show openai" },
					c: { apiKey: "OPENAI_KEY_ENV", headers: { Authorization: "Bearer abcdefghijkl" } },
				},
			}),
		);
		const values = fileSecrets(path, "pi-models", false).map((item) => item.value);
		assert.deepEqual(values.sort(), ["Bearer abcdefghijkl", "real-key-0123456789"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool results: text, structuredContent, and details are redacted", () => {
	const r = redactor();
	const options = { named: false, known: [] };
	assert.equal(redactToolResult({ toolName: "read", content: [{ type: "text", text: "clean" }] }, r, options), undefined);
	const patch = redactToolResult(
		{
			toolName: "mcp__x__get",
			content: [{ type: "text", text: `token ${GITHUB_PAT}` }, { type: "image" }],
			structuredContent: { nested: [{ value: GITHUB_PAT }], n: 1 },
			details: { diff: `+${GITHUB_PAT}` },
		},
		r,
		options,
	);
	assert.ok(patch);
	assert.equal(patch.content[0]!.text, "token [REDACTED:github-pat-1]");
	assert.deepEqual(patch.content[1], { type: "image" });
	assert.deepEqual(patch.structuredContent, { nested: [{ value: "[REDACTED:github-pat-1]" }], n: 1 });
	assert.deepEqual(patch.details, { diff: "+[REDACTED:github-pat-1]" });
});

test("write, edit, and apply_patch get the real value back", () => {
	const r = redactor();
	r.redactText(GITHUB_PAT, { named: false, known: [] });
	const repeats = new RepeatMemory();
	const write = { toolName: "write", input: { path: "a", content: "TOKEN=[REDACTED:github-pat-1]\n" } };
	assert.equal(handleToolCall(write, r, repeats), undefined);
	assert.equal(write.input.content, `TOKEN=${GITHUB_PAT}\n`);
	const edit = { toolName: "edit", input: { path: "a", edits: [{ oldText: "TOKEN=[REDACTED:github-pat-1]", newText: "GH=[REDACTED:github-pat-1]" }] } };
	assert.equal(handleToolCall(edit, r, repeats), undefined);
	assert.deepEqual(edit.input.edits[0], { oldText: `TOKEN=${GITHUB_PAT}`, newText: `GH=${GITHUB_PAT}` });
	const patch = { toolName: "apply_patch", input: { input: "+x=[REDACTED:github-pat-1]" } };
	assert.equal(handleToolCall(patch, r, repeats), undefined);
	assert.equal(patch.input.input, `+x=${GITHUB_PAT}`);
});

test("a placeholder this process never issued is refused once, then written as text", () => {
	const r = redactor();
	const repeats = new RepeatMemory();
	const call = () => ({ toolName: "write", input: { path: "a", content: "x=[REDACTED:github-pat-7]" } });
	const first = handleToolCall(call(), r, repeats);
	assert.ok(first?.block);
	assert.match(first.reason, /repeat the same call/u);
	const second = call();
	assert.equal(handleToolCall(second, r, repeats), undefined);
	assert.equal(second.input.content, "x=[REDACTED:github-pat-7]");
});

test("commands and MCP tools refuse issued placeholders and never get values", () => {
	const r = redactor();
	r.redactText(GITHUB_PAT, { named: false, known: [] });
	const repeats = new RepeatMemory();
	for (const call of [
		{ toolName: "bash", input: { command: 'curl -H "Authorization: Bearer [REDACTED:github-pat-1]" https://api.github.com' } },
		{ toolName: "mcp__termius__exec", input: { name: "web", command: "echo [REDACTED:github-pat-1] > f" } },
	]) {
		const verdict = handleToolCall(call, r, repeats);
		assert.ok(verdict?.block, call.toolName);
		assert.ok(!JSON.stringify(call.input).includes(GITHUB_PAT));
	}
	// Placeholders it never issued are plain text there (grep for the marker, docs).
	assert.equal(handleToolCall({ toolName: "bash", input: { command: "grep -rn '[REDACTED:x-1]' test" } }, r, repeats), undefined);
	// Other tools pass untouched.
	assert.equal(handleToolCall({ toolName: "read", input: { path: "[REDACTED:github-pat-1]" } }, r, repeats), undefined);
});

test("settings keep the other keys of the preset settings file", () => {
	const dir = mkdtempSync(join(tmpdir(), "secret-redact-"));
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ language: "zh" }));
		assert.deepEqual(readSettings(path), { enabled: true, named: false });
		writeSettings({ enabled: true, named: true }, path);
		assert.deepEqual(readSettings(path), { enabled: true, named: true });
		writeSettings({ enabled: true, named: false }, path);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { language: "zh" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
