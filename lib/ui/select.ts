import { CodexValidationError, ConfigError } from "../errors.js";
import { ANSI, isTTY, matchKeyInput } from "./ansi.js";
import {
	sanitizeDisplayText,
	stripSgrSequences,
	truncateToDisplayWidth,
} from "./display-text.js";
import { shouldUseColor, terminalSupportsAnsi, type UiTheme } from "./theme.js";

export interface MenuItem<T = string> {
	label: string;
	value: T;
	hint?: string;
	disabled?: boolean;
	separator?: boolean;
	kind?: "heading";
	color?: "red" | "green" | "yellow" | "cyan";
}

export interface SelectOptions {
	message: string;
	subtitle?: string;
	help?: string;
	clearScreen?: boolean;
	variant?: "legacy" | "codex";
	theme?: UiTheme;
}

const ESCAPE_TIMEOUT_MS = 50;

function colorCode(color: MenuItem["color"]): string {
	switch (color) {
		case "red":
			return ANSI.red;
		case "green":
			return ANSI.green;
		case "yellow":
			return ANSI.yellow;
		case "cyan":
			return ANSI.cyan;
		default:
			return "";
	}
}

function codexColorCode(theme: UiTheme, color: MenuItem["color"]): string {
	switch (color) {
		case "red":
			return theme.colors.danger;
		case "green":
			return theme.colors.success;
		case "yellow":
			return theme.colors.warning;
		case "cyan":
			return theme.colors.accent;
		default:
			return theme.colors.heading;
	}
}

/**
 * Untrusted menu text (labels, hints, messages) is sanitized before
 * interpolation: control characters, bidi overrides, and non-SGR escape
 * sequences are stripped while any styling a caller deliberately applied
 * survives.
 */
function sanitizeMenuText(value: string | undefined): string | undefined {
	return sanitizeDisplayText(value, { preserveSgr: true });
}

export async function select<T>(items: MenuItem<T>[], options: SelectOptions): Promise<T | null> {
	if (!isTTY()) {
		throw new ConfigError("Interactive select requires a TTY terminal", {
			code: "TTY_REQUIRED",
		});
	}
	if (!terminalSupportsAnsi(process.stdout)) {
		throw new ConfigError(
			"Interactive select requires an ANSI-capable terminal (TERM reports none)",
			{ code: "ANSI_UNSUPPORTED" },
		);
	}
	if (items.length === 0) {
		throw new CodexValidationError("No menu items provided", {
			code: "NO_MENU_ITEMS",
			field: "items",
		});
	}

	const isSelectable = (item: MenuItem<T>) =>
		!item.disabled && !item.separator && item.kind !== "heading";
	const selectable = items.filter(isSelectable);
	if (selectable.length === 0) {
		throw new CodexValidationError("All menu items are disabled", {
			code: "ALL_ITEMS_DISABLED",
			field: "items",
		});
	}
	if (selectable.length === 1) {
		return selectable[0]?.value ?? null;
	}

	const { stdin, stdout } = process;
	// A reported size of 0 means "unknown", not "zero columns/rows" — fall back
	// rather than truncate every label to nothing.
	const columns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
	const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
	// Styling is gated independently from cursor control: NO_COLOR and friends
	// strip SGR, while cursor movement has already been proven available above.
	const colorsEnabled = shouldUseColor(stdout);
	const ellipsis = options.theme?.glyphs.ellipsis ?? "...";
	const truncate = (text: string, cols: number) =>
		truncateToDisplayWidth(text, cols, ellipsis);
	const message = sanitizeMenuText(options.message) ?? "";
	const subtitle = sanitizeMenuText(options.subtitle);
	const help = sanitizeMenuText(options.help);
	let cursor = items.findIndex(isSelectable);
	if (cursor < 0) cursor = 0;
	let escapeTimeout: ReturnType<typeof setTimeout> | null = null;
	let cleanedUp = false;
	let renderedLines = 0;
	let pendingKeys = "";

	const renderLegacy = () => {
		const previousRenderedLines = renderedLines;

		if (options.clearScreen) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		} else if (previousRenderedLines > 0) {
			stdout.write(ANSI.up(Math.min(previousRenderedLines, rows)));
		}

		let linesWritten = 0;
		const writeLine = (line: string) => {
			const text = colorsEnabled ? line : stripSgrSequences(line);
			stdout.write(`${ANSI.clearLine}${text}\n`);
			linesWritten += 1;
		};

		const subtitleLines = subtitle ? 3 : 0;
		const fixedLines = 1 + subtitleLines + 2;
		const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1));

		let windowStart = 0;
		let windowEnd = items.length;
		if (items.length > maxVisibleItems) {
			windowStart = cursor - Math.floor(maxVisibleItems / 2);
			windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems));
			windowEnd = windowStart + maxVisibleItems;
		}

		const visibleItems = items.slice(windowStart, windowEnd);
		writeLine(`${ANSI.dim}+ ${ANSI.reset}${truncate(message, Math.max(1, columns - 4))}`);

		if (subtitle) {
			writeLine("|");
			writeLine(`${ANSI.cyan}>${ANSI.reset} ${truncate(subtitle, Math.max(1, columns - 4))}`);
			writeLine("");
		}

		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;

			if (item.separator) {
				writeLine("|");
				continue;
			}

			if (item.kind === "heading") {
				const heading = truncate(
					`${ANSI.dim}${ANSI.bold}${sanitizeMenuText(item.label) ?? ""}${ANSI.reset}`,
					Math.max(1, columns - 6),
				);
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${heading}`);
				continue;
			}

			const selected = itemIndex === cursor;
			const itemLabel = sanitizeMenuText(item.label) ?? "";
			const itemHint = sanitizeMenuText(item.hint);
			let labelText: string;
			if (item.disabled) {
				labelText = `${ANSI.dim}${itemLabel} (unavailable)${ANSI.reset}`;
			} else if (selected) {
				const color = colorCode(item.color);
				labelText = color ? `${color}${itemLabel}${ANSI.reset}` : itemLabel;
				if (itemHint) {
					labelText += ` ${ANSI.dim}${itemHint}${ANSI.reset}`;
				}
			} else {
				const color = colorCode(item.color);
				labelText = color
					? `${ANSI.dim}${color}${itemLabel}${ANSI.reset}`
					: `${ANSI.dim}${itemLabel}${ANSI.reset}`;
				if (itemHint) {
					labelText += ` ${ANSI.dim}${itemHint}${ANSI.reset}`;
				}
			}

			labelText = truncate(labelText, Math.max(1, columns - 8));
			if (selected) {
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${ANSI.green}*${ANSI.reset} ${labelText}`);
			} else {
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${ANSI.dim}o${ANSI.reset} ${labelText}`);
			}
		}

		const windowHint =
			items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
		const helpText = help ?? `Up/Down select | Enter confirm | Esc back${windowHint}`;
		writeLine(
			`${ANSI.cyan}|${ANSI.reset}  ${ANSI.dim}${truncate(helpText, Math.max(1, columns - 6))}${ANSI.reset}`,
		);
		writeLine(`${ANSI.cyan}+${ANSI.reset}`);

		if (!options.clearScreen && previousRenderedLines > linesWritten) {
			const extra = previousRenderedLines - linesWritten;
			for (let i = 0; i < extra; i += 1) {
				writeLine("");
			}
		}

		renderedLines = linesWritten;
	};

	const renderCodex = (theme: UiTheme) => {
		const previousRenderedLines = renderedLines;

		if (options.clearScreen) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		} else if (previousRenderedLines > 0) {
			stdout.write(ANSI.up(Math.min(previousRenderedLines, rows)));
		}

		let linesWritten = 0;
		const writeLine = (line: string) => {
			const text = colorsEnabled ? line : stripSgrSequences(line);
			stdout.write(`${ANSI.clearLine}${text}\n`);
			linesWritten += 1;
		};

		const subtitleLines = subtitle ? 2 : 0;
		const fixedLines = 2 + subtitleLines + 2;
		const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1));

		let windowStart = 0;
		let windowEnd = items.length;
		if (items.length > maxVisibleItems) {
			windowStart = cursor - Math.floor(maxVisibleItems / 2);
			windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems));
			windowEnd = windowStart + maxVisibleItems;
		}

		const visibleItems = items.slice(windowStart, windowEnd);
		const border = theme.colors.border;
		const muted = theme.colors.muted;
		const heading = theme.colors.heading;
		const accent = theme.colors.accent;
		const reset = theme.colors.reset;
		const selectedGlyph = theme.glyphs.selected;
		const unselectedGlyph = theme.glyphs.unselected;

		writeLine(`${border}+${reset} ${heading}${truncate(message, Math.max(1, columns - 4))}${reset}`);
		if (subtitle) {
			writeLine(
				`${border}|${reset} ${muted}${truncate(subtitle, Math.max(1, columns - 4))}${reset}`,
			);
		}
		writeLine(`${border}|${reset}`);

		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;

			if (item.separator) {
				writeLine(`${border}|${reset}`);
				continue;
			}

			if (item.kind === "heading") {
				const headingText = truncate(
					`${theme.colors.dim}${heading}${sanitizeMenuText(item.label) ?? ""}${reset}`,
					Math.max(1, columns - 6),
				);
				writeLine(`${border}|${reset} ${headingText}`);
				continue;
			}

			const selected = itemIndex === cursor;
			const prefix = selected
				? `${accent}${selectedGlyph}${reset}`
				: `${muted}${unselectedGlyph}${reset}`;
			const itemColor = codexColorCode(theme, item.color);
			const itemLabel = sanitizeMenuText(item.label) ?? "";
			const itemHint = sanitizeMenuText(item.hint);
			let labelText: string;
			if (item.disabled) {
				labelText = `${muted}${itemLabel} (unavailable)${reset}`;
			} else if (selected) {
				labelText = `${itemColor}${itemLabel}${reset}`;
			} else {
				labelText = `${muted}${itemLabel}${reset}`;
			}
			if (itemHint) {
				labelText += ` ${muted}${itemHint}${reset}`;
			}

			labelText = truncate(labelText, Math.max(1, columns - 8));
			writeLine(`${border}|${reset} ${prefix} ${labelText}`);
		}

		const windowHint =
			items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
		const helpText = help ?? `Up/Down select | Enter confirm | Esc back${windowHint}`;
		writeLine(`${border}|${reset} ${muted}${truncate(helpText, Math.max(1, columns - 4))}${reset}`);
		writeLine(`${border}+${reset}`);

		if (!options.clearScreen && previousRenderedLines > linesWritten) {
			const extra = previousRenderedLines - linesWritten;
			for (let i = 0; i < extra; i += 1) {
				writeLine("");
			}
		}

		renderedLines = linesWritten;
	};

	const render = () => {
		if (options.variant === "codex" && options.theme) {
			renderCodex(options.theme);
			return;
		}
		renderLegacy();
	};

	return new Promise((resolve) => {
		const wasRaw = stdin.isRaw ?? false;

		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			pendingKeys = "";

			if (escapeTimeout) {
				clearTimeout(escapeTimeout);
				escapeTimeout = null;
			}

			try {
				stdin.removeListener("data", onKey);
				stdin.setRawMode(wasRaw);
				stdin.pause();
				stdout.write(ANSI.show);
			} catch {
				// best effort cleanup
			}

			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
		};

		const finish = (value: T | null) => {
			cleanup();
			resolve(value);
		};

		const onSignal = () => finish(null);

		const findNextSelectable = (from: number, direction: 1 | -1): number => {
			if (items.length === 0) return from;
			let next = from;
			do {
				next = (next + direction + items.length) % items.length;
			} while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading");
			return next;
		};

		/**
		 * Keystrokes can be split across `data` events (`\x1b` then `[A`), so
		 * bytes accumulate in `pendingKeys` until they form a complete key.
		 * A pending escape that never completes resolves as Esc after
		 * ESCAPE_TIMEOUT_MS — the same grace window as before.
		 */
		const dispatchKeys = () => {
			while (pendingKeys.length > 0 && !cleanedUp) {
				const match = matchKeyInput(pendingKeys);
				if (match === null) {
					pendingKeys = pendingKeys.slice(1);
					continue;
				}
				if (match === "incomplete") {
					if (escapeTimeout === null) {
						escapeTimeout = setTimeout(() => {
							escapeTimeout = null;
							// A lone ESC byte is the Escape key; any other abandoned
							// partial sequence is dropped rather than treated as Esc.
							if (pendingKeys === "\x1b") {
								pendingKeys = "";
								finish(null);
								return;
							}
							pendingKeys = "";
							dispatchKeys();
						}, ESCAPE_TIMEOUT_MS);
					}
					return;
				}
				pendingKeys = pendingKeys.slice(match.length);
				switch (match.action) {
					case "up":
						cursor = findNextSelectable(cursor, -1);
						render();
						continue;
					case "down":
						cursor = findNextSelectable(cursor, 1);
						render();
						continue;
					case "enter":
						finish(items[cursor]?.value ?? null);
						return;
					case "escape":
						finish(null);
						return;
					default:
						continue;
				}
			}
		};

		const onKey = (data: Buffer) => {
			if (escapeTimeout) {
				clearTimeout(escapeTimeout);
				escapeTimeout = null;
			}
			pendingKeys += data.toString();
			dispatchKeys();
		};

		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);

		try {
			stdin.setRawMode(true);
		} catch {
			cleanup();
			resolve(null);
			return;
		}

		stdin.resume();
		stdout.write(ANSI.hide);
		render();
		stdin.on("data", onKey);
	});
}
