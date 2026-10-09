import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPrivatePermissions, planPrivatePermissions, privateMode } from "../src/permissions.ts";

const posix = process.platform !== "win32" && typeof process.getuid === "function";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "preset-perms-"));
	const agentDir = join(root, "agent");
	const termiusDir = join(root, ".termius");
	mkdirSync(agentDir);
	mkdirSync(termiusDir);
	chmodSync(agentDir, 0o755);
	chmodSync(termiusDir, 0o755);
	for (const name of ["auth.json", "models.json", "models.json.preset-bak", "models.json.bak-123", "mcp.json", "settings.json", "keybindings.json"]) {
		writeFileSync(join(agentDir, name), "{}");
		chmodSync(join(agentDir, name), 0o644);
	}
	return { root, agentDir, termiusDir };
}

const mode = (path: string) => statSync(path).mode & 0o777;

test("only group/other bits are removed", () => {
	assert.equal(privateMode(0o755), 0o700);
	assert.equal(privateMode(0o644), 0o600);
	assert.equal(privateMode(0o400), 0o400, "owner bits are left alone");
});

test("credential files, the agent directory, and ~/.termius become private", { skip: !posix }, () => {
	const { root, agentDir, termiusDir } = setup();
	try {
		const planned = planPrivatePermissions({ agentDir, termiusDir });
		const paths = planned.map((change) => change.path.slice(root.length + 1));
		assert.deepEqual(paths, [
			"agent",
			"agent/auth.json",
			"agent/mcp.json",
			"agent/models.json",
			"agent/models.json.bak-123",
			"agent/models.json.preset-bak",
			".termius",
		]);
		applyPrivatePermissions(planned);
		assert.equal(mode(agentDir), 0o700);
		assert.equal(mode(join(agentDir, "models.json.bak-123")), 0o600);
		assert.equal(mode(termiusDir), 0o700);
		assert.equal(mode(join(agentDir, "settings.json")), 0o644, "non-credential files are left alone");
		assert.deepEqual(planPrivatePermissions({ agentDir, termiusDir }), [], "converges");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("symlinks and missing paths are skipped", { skip: !posix }, () => {
	const { root, agentDir } = setup();
	try {
		const outside = join(root, "outside.json");
		writeFileSync(outside, "{}");
		chmodSync(outside, 0o644);
		rmSync(join(agentDir, "auth.json"));
		symlinkSync(outside, join(agentDir, "auth.json"));
		const planned = planPrivatePermissions({ agentDir, termiusDir: join(root, "missing") });
		assert.ok(!planned.some((change) => change.path.endsWith("auth.json")));
		applyPrivatePermissions(planned);
		assert.equal(mode(outside), 0o644, "a symlink target outside the agent dir is not touched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
