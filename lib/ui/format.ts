import { displayWidth, sanitizeDisplayText } from "./display-text.js";
import type { UiRuntimeOptions } from "./runtime.js";

export type UiTextTone =
	| "heading"
	| "accent"
	| "muted"
	| "success"
	| "warning"
	| "danger"
	| "normal";

const TONE_TO_COLOR: Record<UiTextTone, keyof UiRuntimeOptions["theme"]["colors"] | null> = {
	heading: "heading",
	accent: "accent",
	muted: "muted",
	success: "success",
	warning: "warning",
	danger: "danger",
	normal: null,
};

export function paintUiText(ui: UiRuntimeOptions, text: string, tone: UiTextTone = "normal"): string {
	if (!ui.v2Enabled) return text;
	// `colorEnabled === false` means NO_COLOR / FORCE_COLOR=0 / no TTY;
	// return the unstyled text so the layout (bullets, labels, spacing)
	// is preserved but no ANSI escape sequences are emitted.
	if (ui.colorEnabled === false) return text;
	const colorKey = TONE_TO_COLOR[tone];
	if (!colorKey) return text;
	return `${ui.theme.colors[colorKey]}${text}${ui.theme.colors.reset}`;
}

/**
 * Untrusted text (titles, account labels, server-provided strings) is
 * sanitized before interpolation: control characters, bidi overrides, and
 * escape sequences are stripped so they cannot smuggle cursor movement or
 * reordering into rendered output. SGR styling a caller embedded on purpose
 * survives.
 */
function sanitizeUiText(value: string): string {
	return sanitizeDisplayText(value, { preserveSgr: true }) ?? "";
}

export function formatUiHeader(ui: UiRuntimeOptions, title: string): string[] {
	const text = sanitizeUiText(title);
	if (!ui.v2Enabled) return [text];
	const divider = "-".repeat(Math.max(8, displayWidth(text)));
	return [
		paintUiText(ui, text, "heading"),
		paintUiText(ui, divider, "muted"),
	];
}

export function formatUiSection(ui: UiRuntimeOptions, title: string): string[] {
	const text = sanitizeUiText(title);
	if (!ui.v2Enabled) return [text];
	return [paintUiText(ui, text, "accent")];
}

export function formatUiItem(
	ui: UiRuntimeOptions,
	text: string,
	tone: UiTextTone = "normal",
): string {
	const item = sanitizeUiText(text);
	if (!ui.v2Enabled) return `- ${item}`;
	const bullet = paintUiText(ui, ui.theme.glyphs.bullet, "muted");
	return `${bullet} ${paintUiText(ui, item, tone)}`;
}

export function formatUiKeyValue(
	ui: UiRuntimeOptions,
	key: string,
	value: string,
	valueTone: UiTextTone = "normal",
): string {
	const safeKey = sanitizeUiText(key);
	const safeValue = sanitizeUiText(value);
	if (!ui.v2Enabled) return `${safeKey}: ${safeValue}`;
	const keyText = paintUiText(ui, `${safeKey}:`, "muted");
	const valueText = paintUiText(ui, safeValue, valueTone);
	return `${keyText} ${valueText}`;
}

export function formatUiBadge(
	ui: UiRuntimeOptions,
	label: string,
	tone: Exclude<UiTextTone, "normal" | "heading"> = "accent",
): string {
	const text = `[${sanitizeUiText(label)}]`;
	return paintUiText(ui, text, tone);
}

