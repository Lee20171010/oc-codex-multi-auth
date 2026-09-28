import { afterEach, describe, it, expect, vi } from "vitest";
import {
	createUiTheme,
	resolveUiGlyphMode,
	terminalSupportsAnsi,
} from "../lib/ui/theme.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("terminalSupportsAnsi", () => {
	it("requires a TTY", () => {
		expect(terminalSupportsAnsi({ isTTY: false }, { TERM: "xterm-256color" })).toBe(false);
		expect(terminalSupportsAnsi({}, { TERM: "xterm-256color" })).toBe(false);
	});

	it("rejects non-ANSI TERM values even on a TTY", () => {
		for (const term of ["dumb", "cons25", "emacs"]) {
			expect(terminalSupportsAnsi({ isTTY: true }, { TERM: term })).toBe(false);
		}
	});

	it("FORCE_COLOR does not unlock cursor control on a dumb terminal", () => {
		// Styling can be forced; moving the cursor cannot.
		expect(
			terminalSupportsAnsi({ isTTY: true }, { TERM: "dumb", FORCE_COLOR: "1" }),
		).toBe(false);
	});

	it("NO_COLOR does not disable cursor control", () => {
		expect(
			terminalSupportsAnsi({ isTTY: true }, { TERM: "xterm", NO_COLOR: "1" }),
		).toBe(true);
	});

	it("treats an unset TERM as capable when the stream is a TTY", () => {
		expect(terminalSupportsAnsi({ isTTY: true }, {})).toBe(true);
		expect(terminalSupportsAnsi({ isTTY: true }, { TERM: "xterm-256color" })).toBe(true);
	});
});

describe("resolveUiGlyphMode", () => {
	it("passes explicit modes through", () => {
		expect(resolveUiGlyphMode("ascii")).toBe("ascii");
		expect(resolveUiGlyphMode("unicode")).toBe("unicode");
	});

	it("auto resolves to unicode on likely-unicode terminals", () => {
		// Clear the ambient trio first so a dev machine's own terminal cannot
		// decide the outcome.
		vi.stubEnv("WT_SESSION", undefined);
		vi.stubEnv("TERM_PROGRAM", undefined);
		vi.stubEnv("TERM", undefined);

		vi.stubEnv("WT_SESSION", "guid");
		expect(resolveUiGlyphMode("auto")).toBe("unicode");
		vi.stubEnv("WT_SESSION", undefined);

		vi.stubEnv("TERM_PROGRAM", "vscode");
		expect(resolveUiGlyphMode("auto")).toBe("unicode");
		vi.stubEnv("TERM_PROGRAM", undefined);

		vi.stubEnv("TERM", "xterm-256color");
		expect(resolveUiGlyphMode("auto")).toBe("unicode");
	});

	it("auto resolves to ascii on generic or dumb terminals", () => {
		vi.stubEnv("WT_SESSION", undefined);
		vi.stubEnv("TERM_PROGRAM", undefined);
		vi.stubEnv("TERM", "linux");
		expect(resolveUiGlyphMode("auto")).toBe("ascii");
	});
});

describe("UI theme", () => {
	it("uses defaults when options are omitted", () => {
		const theme = createUiTheme();
		expect(theme.profile).toBe("truecolor");
		expect(theme.glyphMode).toBe("ascii");
		expect(theme.glyphs.selected.length).toBeGreaterThan(0);
		expect(theme.colors.reset).toBe("\x1b[0m");
	});

	it("uses ansi16 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi16" });
		expect(theme.profile).toBe("ansi16");
		expect(theme.colors.accent).toContain("\x1b[");
	});

	it("uses ansi256 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi256" });
		expect(theme.profile).toBe("ansi256");
		expect(theme.colors.accent).toContain("38;5;");
	});

	it("uses unicode glyph set when explicitly requested", () => {
		const theme = createUiTheme({ glyphMode: "unicode" });
		expect(theme.glyphs.selected).not.toBe(">");
		expect(theme.glyphs.check).not.toBe("+");
	});

	it("keeps ascii glyph set when explicitly requested", () => {
		const theme = createUiTheme({ glyphMode: "ascii" });
		expect(theme.glyphs.selected).toBe(">");
		expect(theme.glyphs.check).toBe("+");
	});
});

