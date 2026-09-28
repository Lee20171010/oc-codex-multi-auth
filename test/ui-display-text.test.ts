import { describe, expect, it } from "vitest";
import {
	displayWidth,
	formatClockTime,
	formatIsoDate,
	formatShortDate,
	formatShortWeekday,
	padEndDisplay,
	padStartDisplay,
	sanitizeDisplayBlock,
	sanitizeDisplayText,
	sanitizeDisplayTextOrUnknown,
	stripAnsiSequences,
	truncateToDisplayWidth,
} from "../lib/ui/display-text.js";

describe("displayWidth", () => {
	it("measures plain ASCII in columns", () => {
		expect(displayWidth("hello")).toBe(5);
		expect(displayWidth("")).toBe(0);
	});

	it("counts ANSI escape sequences as zero width", () => {
		expect(displayWidth("\x1b[31mred\x1b[0m")).toBe(3);
		// OSC hyperlink: only the visible label is measured.
		expect(displayWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(4);
	});

	it("counts CJK and fullwidth characters as two columns", () => {
		expect(displayWidth("日本語")).toBe(6);
		expect(displayWidth("ａｂｃ")).toBe(6); // fullwidth latin
		expect(displayWidth("ab日本")).toBe(6);
	});

	it("counts combining marks as zero extra columns", () => {
		// e + combining acute renders in a single column.
		expect(displayWidth("é")).toBe(1);
		expect(displayWidth("́")).toBe(0);
	});

	it("measures emoji and ZWJ clusters as a unit", () => {
		expect(displayWidth("😀")).toBe(2);
		// Family emoji: several codepoints joined by ZWJ must not split or
		// sum — the cluster renders in two columns.
		expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
		// Regional indicator pair (flag) renders in two columns.
		expect(displayWidth("🇩🇪")).toBe(2);
		// Keycap sequence.
		expect(displayWidth("1️⃣")).toBe(2);
		// Text-presentation codepoint upgraded by VS16.
		expect(displayWidth("☀️")).toBe(2);
	});

	it("counts control characters and bidi marks as zero width", () => {
		expect(displayWidth("a\tb")).toBe(2);
		expect(displayWidth("a‏b")).toBe(2); // bidi isolate
	});
});

describe("truncateToDisplayWidth", () => {
	it("returns input that already fits", () => {
		expect(truncateToDisplayWidth("abc", 5)).toBe("abc");
	});

	it("returns empty for a non-positive budget", () => {
		expect(truncateToDisplayWidth("abc", 0)).toBe("");
		expect(truncateToDisplayWidth("abc", -3)).toBe("");
	});

	it("truncates on grapheme boundaries with the suffix counted", () => {
		expect(truncateToDisplayWidth("abcdef", 4)).toBe("abc…");
		expect(truncateToDisplayWidth("ab😀cd", 4)).toBe("ab…");
	});

	it("never splits a wide character or a ZWJ cluster", () => {
		// 3 columns cannot hold a 2-column CJK char plus more content.
		expect(truncateToDisplayWidth("日本abc", 4)).toBe("日…");
		const truncated = truncateToDisplayWidth("x👨‍👩‍👧‍👦y", 3);
		expect(truncated).toBe("x…");
	});

	it("copies ANSI sequences through without measuring them", () => {
		const styled = "\x1b[31mabcdef\x1b[0m";
		const truncated = truncateToDisplayWidth(styled, 4);
		expect(truncated).toContain("\x1b[31m");
		expect(displayWidth(truncated)).toBe(4);
		// An open SGR at the cut point gets a reset appended.
		expect(truncated.endsWith("\x1b[0m")).toBe(true);
	});
});

describe("display padding", () => {
	it("padEndDisplay pads by columns, not code units", () => {
		expect(padEndDisplay("日本", 6)).toBe("日本  ");
		expect(padEndDisplay("ab", 6)).toBe("ab    ");
		// Already wide enough: unchanged.
		expect(padEndDisplay("日本語", 5)).toBe("日本語");
	});

	it("padStartDisplay pads by columns", () => {
		expect(padStartDisplay("日本", 6)).toBe("  日本");
		expect(padStartDisplay("ab", 4)).toBe("  ab");
	});
});

describe("sanitizeDisplayText", () => {
	it("returns undefined for empty or blank input", () => {
		expect(sanitizeDisplayText(undefined)).toBeUndefined();
		expect(sanitizeDisplayText(null)).toBeUndefined();
		expect(sanitizeDisplayText("")).toBeUndefined();
		expect(sanitizeDisplayText("   ")).toBeUndefined();
	});

	it("strips CSI, OSC, and DCS sequences", () => {
		expect(sanitizeDisplayText("\x1b[31mhi\x1b[0m")).toBe("hi");
		expect(sanitizeDisplayText("\x1b]8;;https://x\x07label\x1b]8;;\x07")).toBe("label");
		expect(sanitizeDisplayText("\x1bPsixeldata\x1b\\tail")).toBe("tail");
		// Unterminated OSC to end of input is removed too.
		expect(sanitizeDisplayText("ok\x1b]0;title")).toBe("ok");
	});

	it("drops bidi overrides and invisible format characters", () => {
		expect(sanitizeDisplayText("a‮b‬c")).toBe("abc");
		expect(sanitizeDisplayText("x⁦y⁩z")).toBe("xyz");
		expect(sanitizeDisplayText("﻿bom")).toBe("bom"); // BOM
	});

	it("collapses control characters and whitespace", () => {
		expect(sanitizeDisplayText("a\x00b\x1fc")).toBe("a b c");
		expect(sanitizeDisplayText("a\nb\tc")).toBe("a b c");
		// Whitespace is only collapsed on the risky path — clean input keeps
		// its intentional spacing verbatim.
		expect(sanitizeDisplayText("  pad  ")).toBe("  pad  ");
		expect(sanitizeDisplayText("  pad\x07  ")).toBe("pad");
	});

	it("bounds the result to maxLength characters", () => {
		expect(sanitizeDisplayText("x".repeat(500))?.length).toBe(160);
		expect(sanitizeDisplayText("x".repeat(500), { maxLength: 10 })).toBe("x".repeat(10));
	});

	it("can preserve SGR styling while removing other sequences", () => {
		const kept = sanitizeDisplayText("\x1b[31mhi\x1b[0m", { preserveSgr: true });
		expect(kept).toBe("\x1b[31mhi\x1b[0m");
		const stripped = sanitizeDisplayText("\x1b[31m\x1b[2Khi", { preserveSgr: true });
		expect(stripped).toBe("\x1b[31mhi");
	});
});

describe("sanitizeDisplayBlock", () => {
	it("preserves newlines while sanitizing each line", () => {
		expect(sanitizeDisplayBlock("a\x1b[31m\nb\tc")).toBe("a\nb c");
	});

	it("returns undefined when nothing printable remains", () => {
		expect(sanitizeDisplayBlock("\x1b[2J\x00")).toBeUndefined();
	});
});

describe("sanitizeDisplayTextOrUnknown", () => {
	it("falls back to 'unknown'", () => {
		expect(sanitizeDisplayTextOrUnknown("\x1b[2J")).toBe("unknown");
		expect(sanitizeDisplayTextOrUnknown("fine")).toBe("fine");
	});
});

describe("stripAnsiSequences", () => {
	it("removes every sequence class", () => {
		expect(stripAnsiSequences("\x1b[31ma\x1b[0m\x1b]8;;u\x07b\x1bPq\x1b\\c")).toBe("abc");
		expect(stripAnsiSequences("plain")).toBe("plain");
	});
});

describe("locale-independent formatters", () => {
	const date = new Date(2026, 8, 5, 14, 7, 0); // Sep 05 2026 14:07 local

	it("formatClockTime renders zero-padded HH:MM", () => {
		expect(formatClockTime(date)).toBe("14:07");
		expect(formatClockTime(new Date(2026, 0, 1, 3, 4, 0))).toBe("03:04");
	});

	it("formatShortWeekday renders a fixed English weekday", () => {
		// 2026-09-05 is a Saturday.
		expect(formatShortWeekday(date)).toBe("Sat");
	});

	it("formatShortDate renders `Mon DD` in fixed English", () => {
		expect(formatShortDate(date)).toBe("Sep 05");
	});

	it("formatIsoDate renders YYYY-MM-DD", () => {
		expect(formatIsoDate(date)).toBe("2026-09-05");
	});
});
