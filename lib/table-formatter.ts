/**
 * Simple ASCII table formatter for CLI tools.
 * Generates consistent, aligned table output.
 */

import {
	displayWidth,
	padEndDisplay,
	padStartDisplay,
	sanitizeDisplayText,
	truncateToDisplayWidth,
} from "./ui/display-text.js";

export interface TableColumn {
	/** Column header text */
	header: string;
	/** Column width (content will be padded/truncated to fit) */
	width: number;
	/** Alignment: 'left' (default) or 'right' */
	align?: "left" | "right";
}

export interface TableOptions {
	/** Column definitions */
	columns: TableColumn[];
	/** Character used for header separator line (default: '-') */
	separatorChar?: string;
}

/**
 * Format a value to fit within a column width.
 *
 * `width` is a column budget in *display* columns: the value is sanitized
 * (escape sequences and control characters out), truncated on grapheme
 * boundaries so CJK and emoji never split mid-cluster, and padded by measured
 * width so a two-column cell still lines up with its ASCII neighbours.
 */
function formatCell(value: string, width: number, align: "left" | "right" = "left"): string {
	const cols = Math.max(0, Math.floor(width));
	if (cols === 0) return "";
	const clean = sanitizeDisplayText(value) ?? "";
	const truncated =
		displayWidth(clean) > cols
			? truncateToDisplayWidth(clean, cols, "…")
			: clean;
	return align === "right"
		? padStartDisplay(truncated, cols)
		: padEndDisplay(truncated, cols);
}

/**
 * Build a table header row and separator line.
 */
export function buildTableHeader(options: TableOptions): string[] {
	const { columns, separatorChar = "-" } = options;

	const headerRow = columns.map((col) => formatCell(col.header, col.width, col.align)).join(" ");

	const separatorRow = columns
		.map((col) => separatorChar.repeat(Math.max(0, Math.floor(col.width))))
		.join(" ");

	return [headerRow, separatorRow];
}

/**
 * Build a single table row from values.
 * Values are matched to columns by index.
 */
export function buildTableRow(values: string[], options: TableOptions): string {
	const { columns } = options;

	return columns
		.map((col, i) => {
			const value = values[i] ?? "";
			return formatCell(value, col.width, col.align);
		})
		.join(" ");
}

/**
 * Build a complete table with header, separator, and rows.
 */
export function buildTable(rows: string[][], options: TableOptions): string[] {
	const lines = buildTableHeader(options);
	for (const row of rows) {
		lines.push(buildTableRow(row, options));
	}
	return lines;
}
