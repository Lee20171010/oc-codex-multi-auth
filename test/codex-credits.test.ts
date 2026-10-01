import { describe, expect, it } from "vitest";
import {
	CreditsLedger,
	ModelEntitlements,
	formatCreditsBalance,
	formatCreditsBalanceCompact,
	formatCreditsOutOfQuotaHint,
	formatServingOnCreditsToast,
	getCreditsAccountKey,
	hasSpendableCredits,
	parseCreditsAmount,
	parseCreditsHeaders,
	parseUsageCreditsBalance,
	planCreditsFallback,
	type CreditsBalance,
} from "../lib/codex-credits.js";
import { formatSpendableUsageCredits, parseCodexUsagePayload } from "../lib/codex-usage.js";
import { formatQuotaCreditsCandidates, type QuotaOverviewAccount } from "../lib/quota-overview.js";

const balance = (amount: number | null, extra: Partial<CreditsBalance> = {}): CreditsBalance => ({
	hasCredits: amount === null ? true : amount > 0,
	unlimited: false,
	balance: amount,
	...extra,
});

describe("reading a credit balance", () => {
	it.each([
		["62500", 62_500],
		["1,234.50", 1_234.5],
		["$5.00", 5],
		[" 0 ", 0],
		[12, 12],
	])("reads %j as %j", (raw, expected) => {
		expect(parseCreditsAmount(raw)).toBe(expected);
	});

	it.each([["-3"], ["lots"], [""], [Number.NaN], [-1], [null], [undefined]])(
		"treats %j as unreadable rather than zero",
		(raw) => {
			expect(parseCreditsAmount(raw)).toBeNull();
		},
	);

	it("reads the usage document's credits object", () => {
		expect(parseUsageCreditsBalance({ has_credits: true, unlimited: false, balance: "62500" })).toEqual(
			balance(62_500),
		);
		expect(parseUsageCreditsBalance(null)).toBeNull();
		expect(parseUsageCreditsBalance({})).toBeNull();
	});

	it("carries the structured balance on the usage summary", () => {
		const usage = parseCodexUsagePayload({
			credits: { has_credits: true, unlimited: false, balance: "62500" },
		});
		expect(usage.credits).toBe("62500");
		expect(usage.creditsBalance).toEqual(balance(62_500));
	});

	it("reads the x-codex-credits-* response headers like codex-rs does", () => {
		const headers = new Headers({
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "false",
			"x-codex-credits-balance": "62500",
		});
		expect(parseCreditsHeaders(headers)).toEqual(balance(62_500));
		// Both booleans are required, as in codex-rs.
		expect(parseCreditsHeaders(new Headers({ "x-codex-credits-balance": "5" }))).toBeNull();
	});
});

describe("whether a balance can pay for a turn", () => {
	it("lets a stated balance decide over has_credits", () => {
		expect(hasSpendableCredits(balance(62_500))).toBe(true);
		expect(hasSpendableCredits({ hasCredits: true, unlimited: false, balance: 0 })).toBe(false);
		expect(hasSpendableCredits({ hasCredits: true, unlimited: false, balance: null })).toBe(true);
		expect(hasSpendableCredits({ hasCredits: false, unlimited: true, balance: 0 })).toBe(true);
		expect(hasSpendableCredits(null)).toBe(false);
	});

	it("leaves the Credits line out where there is nothing to spend", () => {
		expect(formatSpendableUsageCredits(balance(62_500))).toBe("62,500");
		expect(formatSpendableUsageCredits({ hasCredits: false, unlimited: false, balance: 0 })).toBeNull();
		expect(formatSpendableUsageCredits(null)).toBeNull();
	});

	it("formats balances for messages and for the one-line screen", () => {
		expect(formatCreditsBalance(balance(1_234.5))).toBe("1,234.5");
		expect(formatCreditsBalance(balance(null))).toBe("available");
		expect(formatCreditsBalance(balance(0, { unlimited: true }))).toBe("unlimited");
		expect(formatCreditsBalanceCompact(balance(62_500))).toBe("62.5k");
		expect(formatCreditsBalanceCompact(balance(1_250_000))).toBe("1.2M");
		expect(formatCreditsBalanceCompact(balance(42))).toBe("42");
	});
});

describe("CreditsLedger", () => {
	it("keeps a reading for its time to live, longer only when asked", () => {
		let now = 0;
		const ledger = new CreditsLedger(() => now, 1_000);
		ledger.record("a", balance(10));
		expect(ledger.isSpendable("a")).toBe(true);
		now = 1_001;
		expect(ledger.get("a")).toBeUndefined();
		expect(ledger.get("a", 5_000)).toEqual(balance(10));
	});

	it("records a reading without a credits object as nothing to spend", () => {
		const ledger = new CreditsLedger();
		ledger.record("a", null);
		expect(ledger.get("a")).toBeDefined();
		expect(ledger.isSpendable("a")).toBe(false);
	});

	it("lets a refusal override the balance until it resets", () => {
		let now = 0;
		const ledger = new CreditsLedger(() => now);
		ledger.record("a", balance(10));
		ledger.markRefused("a", 500);
		expect(ledger.isSpendable("a")).toBe(false);
		now = 500;
		expect(ledger.isSpendable("a")).toBe(true);
	});

	it("keys accounts by identity, not by token material", () => {
		const seat = { accountId: "acc", organizationId: "org", accountUserId: "user" };
		expect(getCreditsAccountKey(seat)).toBe(getCreditsAccountKey({ ...seat }));
		expect(getCreditsAccountKey(seat)).not.toBe(getCreditsAccountKey({ ...seat, accountUserId: "other" }));
	});
});

describe("ModelEntitlements", () => {
	it("remembers a seat that cannot serve a model, per model, until it expires", () => {
		let now = 0;
		const entitlements = new ModelEntitlements(() => now, 1_000);
		entitlements.markUnsupported("a", "GPT-6.1-Sol");
		expect(entitlements.isUnsupported("a", "gpt-6.1-sol")).toBe(true);
		expect(entitlements.isUnsupported("a", "gpt-5.5")).toBe(false);
		expect(entitlements.isUnsupported("b", "gpt-6.1-sol")).toBe(false);
		now = 1_000;
		expect(entitlements.isUnsupported("a", "gpt-6.1-sol")).toBe(false);
	});
});

describe("planCreditsFallback", () => {
	const entry = (index: number, eligible: boolean, reasons: string[]) => ({ index, eligible, reasons });
	const base = {
		attempted: new Set<number>(),
		inPool: () => true,
		unsupported: () => false,
		refused: () => false,
		balance: (): CreditsBalance | undefined => undefined,
	};

	it("spends nothing while an entitled account still has plan quota", () => {
		expect(planCreditsFallback([entry(0, true, ["eligible"]), entry(1, false, ["quota-exhausted"])], base))
			.toEqual({ kind: "plan-quota-left" });
	});

	it("ignores plan quota on a seat that cannot serve the model", () => {
		const plan = planCreditsFallback(
			[entry(0, true, ["eligible"]), entry(1, false, ["quota-exhausted"])],
			{ ...base, unsupported: (index) => index === 0 },
		);
		expect(plan).toEqual({ kind: "credits", indices: [1] });
	});

	it("ignores plan quota outside a strict model pool", () => {
		const plan = planCreditsFallback(
			[entry(0, true, ["eligible"]), entry(1, false, ["quota-exhausted"])],
			{ ...base, inPool: (index) => index === 1 },
		);
		expect(plan).toEqual({ kind: "credits", indices: [1] });
	});

	it.each([[["rate-limited"]], [["cooldown:network-error"]], [["token-bucket-empty"]]])(
		"waits for an account only delayed by %j instead of paying around it",
		(reasons) => {
			expect(planCreditsFallback([entry(0, false, reasons), entry(1, false, ["quota-exhausted"])], base))
				.toEqual({ kind: "plan-quota-left" });
		},
	);

	it("does not wait for a disabled account or one whose login failed", () => {
		const plan = planCreditsFallback(
			[entry(0, false, ["disabled"]), entry(1, false, ["cooldown:auth-failure"]), entry(2, false, ["quota-exhausted"])],
			base,
		);
		expect(plan).toEqual({ kind: "credits", indices: [2] });
	});

	it("offers only spent-window accounts with credits: preferred pool first, then the largest balance, unknown last", () => {
		const balances: Record<number, CreditsBalance | undefined> = {
			0: balance(100),
			1: balance(0),
			2: undefined,
			3: balance(5_000),
			4: balance(50),
		};
		const plan = planCreditsFallback(
			[0, 1, 2, 3, 4, 5, 6].map((index) => entry(index, false, ["quota-exhausted"])),
			{
				...base,
				attempted: new Set([5]),
				refused: (index) => index === 6,
				preferred: (index) => index === 4,
				balance: (index) => balances[index],
			},
		);
		expect(plan).toEqual({ kind: "credits", indices: [4, 3, 0, 2] });
	});

	it("does not offer an account blocked by more than its spent window", () => {
		expect(planCreditsFallback([entry(0, false, ["quota-exhausted", "cooldown"])], base))
			.toEqual({ kind: "plan-quota-left" });
	});
});

describe("credits messaging", () => {
	const accounts = [
		{ label: "account 1", balance: balance(1_200) },
		{ label: "account 3", balance: balance(62_500) },
	];

	it("tells a user with the setting off where credits are and how to use them", () => {
		const hint = formatCreditsOutOfQuotaHint({ spendCredits: false, accounts });
		expect(hint).toContain("Codex credits are still available on account 3 (62,500 credits), account 1 (1,200 credits).");
		expect(hint).toContain('"spendCredits": true');
		expect(hint).toContain("CODEX_AUTH_SPEND_CREDITS=1");
	});

	it("says nothing about credits nobody has, unless the setting is on", () => {
		expect(formatCreditsOutOfQuotaHint({ spendCredits: false, accounts: [] })).toBe("");
		expect(formatCreditsOutOfQuotaHint({ spendCredits: true, accounts: [] })).toContain("No account has Codex credits");
		expect(formatCreditsOutOfQuotaHint({ spendCredits: true, accounts })).toContain("none of them could serve");
	});

	it("names the account and the balance when a turn is paid with credits", () => {
		expect(formatServingOnCreditsToast({ label: "account 3", balance: balance(62_500) })).toBe(
			"Plan quota used up on every account. Spending Codex credits on account 3 (62,500 left).",
		);
		expect(formatServingOnCreditsToast({ label: "account 3", balance: undefined })).toBe(
			"Plan quota used up on every account. Spending Codex credits on account 3.",
		);
	});
});

describe("formatQuotaCreditsCandidates", () => {
	const spent = (index: number, email: string, credits?: CreditsBalance): QuotaOverviewAccount => ({
		index,
		email,
		planType: "pro",
		windows: [{ leftPercent: 0 }],
		credits,
	});

	it("lists accounts holding credits once the pool is spent, largest first", () => {
		const candidates = formatQuotaCreditsCandidates(
			[spent(1, "a@example.com", balance(1_200)), spent(2, "b@example.com"), spent(3, "c@example.com", balance(62_500))],
			{},
		);
		expect(candidates[0]).toBe("Codex credits: 62,500 c@example.com, 1,200 a@example.com");
		expect(candidates).toContain("Credits: 62.5k #3, 1.2k #1");
		expect(candidates.at(-1)).toBe("Credits: 2 accounts");
	});

	it("stays empty while any account has quota left, or nobody holds credits", () => {
		const healthy: QuotaOverviewAccount = { index: 2, planType: "pro", windows: [{ leftPercent: 40 }] };
		expect(formatQuotaCreditsCandidates([spent(1, "a@example.com", balance(10)), healthy], {})).toEqual([]);
		expect(formatQuotaCreditsCandidates([spent(1, "a@example.com")], {})).toEqual([]);
	});

	it("masks emails when asked", () => {
		const [first] = formatQuotaCreditsCandidates([spent(1, "alice@example.com", balance(10))], { maskEmail: true });
		expect(first).not.toContain("alice@example.com");
	});
});
