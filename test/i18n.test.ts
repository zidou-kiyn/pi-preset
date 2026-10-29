// UI language: env override, saved choice, system locale; catalog parity.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	catalogMismatches,
	currentLang,
	type Lang,
	langOf,
	localeLang,
	localized,
	presetSettingsPath,
	readLanguageChoice,
	writeLanguageChoice,
} from "../src/i18n.ts";

import { catalogs as compactToolsCatalogs } from "../src/compact-tools-messages.ts";
import { catalogs as footerCatalogs } from "../src/footer-messages.ts";
import { catalogs as keepwarmCatalogs } from "../src/idle-keepwarm-messages.ts";
import { catalogs as piPresetCatalogs } from "../src/pi-preset-messages.ts";
import { catalogs as presetCatalogs } from "../src/preset-messages.ts";
import { catalogs as secretRedactCatalogs } from "../src/secret-redact/messages.ts";
import { catalogs as skillsStoreCatalogs } from "../src/skills-store/messages.ts";
import { catalogs as termiusCatalogs } from "../src/termius/messages.ts";
import { catalogs as trellisLiteCatalogs } from "../src/trellis-lite/messages.ts";

/** Every catalog in the preset; a new feature catalog is added here. */
const CATALOGS: Record<string, Record<Lang, object>> = {
	"compact-tools": compactToolsCatalogs,
	footer: footerCatalogs,
	keepwarm: keepwarmCatalogs,
	"pi-preset": piPresetCatalogs,
	preset: presetCatalogs,
	"secret-redact": secretRedactCatalogs,
	"skills-store": skillsStoreCatalogs,
	termius: termiusCatalogs,
	"trellis-lite": trellisLiteCatalogs,
};

function withAgentDir(run: () => void): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-preset-i18n-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("langOf reads language tags and POSIX locales", () => {
	assert.equal(langOf("zh_CN.UTF-8"), "zh");
	assert.equal(langOf("zh-Hans"), "zh");
	assert.equal(langOf("ZH"), "zh");
	assert.equal(langOf("en_US.UTF-8"), "en");
	assert.equal(langOf("C"), "en");
	assert.equal(langOf("zhx"), "en");
	assert.equal(langOf(""), undefined);
	assert.equal(langOf(undefined), undefined);
});

test("the system locale: LC_ALL before LC_MESSAGES before LANG", () => {
	assert.equal(localeLang({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
	assert.equal(localeLang({ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }), "zh");
	assert.equal(localeLang({ LANG: "zh_CN.UTF-8" }), "zh");
	assert.equal(localeLang({ LC_ALL: "", LANG: "zh_CN.UTF-8" }), "zh", "an empty variable does not count");
});

test("PI_PRESET_LANG beats the saved choice, which beats the locale", () => {
	withAgentDir(() => {
		assert.equal(readLanguageChoice(), "auto");
		assert.equal(currentLang({ LANG: "zh_CN.UTF-8" }), "zh");
		writeLanguageChoice("en");
		assert.equal(readLanguageChoice(), "en");
		assert.equal(currentLang({ LANG: "zh_CN.UTF-8" }), "en");
		assert.equal(currentLang({ LANG: "en_US.UTF-8", PI_PRESET_LANG: "zh" }), "zh");
		writeLanguageChoice("auto");
		assert.equal(currentLang({ LANG: "zh_CN.UTF-8" }), "zh");
	});
});

test("saving the language keeps other keys and drops the key for auto", () => {
	withAgentDir(() => {
		mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "pi-preset"), { recursive: true });
		writeFileSync(presetSettingsPath(), JSON.stringify({ other: 1 }));
		writeLanguageChoice("zh");
		assert.deepEqual(JSON.parse(readFileSync(presetSettingsPath(), "utf8")), { other: 1, language: "zh" });
		writeLanguageChoice("auto");
		assert.deepEqual(JSON.parse(readFileSync(presetSettingsPath(), "utf8")), { other: 1 });
	});
});

test("an unreadable or unknown saved value counts as auto", () => {
	withAgentDir(() => {
		mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "pi-preset"), { recursive: true });
		writeFileSync(presetSettingsPath(), "{not json");
		assert.equal(readLanguageChoice(), "auto");
		writeFileSync(presetSettingsPath(), JSON.stringify({ language: "fr" }));
		assert.equal(readLanguageChoice(), "auto");
	});
});

test("localized picks the catalog of the language in effect", () => {
	const previous = process.env.PI_PRESET_LANG;
	try {
		const messages = localized({ en: { hi: "Hello" }, zh: { hi: "你好" } });
		process.env.PI_PRESET_LANG = "zh";
		assert.equal(messages().hi, "你好");
		process.env.PI_PRESET_LANG = "en";
		assert.equal(messages().hi, "Hello");
	} finally {
		if (previous === undefined) delete process.env.PI_PRESET_LANG;
		else process.env.PI_PRESET_LANG = previous;
	}
});

test("catalogMismatches finds missing, extra, mistyped, and mis-sized entries", () => {
	const en = { a: "A", b: (n: number) => `${n}`, c: "C", d: "D" };
	const zh = { a: "甲", b: (n: number, m: number) => `${n}${m}`, c: () => "丙", e: "戊" };
	assert.deepEqual(catalogMismatches({ en, zh }).sort(), [
		"b: en takes 1 argument(s), zh takes 2",
		"c: en is string, zh is function",
		"zh has e, en does not",
		"zh is missing d",
	]);
	assert.deepEqual(catalogMismatches({ en: { a: "A" }, zh: { a: "" } }), ["a: empty text"]);
	assert.deepEqual(catalogMismatches({ en: { a: "A" }, zh: { a: "甲" } }), []);
});

test("/pi-preset language: the item shows the choice, saving it switches the menu at once", async () => {
	const { menuItems, saveLanguage } = await import("../extensions/pi-preset.ts");
	const { MenuComponent } = await import("../src/preset-menu.ts");
	const names = ["PI_PRESET_LANG", "LC_ALL", "LC_MESSAGES", "LANG"] as const;
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	process.env.LANG = "en_US.UTF-8";
	const render = () => {
		const keybindings = { matches: () => false } as never;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		return new MenuComponent(() => ({ title: "pi-preset", items: menuItems(), selected: "language" }), theme, keybindings, () => {}, () => {})
			.render(100)
			.join("\n");
	};
	try {
		withAgentDir(() => {
			const item = () => menuItems().find((entry) => entry.value === "language")!;
			assert.equal(item().label, "Language");
			assert.equal(item().hint, "Auto (English)");
			assert.match(render(), /Esc close/);

			assert.deepEqual(saveLanguage("zh"), { text: "语言：中文", type: "success" });
			assert.equal(readLanguageChoice(), "zh");
			assert.equal(item().label, "语言");
			assert.equal(item().hint, "中文");
			const zh = render();
			assert.match(zh, /同步预设/);
			assert.match(zh, /Esc 关闭/);
			assert.match(zh, /PI_PRESET_LANG/, "the description names the override");

			assert.deepEqual(saveLanguage("en"), { text: "Language: English", type: "success" });
			assert.equal(menuItems()[0]!.label, "Sync preset");

			process.env.PI_PRESET_LANG = "zh";
			const forced = saveLanguage("auto");
			assert.equal(forced.type, "warning");
			assert.match(forced.text, /PI_PRESET_LANG=zh/);
			assert.equal(readLanguageChoice(), "auto", "still saved");
			assert.equal(item().hint, "自动（English）");
		});
	} finally {
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name];
			else process.env[name] = previous[name];
		}
	}
});

for (const [name, catalogs] of Object.entries(CATALOGS)) {
	test(`catalog ${name}: en and zh match`, () => {
		assert.deepEqual(catalogMismatches(catalogs), []);
	});
}
