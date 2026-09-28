import { describe, it, expect } from "vitest";
import { createUiTheme } from "../lib/ui/theme.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
	paintUiText,
} from "../lib/ui/format.js";
import type { UiRuntimeOptions } from "../lib/ui/runtime.js";

const v2Ui: UiRuntimeOptions = {
	v2Enabled: true,
	colorProfile: "truecolor",
	glyphMode: "ascii",
	theme: createUiTheme({ profile: "truecolor", glyphMode: "ascii" }),
};

const legacyUi: UiRuntimeOptions = {
	v2Enabled: false,
	colorProfile: "ansi16",
	glyphMode: "ascii",
	theme: createUiTheme({ profile: "ansi16", glyphMode: "ascii" }),
};

describe("UI text formatter", () => {
	it("returns plain text in legacy mode", () => {
		expect(paintUiText(legacyUi, "hello", "accent")).toBe("hello");
		expect(formatUiItem(legacyUi, "line")).toBe("- line");
		expect(formatUiKeyValue(legacyUi, "Key", "Value")).toBe("Key: Value");
	});

	it("returns styled text in v2 mode", () => {
		const text = paintUiText(v2Ui, "hello", "accent");
		expect(text).toContain("hello");
		expect(text).toContain("\x1b[");
	});

	it("formats codex-style headers and sections", () => {
		const header = formatUiHeader(v2Ui, "Codex accounts");
		expect(header).toHaveLength(2);
		expect(header[0]).toContain("Codex accounts");

		const section = formatUiSection(v2Ui, "Accounts");
		expect(section[0]).toContain("Accounts");
	});

	it("formats badges and list items", () => {
		const badge = formatUiBadge(v2Ui, "ok", "success");
		expect(badge).toContain("[ok]");

		const item = formatUiItem(v2Ui, "1. user@example.com");
		expect(item).toContain("1. user@example.com");
		expect(item).toContain(v2Ui.theme.glyphs.bullet);
	});

	it("strips conceal and styling SGR from untrusted item text", () => {
		// A persisted account label can carry `ESC[8m` (conceal) — rendered
		// raw it would hide whatever the line prints next.
		const concealed = `work\x1b[8m followed-by-hidden-text`;
		const legacy = formatUiItem(legacyUi, concealed);
		expect(legacy).not.toContain("\x1b[8m");
		// The conceal sequence is gone, so the trailing text stays VISIBLE.
		expect(legacy).toContain("followed-by-hidden-text");
		expect(legacy).toContain("work");

		const styled = `\x1b[31m\x1b[8mlabel`;
		const v2 = formatUiItem(v2Ui, styled);
		expect(v2).not.toContain("\x1b[8m");
		expect(v2).toContain("label");
		// The label's own red is gone; only the formatter's styling remains.
		expect(v2).not.toContain("\x1b[31m");
	});

	it("preserves trusted suffix styling while sanitizing the main text", () => {
		const badge = formatUiBadge(v2Ui, "ok", "success");
		const item = formatUiItem(
			v2Ui,
			`account\x1b[8m-hidden`,
			"normal",
			` ${badge}`,
		);

		// The untrusted body's concealment is removed — the text it tried to
		// hide renders as ordinary visible output instead.
		expect(item).not.toContain("\x1b[8m");
		expect(item).toContain("-hidden");
		expect(item).toContain("account");
		// ...but the application-generated badge keeps its styling verbatim.
		expect(item).toContain(badge);
		expect(item.indexOf(badge)).toBeGreaterThan(item.indexOf("account"));
	});

	it("sanitizes untrusted text in headers, sections, and key-value pairs", () => {
		const header = formatUiHeader(v2Ui, "title\x1b[8m-hidden\x1b]8;;https://evil\x07");
		expect(header[0]).not.toContain("\x1b[8m");
		expect(header[0]).not.toContain("\x1b]8;");
		expect(header[0]).toContain("title");

		const section = formatUiSection(v2Ui, "sec\x1b[2Ktion");
		expect(section[0]).not.toContain("\x1b[2K");

		const kv = formatUiKeyValue(v2Ui, "k\x1b[8mey", "v\x1b]8;;x\x07alue");
		expect(kv).not.toContain("\x1b[8m");
		expect(kv).not.toContain("\x1b]8;");
		expect(kv).toContain("key");
		expect(kv).toContain("value");
	});
});

