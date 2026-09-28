import { describe, expect, it } from "vitest";
import { matchKeyInput, parseKey } from "../lib/ui/ansi.js";

describe("matchKeyInput", () => {
	it("returns null for empty input", () => {
		expect(matchKeyInput("")).toBeNull();
	});

	it("maps CSI and SS3 arrows to up/down", () => {
		expect(matchKeyInput("\x1b[A")).toEqual({ action: "up", length: 3 });
		expect(matchKeyInput("\x1bOA")).toEqual({ action: "up", length: 3 });
		expect(matchKeyInput("\x1b[B")).toEqual({ action: "down", length: 3 });
		expect(matchKeyInput("\x1bOB")).toEqual({ action: "down", length: 3 });
	});

	it("maps CR and LF to enter, Ctrl-C to escape", () => {
		expect(matchKeyInput("\r")).toEqual({ action: "enter", length: 1 });
		expect(matchKeyInput("\n")).toEqual({ action: "enter", length: 1 });
		expect(matchKeyInput("\x03")).toEqual({ action: "escape", length: 1 });
	});

	it("consumes ordinary characters without an action", () => {
		expect(matchKeyInput("abc")).toEqual({ action: null, length: 1 });
		// A wide char is consumed whole, not one UTF-16 unit at a time.
		expect(matchKeyInput("日x")).toEqual({ action: null, length: 1 });
	});

	it("reports strict escape prefixes as incomplete", () => {
		expect(matchKeyInput("\x1b")).toBe("incomplete");
		expect(matchKeyInput("\x1b[")).toBe("incomplete");
		expect(matchKeyInput("\x1b[1")).toBe("incomplete");
		expect(matchKeyInput("\x1bO")).toBe("incomplete");
		expect(matchKeyInput("\x1b]8;;http://x")).toBe("incomplete");
	});

	it("consumes complete but unbound sequences without an action", () => {
		// F1 (SS3 P) — complete, not bound to a menu action.
		expect(matchKeyInput("\x1bOP")).toEqual({ action: null, length: 3 });
		// A longer CSI sequence consumes through its final byte.
		const match = matchKeyInput("\x1b[1;5A");
		expect(match).toEqual({ action: null, length: 6 });
	});

	it("consumes only the leading event of a longer buffer", () => {
		// Arrow then a regular key: only the arrow is consumed.
		expect(matchKeyInput("\x1b[Ax")).toEqual({ action: "up", length: 3 });
		// ESC followed by a non-sequence byte: ESC alone is consumed.
		expect(matchKeyInput("\x1bx")).toEqual({ action: null, length: 1 });
	});
});

describe("parseKey (legacy)", () => {
	it("maps arrows and enter", () => {
		expect(parseKey(Buffer.from("\x1b[A"))).toBe("up");
		expect(parseKey(Buffer.from("\x1b[B"))).toBe("down");
		expect(parseKey(Buffer.from("\r"))).toBe("enter");
	});

	it("reports a lone ESC as escape-start rather than escape", () => {
		// A lone ESC could be the Escape key or the start of a split
		// sequence — the streaming parser is allowed to wait.
		expect(parseKey(Buffer.from("\x1b"))).toBe("escape-start");
		expect(parseKey(Buffer.from("\x1b["))).toBeNull();
	});
});
