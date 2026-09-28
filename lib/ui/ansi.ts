/**
 * ANSI escape helpers and keyboard parsing for interactive TUI menus.
 */

export const ANSI = {
	// Cursor control
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	up: (lines = 1) => `\x1b[${lines}A`,
	clearLine: "\x1b[2K",
	clearScreen: "\x1b[2J",
	moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,

	// Styling
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
} as const;

export type KeyAction = "up" | "down" | "enter" | "escape" | "escape-start" | null;

export type KeyPressAction = Exclude<KeyAction, "escape-start" | null>;

export interface KeyMatch {
	action: KeyPressAction | null;
	/** Characters of the input consumed by this key event. */
	length: number;
}

const KEY_SEQUENCES: ReadonlyArray<readonly [string, KeyPressAction]> = [
	["\x1b[A", "up"],
	["\x1bOA", "up"],
	["\x1b[B", "down"],
	["\x1bOB", "down"],
];

/**
 * One complete escape sequence at the start of a buffer: CSI
 * (`ESC [ … final`), SS3 (`ESC O char`), OSC (`ESC ] … BEL|ST`),
 * charset designations (`ESC ( X`), or a two-byte Fe/Fs escape.
 */
// The two-byte Fe range excludes every multi-byte introducer: `O` (SS3 —
// only complete once its final byte arrives) and the string leaders `]`
// (OSC), `P` (DCS), `X` (SOS), `^` (PM), `_` (APC), which are complete only
// through their BEL/ST terminator. Matching a bare `\x1bO` or `\x1b]` as a
// finished escape would leave the follow-on bytes to be read as keys.
const COMPLETE_ESCAPE =
	/^\x1b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|O[@-~]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][ -~]|[@-NQR-WY-Z\\])/;

/**
 * Whether `input` is a strict prefix of something that could still grow
 * into a known key or escape sequence — i.e. it begins with ESC and its
 * terminator has not arrived yet.
 */
function isIncompleteEscape(input: string): boolean {
	if (input === "\x1b") return true;
	if (input.length < 2 || input[0] !== "\x1b") return false;
	const rest = input.slice(1);
	if (/^\[[0-9;:<=>?]*[ -/]*$/.test(rest)) return true; // CSI params so far
	if (/^O$/.test(rest)) return true; // SS3 leader
	// OSC/DCS/SOS/PM/APC awaiting their BEL/ST terminator.
	if (/^[\]PX^_][^\x07\x1b]*$/.test(rest)) return true;
	if (/^[()#]$/.test(rest)) return true; // charset designation leader
	return false;
}

/**
 * Consumes the leading key event from `input`.
 *
 * - `{ action, length }` for a recognized key (arrow, enter, ctrl-c).
 * - `{ action: null, length }` for input that is complete but unbound —
 *   other escape sequences (function keys, OSC) or ordinary characters.
 * - `"incomplete"` when `input` is a strict prefix of a recognizable
 *   sequence — the caller should buffer it and wait for more bytes (or an
 *   escape timeout) rather than dropping half a keystroke.
 */
export function matchKeyInput(input: string): KeyMatch | "incomplete" | null {
	if (input.length === 0) return null;
	if (input[0] !== "\x1b") {
		const first = input[0];
		if (first === "\r" || first === "\n") return { action: "enter", length: 1 };
		if (first === "\x03") return { action: "escape", length: 1 };
		for (const char of input) {
			return { action: null, length: char.length };
		}
		return null;
	}
	for (const [sequence, action] of KEY_SEQUENCES) {
		if (input.startsWith(sequence)) return { action, length: sequence.length };
	}
	const complete = COMPLETE_ESCAPE.exec(input);
	if (complete) return { action: null, length: complete[0].length };
	if (isIncompleteEscape(input)) return "incomplete";
	// ESC followed by something that is not a sequence we understand.
	return { action: null, length: 1 };
}

/**
 * Single-buffer keystroke parser (legacy semantics). Prefer
 * {@link matchKeyInput} for streaming input where escape sequences may be
 * split across `data` events.
 */
export function parseKey(data: Buffer): KeyAction {
	const input = data.toString();
	const match = matchKeyInput(input);
	if (match === "incomplete") return input === "\x1b" ? "escape-start" : null;
	return match?.action ?? null;
}

export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
