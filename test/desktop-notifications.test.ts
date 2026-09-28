import { describe, expect, it, vi } from "vitest";

import { createDesktopNotifier, isDesktopNotificationSupported } from "../lib/desktop-notifications.js";

type ExecuteCallback = (error: Error | null) => void;

describe("desktop notifications", () => {
	it("uses macOS osascript without interpolating notification content", async () => {
		const executeFile = vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(null);
			},
		);
		const notify = createDesktopNotifier({ platform: "darwin", executeFile });
		const title = 'Quota "$(unsafe)"';
		const message = "10% left\n`unsafe`";

		await expect(notify(title, message)).resolves.toBe(true);
		expect(executeFile).toHaveBeenCalledOnce();
		const [file, args, options] = executeFile.mock.calls[0] ?? [];
		expect(file).toBe("/usr/bin/osascript");
		expect(args?.slice(0, 4)).toEqual(["-l", "JavaScript", "-e", expect.any(String)]);
		// Shell metacharacters survive (argv passing makes them inert), but the
		// notification text is display-sanitized: the newline collapses so the
		// message stays a single line.
		expect(args?.slice(4)).toEqual([title, "10% left `unsafe`"]);
		expect(args?.[3]).not.toContain(title);
		expect(args?.[3]).not.toContain(message);
		expect(options).toEqual({ timeout: 10_000, windowsHide: true });
	});

	it("returns false when osascript reports an error", async () => {
		const executeFile = vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(Object.assign(new Error("failed"), { code: "EACCES" }));
			},
		);
		const notify = createDesktopNotifier({ platform: "darwin", executeFile });

		await expect(notify("Quota", "Body")).resolves.toBe(false);
		expect(executeFile).toHaveBeenCalledOnce();
	});

	it("handles synchronous process errors", async () => {
		const executeFile = vi.fn(() => {
			throw Object.assign(new Error("failed"), { code: "ENOENT" });
		});
		const notify = createDesktopNotifier({ platform: "darwin", executeFile });

		await expect(notify("Quota", "Body")).resolves.toBe(false);
	});

	it("skips unsupported platforms without launching a process", async () => {
		const executeFile = vi.fn();
		const notify = createDesktopNotifier({ platform: "linux", executeFile });

		await expect(notify("Quota", "Body")).resolves.toBe(false);
		expect(executeFile).not.toHaveBeenCalled();
	});
});

describe("desktop notification support", () => {
	it("supports only macOS", () => {
		expect(isDesktopNotificationSupported("darwin")).toBe(true);
		expect(isDesktopNotificationSupported("win32")).toBe(false);
		expect(isDesktopNotificationSupported("linux")).toBe(false);
	});
});
