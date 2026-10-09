import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionKey } from "../extensions/vibrant-footer.ts";

test("vendored packages count once, other package extensions per file, non-package sources not at all", () => {
	const root = "/home/u/.pi/agent/git/github.com/zidou-kiyn/pi-preset";
	const source = "git:github.com/zidou-kiyn/pi-preset";
	const pkg = (path: string) => ({ origin: "package", source, path });

	assert.equal(extensionKey(pkg(`${root}/vendor/pi-fff/src/index.ts`)), `${root}/vendor/pi-fff`);
	assert.equal(
		extensionKey(pkg(`${root}/vendor/pi-workspace-history/wtf/index.ts`)),
		extensionKey(pkg(`${root}/vendor/pi-workspace-history/.pi/extensions/workspace-history.ts`)),
		"wtf lives inside workspace-history and counts with it",
	);
	assert.equal(extensionKey(pkg(`${root}/extensions/compact-tools.ts`)), `${root}/extensions/compact-tools.ts`);
	assert.equal(extensionKey({ origin: "package", source: "npm:pi-statusline" }), "npm:pi-statusline");
	assert.equal(extensionKey({ origin: "builtin", path: "/x/vendor/y/z.ts" }), undefined);
	assert.equal(extensionKey(undefined), undefined);
});
