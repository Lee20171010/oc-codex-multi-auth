import { execFile } from "node:child_process";

import { logDebug, logWarn } from "./logger.js";
import { sanitizeDisplayText } from "./ui/display-text.js";

const DELIVERY_TIMEOUT_MS = 10_000;
const MACOS_NOTIFICATION_SCRIPT = `
function run(argv) {
	const app = Application.currentApplication();
	app.includeStandardAdditions = true;
	app.displayNotification(argv[1], { withTitle: argv[0] });
}
`.trim();

type NotificationCallback = (error: Error | null) => void;
type ExecuteFile = (
	file: string,
	args: string[],
	options: { timeout: number; windowsHide: boolean },
	callback: NotificationCallback,
) => unknown;

export type DesktopNotifier = (title: string, message: string) => Promise<boolean>;

const executeFile: ExecuteFile = (file, args, options, callback) => {
	return execFile(file, args, options, (error) => callback(error));
};

function getErrorCode(error: unknown): string {
	if (typeof error !== "object" || error === null) return "unknown";
	const code = (error as Record<string, unknown>).code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "unknown";
}

export function isDesktopNotificationSupported(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "darwin";
}

export function createDesktopNotifier(options?: {
	platform?: NodeJS.Platform;
	executeFile?: ExecuteFile;
}): DesktopNotifier {
	const platform = options?.platform ?? process.platform;
	const run = options?.executeFile ?? executeFile;
	let warningLogged = false;

	const warnOnce = (message: string): void => {
		if (warningLogged) return;
		warningLogged = true;
		logWarn(message);
	};

	return async (title, message) => {
		if (!isDesktopNotificationSupported(platform)) {
			warnOnce("Desktop quota notifications are supported only on macOS.");
			return false;
		}

		// Notification text is built from quota/account strings — strip
		// controls, escapes and bidi marks before it reaches Notification
		// Center (which honours a subset of them).
		const safeTitle = sanitizeDisplayText(title) ?? "Codex";
		const safeMessage = sanitizeDisplayText(message) ?? "";

		return await new Promise<boolean>((resolve) => {
			try {
				run(
					"/usr/bin/osascript",
					["-l", "JavaScript", "-e", MACOS_NOTIFICATION_SCRIPT, safeTitle, safeMessage],
					{ timeout: DELIVERY_TIMEOUT_MS, windowsHide: true },
					(error) => {
						if (!error) {
							resolve(true);
							return;
						}
						logDebug(`Desktop quota notification failed with code ${getErrorCode(error)}`);
						warnOnce("Desktop quota notification delivery failed on macOS.");
						resolve(false);
					},
				);
			} catch (error) {
				logDebug(`Desktop quota notification threw with code ${getErrorCode(error)}`);
				warnOnce("Desktop quota notification delivery failed on macOS.");
				resolve(false);
			}
		});
	};
}

export const sendDesktopNotification = createDesktopNotifier();
