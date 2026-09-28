/**
 * Display-column text helpers.
 *
 * Every width budget, truncation, and padding decision in the terminal UI goes
 * through this module so CJK, emoji (including ZWJ sequences), grapheme
 * clusters, and ANSI styling are measured in the columns a renderer actually
 * gives them — never in UTF-16 code units.
 */

/**
 * Matches one terminal escape sequence:
 *
 *  - OSC hyperlinks/titles (`ESC ] … BEL|ST`, and the C1 form `0x9D`),
 *    terminated or running to end of input;
 *  - DCS/SOS/PM/APC data strings (`ESC P/X/^/_` and C1 `0x90/0x98/0x9E/0x9F`)
 *    through their `ST`/`BEL` terminator — without this the payload of a
 *    sixel or `tmux` passthrough would be measured as printable text;
 *  - CSI sequences (`ESC [ … letter` and the C1 form `0x9B … letter`);
 *  - two-byte Fe/Fs escapes such as `ESC ( B` charset designations.
 *
 * Lone C1 control characters that open none of these (NEL `0x85`, ST `0x9C`,
 * …) are not matched — width treats them as zero-width controls and the
 * sanitizer collapses them like any other control.
 */
const ANSI_SEQUENCE = new RegExp(
	[
		"\\u009B[0-9;:<=>?]*[ -/]*[@-~]",
		"[\\u0090\\u0098\\u009D-\\u009F][^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C|$)",
		"\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\|$)",
		"\\u001B[PX^_][^\\u0007\\u001B\\u009B]*(?:\\u0007|\\u001B\\\\|\\u009C|$)",
		"\\u001B[()#][ -~]",
		"\\u001B\\[[0-9;:<=>?]*[ -/]*[@-~]",
		"\\u001B[@-Z\\\\-_]",
	].join("|"),
	"g",
);

const ANSI_SPLIT = new RegExp(`(${ANSI_SEQUENCE.source})`);

/** Leading byte of anything {@link ANSI_SEQUENCE} matches. */
const ANSI_SEQUENCE_LEAD = /^[\u001B\u0090\u0098\u009B\u009D-\u009F]/;

const SGR_SEQUENCE = /(?:\u001B\[|\u009B)[0-9;:]*m$/;

/** SGR-only matcher used when styling must be preserved but measured at 0 width. */
const SGR_ONLY = /(?:\u001B\[|\u009B)[0-9;:]*m/g;

/** Removes every ANSI/OSC escape sequence from `text`. */
export function stripAnsiSequences(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}

/** Removes only SGR styling sequences, leaving other content untouched. */
export function stripSgrSequences(text: string): string {
	return text.replace(SGR_ONLY, "");
}

/* ------------------------------------------------------------------------ */
/* Display width                                                            */
/* ------------------------------------------------------------------------ */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Code points that render in zero columns (controls, combining, invisible). */
function isZeroWidthCodePoint(cp: number): boolean {
	return (
		cp < 0x20 ||
		(cp >= 0x7f && cp <= 0x9f) ||
		cp === 0x00ad || // soft hyphen
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0x0483 && cp <= 0x0489) ||
		(cp >= 0x0591 && cp <= 0x05bd) ||
		cp === 0x05bf ||
		(cp >= 0x05c1 && cp <= 0x05c2) ||
		(cp >= 0x05c4 && cp <= 0x05c5) ||
		cp === 0x05c7 ||
		(cp >= 0x0610 && cp <= 0x061a) ||
		(cp >= 0x064b && cp <= 0x065f) ||
		cp === 0x0670 ||
		(cp >= 0x06d6 && cp <= 0x06dc) ||
		(cp >= 0x06df && cp <= 0x06e4) ||
		(cp >= 0x06e7 && cp <= 0x06e8) ||
		(cp >= 0x06ea && cp <= 0x06ed) ||
		(cp >= 0x0e31 && cp <= 0x0e3a) ||
		(cp >= 0x0e47 && cp <= 0x0e4e) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20f0) ||
		(cp >= 0x200b && cp <= 0x200f) || // ZWSP..RLM (incl. ZWJ)
		(cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides
		(cp >= 0x2060 && cp <= 0x2064) ||
		(cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
		cp === 0xfeff ||
		(cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
		(cp >= 0xfe20 && cp <= 0xfe2f) ||
		(cp >= 0xe0100 && cp <= 0xe01ef)
	);
}

/**
 * East Asian wide/fullwidth code points plus the emoji blocks that terminals
 * render in two columns. A pragmatic table — the goal is matching what real
 * renderers do, not encoding the whole Unicode database.
 */
function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x231a && cp <= 0x231b) || // watch, hourglass
		(cp >= 0x2329 && cp <= 0x232a) ||
		(cp >= 0x23e9 && cp <= 0x23ec) ||
		cp === 0x23f0 ||
		cp === 0x23f3 ||
		(cp >= 0x25fd && cp <= 0x25fe) ||
		(cp >= 0x2614 && cp <= 0x2615) ||
		cp === 0x263a ||
		(cp >= 0x2648 && cp <= 0x2653) ||
		cp === 0x267f ||
		cp === 0x2693 ||
		cp === 0x26a1 ||
		(cp >= 0x26aa && cp <= 0x26ab) ||
		(cp >= 0x26bd && cp <= 0x26be) ||
		(cp >= 0x26c4 && cp <= 0x26c5) ||
		cp === 0x26ce ||
		cp === 0x26d4 ||
		cp === 0x26ea ||
		(cp >= 0x26f2 && cp <= 0x26f3) ||
		cp === 0x26f5 ||
		cp === 0x26fa ||
		cp === 0x26fd ||
		cp === 0x2705 ||
		(cp >= 0x270a && cp <= 0x270b) ||
		cp === 0x2728 ||
		cp === 0x274c ||
		cp === 0x274e ||
		(cp >= 0x2753 && cp <= 0x2755) ||
		cp === 0x2757 ||
		(cp >= 0x2795 && cp <= 0x2797) ||
		cp === 0x27b0 ||
		cp === 0x27bf ||
		(cp >= 0x2b1b && cp <= 0x2b1c) ||
		cp === 0x2b50 ||
		cp === 0x2b55 ||
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals .. ideographic symbols
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo ext B
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
		(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x16fe0 && cp <= 0x16fe4) ||
		(cp >= 0x17000 && cp <= 0x18aff) || // Tangut / Khitan
		(cp >= 0x1aff0 && cp <= 0x1afff) ||
		(cp >= 0x1b000 && cp <= 0x1b152) ||
		(cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators (flags)
		(cp >= 0x1f200 && cp <= 0x1f251) ||
		(cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B..H
	);
}

/**
 * Emoji presentation markers: VS16 selects the wide glyph for an otherwise
 * text-width code point, U+20E3 marks keycap sequences.
 */
const EMOJI_PRESENTATION_HINTS = new Set<number>([0xfe0f, 0x20e3]);

function graphemeDisplayWidth(segment: string): number {
	let sawVisible = false;
	let wide = false;
	for (const char of segment) {
		const cp = char.codePointAt(0) ?? 0;
		if (EMOJI_PRESENTATION_HINTS.has(cp)) {
			wide = true;
			continue;
		}
		if (isZeroWidthCodePoint(cp)) continue;
		sawVisible = true;
		if (isWideCodePoint(cp)) wide = true;
	}
	if (!sawVisible) return 0;
	return wide ? 2 : 1;
}

/**
 * Visible column width of `text`. ANSI escape sequences count as zero and
 * grapheme clusters are measured as a unit, so emoji ZWJ sequences, flags,
 * keycaps, and combining marks are never split or miscounted.
 */
export function displayWidth(text: string): number {
	const stripped = stripAnsiSequences(text);
	let width = 0;
	for (const { segment } of segmenter.segment(stripped)) {
		width += graphemeDisplayWidth(segment);
	}
	return width;
}

/**
 * Truncates `input` to at most `maxCols` display columns, appending `suffix`
 * when content is dropped. ANSI escape sequences are copied through verbatim
 * and never split; grapheme clusters are never split. When a truncated string
 * still carries open SGR styling a reset is appended so the suffix and any
 * following output are not styled accidentally.
 */
export function truncateToDisplayWidth(
	input: string,
	maxCols: number,
	suffix = "…",
): string {
	if (maxCols <= 0) return "";
	if (displayWidth(input) <= maxCols) return input;
	const keep = Math.max(0, maxCols - displayWidth(suffix));
	let used = 0;
	let output = "";
	let sawSgr = false;
	outer: for (const part of input.split(ANSI_SPLIT)) {
		if (part.length === 0) continue;
		if (ANSI_SEQUENCE_LEAD.test(part)) {
			output += part;
			if (SGR_SEQUENCE.test(part)) sawSgr = true;
			continue;
		}
		for (const { segment } of segmenter.segment(part)) {
			const width = graphemeDisplayWidth(segment);
			if (used + width > keep) break outer;
			output += segment;
			used += width;
		}
	}
	const reset = sawSgr ? "\x1b[0m" : "";
	return `${output}${suffix}${reset}`;
}

/** Pads `text` on the right with spaces to `cols` display columns. */
export function padEndDisplay(text: string, cols: number): string {
	const pad = cols - displayWidth(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Pads `text` on the left with spaces to `cols` display columns. */
export function padStartDisplay(text: string, cols: number): string {
	const pad = cols - displayWidth(text);
	return pad > 0 ? " ".repeat(pad) + text : text;
}

/* ------------------------------------------------------------------------ */
/* Sanitizing untrusted text                                                */
/* ------------------------------------------------------------------------ */

/**
 * Bidi embedding/override/isolate controls and other invisible format
 * characters. These are dropped outright — replacing them with spaces would
 * change words that legitimately contain none.
 */
const INVISIBLE_FORMAT_PATTERN =
	/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * Anything that makes a string unsafe to interpolate into terminal output:
 * C0/C1 controls (which covers ESC, so escape sequences too), DEL, and the
 * invisible bidi/format characters.
 */
const RISKY_TEXT_PATTERN =
	/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

const DEFAULT_SANITIZED_MAX_LENGTH = 160;

export interface SanitizeDisplayTextOptions {
	/** Keep complete SGR styling sequences (`ESC [ … m`) in the output. */
	preserveSgr?: boolean;
	/** Maximum length of the sanitized output (characters, incl. SGR). */
	maxLength?: number;
}

/**
 * Renders untrusted text (account labels, emails, tags, notes, server-provided
 * names) safe for terminal interpolation:
 *
 *  - escape sequences are removed (optionally preserving SGR styling),
 *  - C0/C1 controls and DEL collapse to a space,
 *  - bidi controls and other invisible format characters are removed,
 *  - runs of whitespace collapse to single spaces and the result is trimmed,
 *  - the result is bounded to `maxLength` characters.
 *
 * Returns `undefined` for empty input so callers can keep `?? fallback`
 * semantics.
 */
export function sanitizeDisplayText(
	value: string | null | undefined,
	options?: SanitizeDisplayTextOptions,
): string | undefined {
	if (value === null || value === undefined || value.length === 0) {
		return undefined;
	}
	const preserveSgr = options?.preserveSgr === true;
	const maxLength =
		options?.maxLength !== undefined && Number.isFinite(options.maxLength)
			? Math.max(1, Math.floor(options.maxLength))
			: DEFAULT_SANITIZED_MAX_LENGTH;
	// Fast path: no risky characters means nothing to strip — keep whitespace
	// verbatim (callers rely on intentional spacing) and just bound the length.
	if (!RISKY_TEXT_PATTERN.test(value)) {
		if (value.trim().length === 0) return undefined;
		if (value.length <= maxLength) return value;
		return [...value].slice(0, maxLength).join("").trimEnd();
	}
	let out = "";
	for (const part of value.split(ANSI_SPLIT)) {
		if (part.length === 0) continue;
		if (ANSI_SEQUENCE_LEAD.test(part)) {
			if (preserveSgr && SGR_SEQUENCE.test(part)) out += part;
			continue;
		}
		for (const char of part) {
			const cp = char.codePointAt(0) ?? 0;
			if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
				out += " ";
			} else if (INVISIBLE_FORMAT_PATTERN.test(char)) {
				// dropped — invisible bidi/format control
			} else {
				out += char;
			}
		}
	}
	const collapsed = out.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	if (collapsed.length > maxLength) {
		// Codepoint-wise bound, then drop a trailing partial escape sequence a
		// hard cut may have produced.
		const bounded = [...collapsed].slice(0, maxLength).join("");
		return bounded.replace(/[\u001b\u009b](\[[0-9;:<=>?]*[ -/]*)?$/, "");
	}
	return collapsed;
}

/**
 * {@link sanitizeDisplayText} for multi-line values: each line is sanitized
 * separately so embedded newlines survive (the single-line variant would
 * collapse them to spaces). Returns `undefined` when nothing printable
 * remains.
 */
export function sanitizeDisplayBlock(
	value: string | null | undefined,
	options?: SanitizeDisplayTextOptions,
): string | undefined {
	if (value === null || value === undefined || value.length === 0) {
		return undefined;
	}
	const cleaned = value
		.split("\n")
		.map((line) => sanitizeDisplayText(line, options) ?? "")
		.join("\n");
	return cleaned.trim().length === 0 ? undefined : cleaned;
}

/**
 * Sanitizing convenience for required display fields — returns `"unknown"`
 * when the input sanitizes to nothing.
 */
export function sanitizeDisplayTextOrUnknown(
	value: string | null | undefined,
	options?: SanitizeDisplayTextOptions,
): string {
	return sanitizeDisplayText(value, options) ?? "unknown";
}

/* ------------------------------------------------------------------------ */
/* Locale-independent formatting                                            */
/* ------------------------------------------------------------------------ */

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `HH:MM` on a 24-hour clock — identical output under every locale. */
export function formatClockTime(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Short English weekday such as `Tue` — identical under every locale. */
export function formatShortWeekday(date: Date): string {
	return WEEKDAY_SHORT[date.getDay()] ?? "Sun";
}

/** `Sep 05` — fixed English month abbreviation, zero-padded day. */
export function formatShortDate(date: Date): string {
	return `${MONTH_SHORT[date.getMonth()] ?? "Jan"} ${pad2(date.getDate())}`;
}

/** `2026-01-15` — ISO-style calendar date for tables and menus. */
export function formatIsoDate(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
