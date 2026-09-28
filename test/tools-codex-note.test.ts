import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexNoteTool } from "../lib/tools/codex-note.js";
import {
	StorageTransactionContentionError,
} from "../lib/errors.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import { createUiTheme } from "../lib/ui/theme.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	withAccountStorageTransaction: vi.fn(),
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";

type Persist = (storage: AccountStorageV3) => Promise<void>;
type TxHandler = (
	current: AccountStorageV3 | null,
	persist: Persist,
) => Promise<string>;

function formatCommandAccountLabel(
	account: { email?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const label = account?.accountLabel?.trim();
	const details = [label, email].filter(Boolean);
	if (details.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${details.join(", ")})`;
}

function buildCtx(): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: createUiTheme({ profile: "ansi16", glyphMode: "ascii" }),
		}),
		resolveMaskEmail: () => false,
		promptAccountIndexSelection: () => Promise.resolve(null),
		supportsInteractiveMenus: () => false,
		formatCommandAccountLabel,
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
	};
	return ctx as unknown as ToolContext;
}

function storageWith(note?: string): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				email: "alice@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				...(note === undefined ? {} : { accountNote: note }),
			},
		],
	};
}

describe("codex-note", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(withAccountStorageTransaction).mockReset();
	});

	it("saves a sanitized single-line note", async () => {
		const storage = storageWith();
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: TxHandler) =>
				handler(storage, () => Promise.resolve()),
		);

		const tool = createCodexNoteTool(buildCtx());
		const output = (await tool.execute(
			{ index: 1, note: "check\u0007 every\n monday\u001B[31m" },
			{} as never,
		)) as string;

		expect(output).toContain("Saved note for Account 1");
		expect(output).toContain("check every monday[31m");
		expect(output).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
		expect(storage.accounts[0]?.accountNote).toBe("check every monday[31m");
	});

	it("clears the note on an empty string", async () => {
		const storage = storageWith("old");
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: TxHandler) =>
				handler(storage, () => Promise.resolve()),
		);

		const tool = createCodexNoteTool(buildCtx());
		const output = (await tool.execute(
			{ index: 1, note: "" },
			{} as never,
		)) as string;

		expect(output).toContain("Cleared note for Account 1");
		expect(storage.accounts[0]?.accountNote).toBeUndefined();
	});

	it("reports an ordinary persist failure as honest text, not success", async () => {
		const storage = storageWith();
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: TxHandler) =>
				handler(storage, () => Promise.reject(new Error("EIO"))),
		);

		const tool = createCodexNoteTool(buildCtx());
		const output = (await tool.execute(
			{ index: 1, note: "n" },
			{} as never,
		)) as string;

		expect(output).toContain("failed to persist");
		expect(output).not.toContain("Saved note");
	});

	it("lets lease-compromise contention through persist() reach the caller as retryable", async () => {
		const storage = storageWith();
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: TxHandler) =>
				handler(storage, () =>
					Promise.reject(
						new StorageTransactionContentionError("/tmp/accounts.json"),
					),
				),
		);

		const tool = createCodexNoteTool(buildCtx());
		await expect(
			tool.execute({ index: 1, note: "n" }, {} as never),
		).rejects.toThrow(/locked by another process/i);
		await expect(
			tool.execute({ index: 1, note: "n" }, {} as never),
		).rejects.toThrow(/retry/i);
	});

	it("lets transaction-level contention reject instead of returning text", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(storageWith());
		vi.mocked(withAccountStorageTransaction).mockRejectedValue(
			new StorageTransactionContentionError("/tmp/accounts.json"),
		);

		const tool = createCodexNoteTool(buildCtx());
		await expect(
			tool.execute({ index: 1, note: "n" }, {} as never),
		).rejects.toThrow(/locked by another process/i);
	});

	it("returns the shared error envelope when contention hits a json call", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(storageWith());
		vi.mocked(withAccountStorageTransaction).mockRejectedValue(
			new StorageTransactionContentionError("/tmp/accounts.json"),
		);

		const tool = createCodexNoteTool(buildCtx());
		const output = (await tool.execute(
			{ index: 1, note: "n", format: "json" } as never,
			{} as never,
		)) as string;
		const parsed = JSON.parse(output) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			ok: false,
			tool: "codex-note",
			error: "CODEX_STORAGE_TRANSACTION_CONTENTION",
			retryable: true,
		});
		expect(parsed.nextAction).toBeTruthy();
	});

	it("reports account-changed instead of pretending the note saved", async () => {
		const storage = storageWith();
		const emptyCurrent: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "alice@example.com",
					refreshToken: "different-token",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: TxHandler) =>
				handler(emptyCurrent, () => Promise.resolve()),
		);

		const tool = createCodexNoteTool(buildCtx());
		const output = (await tool.execute(
			{ index: 1, note: "n" },
			{} as never,
		)) as string;

		expect(output).toContain("Account changed");
	});
});
