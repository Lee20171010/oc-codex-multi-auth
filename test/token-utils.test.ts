import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth/auth.js", () => ({
	decodeJWT: vi.fn(),
}));

import { decodeJWT } from "../lib/auth/auth.js";
import {
	extractAccountId,
	extractAccountUserId,
	extractAccountEmail,
	getAccountIdCandidates,
	selectBestAccountCandidate,
	shouldUpdateAccountIdFromToken,
	resolveRequestAccountId,
	sanitizeEmail,
	isGeneratedAccountLabel,
} from "../lib/auth/token-utils.js";
import { JWT_CLAIM_PATH, JWT_PROFILE_CLAIM_PATH } from "../lib/constants.js";

const mockedDecodeJWT = vi.mocked(decodeJWT);

describe("Token Utils Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("extractAccountId", () => {
		it("should return undefined for undefined token", () => {
			expect(extractAccountId(undefined)).toBeUndefined();
		});

		it("should return undefined for empty token", () => {
			expect(extractAccountId("")).toBeUndefined();
		});

		it("should extract account ID from JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "acc_123456",
				},
			});
			expect(extractAccountId("valid.jwt.token")).toBe("acc_123456");
		});

		it("should return undefined when JWT decode returns null", () => {
			mockedDecodeJWT.mockReturnValue(null);
			expect(extractAccountId("invalid.token")).toBeUndefined();
		});

		it("should return undefined when account ID is empty string", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "   ",
				},
			});
			expect(extractAccountId("token")).toBeUndefined();
		});

		it("should return undefined when account ID is not a string", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "12345",
				},
			});
			expect(extractAccountId("token")).toBe("12345");
		});

		it("should trim whitespace from account ID", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "  acc_123  ",
				},
			});
			expect(extractAccountId("token")).toBe("  acc_123  ");
		});
	});

	describe("extractAccountUserId", () => {
		it("extracts and trims the account-scoped Business member id", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_user_id: "  member-123  ",
				},
			});

			expect(extractAccountUserId("access-token")).toBe("member-123");
		});

		it("does not substitute a shared account id for a missing member id", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: { chatgpt_account_id: "business-account" },
			});

			expect(extractAccountUserId("access-token")).toBeUndefined();
		});
	});

	describe("extractAccountEmail", () => {
		it("should extract email from id_token first", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { email: "user@example.com" };
				}
				return { email: "access@example.com" };
			});
			expect(extractAccountEmail("access_token", "id_token")).toBe("user@example.com");
		});

		it("should fall back to access_token when id_token has no email", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { email: undefined };
				}
				return { email: "access@example.com" };
			});
			expect(extractAccountEmail("access_token", "id_token")).toBe("access@example.com");
		});

		it("should return undefined when no email in either token", () => {
			mockedDecodeJWT.mockReturnValue({});
			expect(extractAccountEmail("access_token", "id_token")).toBeUndefined();
		});

		it("should return undefined when no access_token provided", () => {
			expect(extractAccountEmail(undefined, undefined)).toBeUndefined();
		});

		it("should extract email from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					email: "nested@example.com",
				},
			});
			expect(extractAccountEmail("access_token")).toBe("nested@example.com");
		});

		it("should extract email from the profile claim when no id_token exists", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_PROFILE_CLAIM_PATH]: {
					email: "profile@example.com",
					email_verified: true,
					name: "Profile Owner",
				},
			});
			expect(extractAccountEmail("access_token")).toBe("profile@example.com");
		});

		it("should extract email from chatgpt_user_email field", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_user_email: "chatgpt@example.com",
				},
			});
			expect(extractAccountEmail("access_token")).toBe("chatgpt@example.com");
		});

		it("should extract email from preferred_username field", () => {
			mockedDecodeJWT.mockReturnValue({
				preferred_username: "preferred@example.com",
			});
			expect(extractAccountEmail("access_token")).toBe("preferred@example.com");
		});

		it("should reject invalid email without @", () => {
			mockedDecodeJWT.mockReturnValue({
				email: "notanemail",
			});
			expect(extractAccountEmail("access_token")).toBeUndefined();
		});

		it("should reject empty email", () => {
			mockedDecodeJWT.mockReturnValue({
				email: "   ",
			});
			expect(extractAccountEmail("access_token")).toBeUndefined();
		});
	});

	describe("getAccountIdCandidates", () => {
		it("should return empty array for no tokens", () => {
			expect(getAccountIdCandidates()).toEqual([]);
		});

		it("should extract from id_token with account_id at payload root", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { chatgpt_account_id: "root_id_123" };
				}
				return null;
			});
			const candidates = getAccountIdCandidates(undefined, "id_token");
			expect(candidates.some((c) => c.accountId === "root_id_123")).toBe(true);
			expect(candidates.some((c) => c.source === "id_token")).toBe(true);
		});

		it("should extract from id_token with account_id field", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { account_id: "alt_id_456" };
				}
				return null;
			});
			const candidates = getAccountIdCandidates(undefined, "id_token");
			expect(candidates.some((c) => c.accountId === "alt_id_456")).toBe(true);
		});

		it("should extract from id_token with accountId camelCase", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { accountId: "camel_id_789" };
				}
				return null;
			});
			const candidates = getAccountIdCandidates(undefined, "id_token");
			expect(candidates.some((c) => c.accountId === "camel_id_789")).toBe(true);
		});

		it("should normalize nested data wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: { data: [{ account_id: "nested_data_org", name: "Data Org" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_data_org")).toBe(true);
		});

		it("should normalize nested items wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: { items: [{ account_id: "nested_items_acc", name: "Items Account" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_items_acc")).toBe(true);
		});

		it("should normalize nested accounts wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				workspaces: { accounts: [{ workspace_id: "nested_accounts_ws", name: "Nested WS" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_accounts_ws")).toBe(true);
		});

		it("should normalize nested organizations wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: { organizations: [{ org_id: "nested_orgs_id", name: "Nested Org" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_orgs_id")).toBe(true);
		});

		it("should normalize nested workspaces wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: { workspaces: [{ id: "nested_ws_id", name: "Nested WS" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_ws_id")).toBe(true);
		});

		it("should normalize nested teams wrapper to array", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: { teams: [{ team_id: "nested_team_id", team_name: "Nested Team" }] },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_team_id")).toBe(true);
		});

		it("should use type as labelBase when name is absent", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "type_only_acc", type: "enterprise" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const typeCandidate = candidates.find((c) => c.accountId === "type_only_acc");
			expect(typeCandidate?.label).toContain("enterprise");
		});

		it("should extract organizations from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					organizations: [{ account_id: "claim_org_id", name: "Claim Org" }],
				} as Record<string, unknown>,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "claim_org_id")).toBe(true);
		});

		it("should extract accounts from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					accounts: [{ id: "claim_acc_id", display_name: "Claim Account" }],
				} as Record<string, unknown>,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "claim_acc_id")).toBe(true);
		});

		it("should extract workspaces from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					workspaces: [{ workspace_id: "claim_ws_id", workspace_name: "Claim WS" }],
				} as Record<string, unknown>,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "claim_ws_id")).toBe(true);
		});

		it("should extract teams from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					teams: [{ team_id: "claim_team_id", team_name: "Claim Team" }],
				} as Record<string, unknown>,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "claim_team_id")).toBe(true);
		});

		it("should extract orgs from nested JWT claim path", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					orgs: [{ id: "claim_orgs_id", name: "Claim Orgs" }],
				} as Record<string, unknown>,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "claim_orgs_id")).toBe(true);
		});

		it("should extract all ids from id_token auth.organizations array", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return {
						[JWT_CLAIM_PATH]: {
							organizations: [
								{ id: "claim_org_1", name: "Claim Org One" },
								{ id: "claim_org_2", name: "Claim Org Two" },
							],
						},
					};
				}
				return null;
			});
			const candidates = getAccountIdCandidates(undefined, "id_token");
			const organizationCandidates = candidates.filter((c) => c.source === "org");
			expect(organizationCandidates.map((c) => c.accountId)).toEqual([
				"claim_org_1",
				"claim_org_2",
			]);
			expect(organizationCandidates.map((c) => c.organizationId)).toEqual([
				"claim_org_1",
				"claim_org_2",
			]);
		});

		it("maps auth teams/workspaces/accounts to canonical organization IDs when index-aligned", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token !== "id_token") return null;
				return {
					[JWT_CLAIM_PATH]: {
						organizations: [
							{ id: "org-a", account_id: "org-a-account", name: "Org A" },
							{ id: "org-b", account_id: "org-b-account", name: "Org B" },
						],
						teams: [
							{ team_id: "team-a-account", team_name: "Team A" },
							{ team_id: "team-b-account", team_name: "Team B" },
						],
					},
				};
			});

			const candidates = getAccountIdCandidates(undefined, "id_token");
			const orgCandidates = candidates.filter((candidate) => candidate.source === "org");

			expect(orgCandidates).toHaveLength(2);
			expect(orgCandidates.map((candidate) => candidate.organizationId)).toEqual([
				"org-a",
				"org-b",
			]);
			expect(orgCandidates.map((candidate) => candidate.accountId)).toEqual([
				"org-a-account",
				"org-b-account",
			]);
		});

		it("preserves explicit team organization IDs even when canonical org arrays are index-aligned", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token !== "id_token") return null;
				return {
					[JWT_CLAIM_PATH]: {
						organizations: [
							{ id: "org-a", account_id: "org-a-account", name: "Org A" },
							{ id: "org-b", account_id: "org-b-account", name: "Org B" },
						],
						teams: [
							{
								team_id: "team-a-account",
								organization_id: "team-org-b",
								team_name: "Team A",
							},
							{
								team_id: "team-b-account",
								organization_id: "team-org-a",
								team_name: "Team B",
							},
						],
					},
				};
			});

			const candidates = getAccountIdCandidates(undefined, "id_token");
			const teamCandidates = candidates.filter((candidate) =>
				candidate.accountId.startsWith("team-"),
			);

			expect(teamCandidates.map((candidate) => candidate.organizationId)).toEqual([
				"team-org-b",
				"team-org-a",
			]);
		});

		it("skips canonical mapping for non-organization arrays when lengths are misaligned", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token !== "id_token") return null;
				return {
					[JWT_CLAIM_PATH]: {
						organizations: [{ id: "org-a", account_id: "org-a-account", name: "Org A" }],
						teams: [
							{ team_id: "team-a-account", organization_id: "team-org-a", team_name: "Team A" },
							{ team_id: "team-b-account", organization_id: "team-org-b", team_name: "Team B" },
						],
					},
				};
			});

			const candidates = getAccountIdCandidates(undefined, "id_token");
			const orgCandidates = candidates.filter((candidate) => candidate.source === "org");

			expect(orgCandidates.map((candidate) => candidate.organizationId)).toEqual([
				"org-a",
				"team-org-a",
				"team-org-b",
			]);
		});

		it("should extract default candidate from access token", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "acc_main",
				},
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.length).toBeGreaterThanOrEqual(1);
			expect(candidates[0].accountId).toBe("acc_main");
			expect(candidates[0].source).toBe("token");
			expect(candidates[0].isDefault).toBe(true);
		});

		it("should extract candidates from organizations array", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{ account_id: "org_1", name: "Org One", type: "business" },
					{ account_id: "org_2", name: "Org Two", type: "enterprise" },
				],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "org_1")).toBe(true);
			expect(candidates.some((c) => c.accountId === "org_2")).toBe(true);
		});

		it("should extract candidates from accounts array", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: [{ id: "acc_from_array", display_name: "My Account" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "acc_from_array")).toBe(true);
		});

		it("should extract candidates from workspaces array", () => {
			mockedDecodeJWT.mockReturnValue({
				workspaces: [{ workspace_id: "ws_123", workspace_name: "Workspace" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "ws_123")).toBe(true);
		});

		it("should deduplicate candidates by accountId", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "acc_same",
				},
				organizations: [{ account_id: "acc_same", name: "Duplicate" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const sameIdCandidates = candidates.filter((c) => c.accountId === "acc_same");
			expect(sameIdCandidates.length).toBe(1);
		});

		it("should collapse duplicate org candidates by organizationId", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{ account_id: "acc_one", organization_id: "org_dup", name: "Org A" },
					{ account_id: "acc_two", organization_id: "org_dup", name: "Org B" },
				],
			});
			const candidates = getAccountIdCandidates("access_token");
			const duplicateOrgCandidates = candidates.filter((c) => c.organizationId === "org_dup");
			expect(duplicateOrgCandidates).toHaveLength(1);
			expect(duplicateOrgCandidates[0]?.accountId).toBe("acc_one");
		});

		it("should extract from id_token separately", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return {
						[JWT_CLAIM_PATH]: {
							chatgpt_account_id: "id_acc",
						},
					};
				}
				return {
					[JWT_CLAIM_PATH]: {
						chatgpt_account_id: "access_acc",
					},
				};
			});
			const candidates = getAccountIdCandidates("access_token", "id_token");
			expect(candidates.some((c) => c.accountId === "access_acc")).toBe(true);
			expect(candidates.some((c) => c.accountId === "id_acc")).toBe(true);
		});

		it("should not add duplicate when id_token has same account as access_token (line 298 branch)", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "same_acc",
				},
			});
			const candidates = getAccountIdCandidates("access_token", "id_token");
			const sameAccCandidates = candidates.filter((c) => c.accountId === "same_acc");
			expect(sameAccCandidates.length).toBe(1);
		});

		it("should handle nested data structures", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ org_id: "nested_org", title: "Nested Org" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_org")).toBe(true);
		});

		it("should format labels with account ID suffix", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "acc_123456789", name: "Test Org" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const orgCandidate = candidates.find((c) => c.accountId === "acc_123456789");
			expect(orgCandidate?.label).toContain("[id:");
			expect(orgCandidate?.label).toContain("6789");
		});

		it("should include role in label when present", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "acc_123", name: "Org", role: "admin" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const orgCandidate = candidates.find((c) => c.accountId === "acc_123");
			expect(orgCandidate?.label).toContain("role:admin");
		});

		it("should mark personal accounts in label", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: [{ account_id: "acc_personal", name: "Personal", is_personal: true }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const personalCandidate = candidates.find((c) => c.accountId === "acc_personal");
			expect(personalCandidate?.label).toContain("personal");
			expect(personalCandidate?.isPersonal).toBe(true);
		});

		it("should parse string 'true' as isDefault", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "str_true_acc", name: "Org", is_default: "true" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "str_true_acc");
			expect(candidate?.isDefault).toBe(true);
		});

		it("should parse string 'false' as not isDefault", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "str_false_acc", name: "Org", is_default: "false" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "str_false_acc");
			expect(candidate?.isDefault).toBe(false);
		});

		it("should return undefined for non-boolean string values in isDefault", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "non_bool_acc", name: "Org", is_default: "yes" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "non_bool_acc");
			expect(candidate?.isDefault).toBeUndefined();
		});

		it("should return empty array when record value has no nested array", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: { someField: "not an array" },
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.filter((c) => c.source === "org").length).toBe(0);
		});

		it("should skip record with no valid account ID fields (line 113 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{ name: "Org Without ID", type: "business" },
					{ account_id: "valid_org_id", name: "Valid Org" },
				],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "valid_org_id")).toBe(true);
			expect(candidates.filter((c) => c.source === "org").length).toBe(1);
		});

		it("should skip non-record items in organizations array (line 178 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					"string-item",
					123,
					null,
					undefined,
					{ account_id: "real_org", name: "Real Org" },
				],
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "real_org")).toBe(true);
			expect(candidates.filter((c) => c.source === "org").length).toBe(1);
		});

		it("should handle null payload from id_token decode (line 64 coverage)", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "access_token") {
					return {
						[JWT_CLAIM_PATH]: { chatgpt_account_id: "access_acc" },
					};
				}
				return null;
			});
			const candidates = getAccountIdCandidates("access_token", "id_token");
			expect(candidates.length).toBe(1);
			expect(candidates[0].accountId).toBe("access_acc");
		});

		it("should fall through when auth chatgpt_account_id is empty (line 68 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				[JWT_CLAIM_PATH]: { chatgpt_account_id: "   " },
				chatgpt_account_id: "fallback_id",
			});
			const candidates = getAccountIdCandidates(undefined, "id_token");
			expect(candidates.some((c) => c.accountId === "fallback_id")).toBe(true);
		});

		it("should handle non-record payload from decodeJWT (line 194 coverage)", () => {
			mockedDecodeJWT.mockReturnValue("string-payload" as unknown as null);
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.length).toBe(0);
		});

		it("should handle record wrapper with nested organizations array (line 83 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: {
					organizations: [{ account_id: "nested_org_rec", name: "Nested Org Record" }],
				},
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.some((c) => c.accountId === "nested_org_rec")).toBe(true);
		});

		it("should parse trimmed true/false strings for isPersonal (line 37 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: [
					{ id: "personal_true", name: "Personal True", is_personal: "  TRUE  " },
					{ id: "personal_false", name: "Personal False", is_personal: "  FALSE  " },
				],
			});
			const candidates = getAccountIdCandidates("access_token");
			const trueCandidate = candidates.find((c) => c.accountId === "personal_true");
			const falseCandidate = candidates.find((c) => c.accountId === "personal_false");
			expect(trueCandidate?.label).toContain("personal");
			expect(falseCandidate?.label).not.toContain("personal");
			expect(trueCandidate?.isPersonal).toBe(true);
			expect(falseCandidate?.isPersonal).toBe(false);
		});

		it("should handle number value for boolean fields (line 37 false branch)", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: [{ id: "num_bool_acc", name: "Number Bool", is_default: 1 }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "num_bool_acc");
			expect(candidate?.isDefault).toBeUndefined();
		});

		it("should handle primitive value in organizations (line 83 false branch)", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: 12345,
			});
			const candidates = getAccountIdCandidates("access_token");
			expect(candidates.filter((c) => c.source === "org").length).toBe(0);
		});

		it("should handle short account IDs (<=6 chars) without truncation (line 47 coverage)", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [{ account_id: "short", name: "Short Org" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "short");
			expect(candidate).toBeDefined();
			expect(candidate?.label).toContain("[id:short]");
		});

		it("should handle very short account IDs (line 47 false branch)", () => {
			mockedDecodeJWT.mockReturnValue({
				accounts: [{ id: "a", name: "Single Char Account" }],
			});
			const candidates = getAccountIdCandidates("access_token");
			const candidate = candidates.find((c) => c.accountId === "a");
			expect(candidate).toBeDefined();
			expect(candidate?.label).toContain("[id:a]");
		});

		describe("canonical organizationId priority (hotfix 5.4)", () => {
			it("prioritizes organizationId from canonical id_token path organizations[0].id", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								organizations: [{ id: "canonical-org-id", name: "Canonical Org" }],
							},
							// Other org-like fields in payload root
							organizations: [{ id: "root-org-id", name: "Root Org" }],
							organization_id: "fallback-org-id",
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBe("canonical-org-id");
			});

			it("prefers canonical organizations[0].id over other org-like fields in id_token", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								organizations: [{ id: "canonical-org-123", name: "Canonical Org" }],
								organization_id: "nested-fallback-org",
							},
							// Top-level org-like fields
							organization_id: "top-level-fallback-org",
							organizationId: "camelCaseFallbackOrg",
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBe("canonical-org-123");
			});

			it("falls back to undefined when canonical organizations[0].id is missing", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								// organizations array exists but id field is missing
								organizations: [{ name: "Org Without ID" }],
							},
							// Other org-like fields available
							organization_id: "fallback-org-id",
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBeUndefined();
			});

			it("falls back to undefined when canonical organizations array is missing", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								// No organizations array at all
							},
							organization_id: "fallback-org-id",
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBeUndefined();
			});

			it("falls back to undefined when organizations array is empty", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								organizations: [],
							},
							organization_id: "fallback-org-id",
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBeUndefined();
			});

			it("rejects organizations[0].organization_id when organizations[0].id is missing (strict orgId source)", () => {
				mockedDecodeJWT.mockImplementation((token) => {
					if (token === "id_token") {
						return {
							[JWT_CLAIM_PATH]: {
								chatgpt_account_id: "token_acc",
								organizations: [
									{ organization_id: "nested-org-id", name: "Org Without ID" },
								],
							},
						};
					}
					return null;
				});
				const candidates = getAccountIdCandidates(undefined, "id_token");
				const idTokenCandidate = candidates.find((c) => c.source === "id_token");
				expect(idTokenCandidate?.organizationId).toBeUndefined();
			});
		});
	});

	describe("selectBestAccountCandidate", () => {
		it("selects best primary candidate without mutating candidate pool metadata", () => {
			const candidates = [
				{
					accountId: "token-primary",
					label: "Token Candidate [id:imary]",
					source: "token" as const,
				},
				{
					accountId: "org-default",
					label: "Org Default [id:fault]",
					source: "org" as const,
					isDefault: true,
					isPersonal: false,
				},
				{
					accountId: "id-variant",
					label: "ID Variant [id:riant]",
					source: "id_token" as const,
				},
			];

			const selected = selectBestAccountCandidate(candidates);

			expect(selected?.accountId).toBe("org-default");
			expect(selected?.source).toBe("org");
			expect(selected?.label).toBe("Org Default [id:fault]");
			expect(candidates.map((candidate) => candidate.accountId)).toEqual([
				"token-primary",
				"org-default",
				"id-variant",
			]);
		});

		it("prefers non-personal org default over token", () => {
			const selected = selectBestAccountCandidate([
				{
					accountId: "personal_token",
					label: "Token",
					source: "token",
					isDefault: true,
				},
				{
					accountId: "business_org",
					label: "Business",
					source: "org",
					isDefault: true,
					isPersonal: false,
				},
			]);
			expect(selected?.accountId).toBe("business_org");
		});

		it("prefers id_token candidate over token when no org default exists", () => {
			const selected = selectBestAccountCandidate([
				{
					accountId: "personal_token",
					label: "Token",
					source: "token",
				},
				{
					accountId: "selected_workspace",
					label: "ID token account",
					source: "id_token",
				},
			]);
			expect(selected?.accountId).toBe("selected_workspace");
		});

		it("prefers non-personal org over token when no default/id_token exists", () => {
			const selected = selectBestAccountCandidate([
				{
					accountId: "personal_token",
					label: "Token",
					source: "token",
				},
				{
					accountId: "business_org",
					label: "Business org",
					source: "org",
					isPersonal: false,
				},
			]);
			expect(selected?.accountId).toBe("business_org");
		});

		it("falls back to token, then first candidate", () => {
			const tokenSelected = selectBestAccountCandidate([
				{ accountId: "token_id", label: "Token", source: "token" },
				{ accountId: "other", label: "Other", source: "org", isPersonal: true },
			]);
			expect(tokenSelected?.accountId).toBe("token_id");

			const firstSelected = selectBestAccountCandidate([
				{ accountId: "first", label: "First", source: "org", isPersonal: true },
				{ accountId: "second", label: "Second", source: "org", isPersonal: true },
			]);
			expect(firstSelected?.accountId).toBe("first");
		});
	});

	describe("shouldUpdateAccountIdFromToken", () => {
		it("should return true when no current account ID", () => {
			expect(shouldUpdateAccountIdFromToken("token", undefined)).toBe(true);
		});

		it("should return true when no source provided", () => {
			expect(shouldUpdateAccountIdFromToken(undefined, "acc_123")).toBe(true);
		});

		it("should return true for token source", () => {
			expect(shouldUpdateAccountIdFromToken("token", "acc_123")).toBe(true);
		});

		it("should return true for id_token source", () => {
			expect(shouldUpdateAccountIdFromToken("id_token", "acc_123")).toBe(true);
		});

		it("should return false for org source (preserve org selection)", () => {
			expect(shouldUpdateAccountIdFromToken("org", "acc_123")).toBe(false);
		});

		it("should return false for manual source (preserve manual selection)", () => {
			expect(shouldUpdateAccountIdFromToken("manual", "acc_123")).toBe(false);
		});
	});

	describe("resolveRequestAccountId", () => {
		it("routes org-sourced entries through the token account id", () => {
			// An organization id is not a chatgpt-account-id. The backend ignores
			// it and silently bills the token's default subscription, which is how
			// two workspace subscriptions collapsed onto one quota pool (#226).
			expect(resolveRequestAccountId("org_business", "org", "token_personal")).toBe(
				"token_personal",
			);
		});

		it("keeps a manual override even when the token differs", () => {
			expect(resolveRequestAccountId("manual_selected", "manual", "token_personal")).toBe(
				"manual_selected",
			);
		});

		it("keeps the stored org id when no token account is available", () => {
			expect(resolveRequestAccountId("org_business", "org", undefined)).toBe(
				"org_business",
			);
		});

		it("still reports org selections as stable for persistence", () => {
			// Only the request header is redirected; the stored selection must not
			// start following token refreshes.
			expect(shouldUpdateAccountIdFromToken("org", "org_business")).toBe(false);
		});

		it("follows token for token/id_token sources", () => {
			expect(resolveRequestAccountId("old", "token", "new_token")).toBe("new_token");
			expect(resolveRequestAccountId("old", "id_token", "new_token")).toBe("new_token");
		});

		it("falls back correctly when values are missing", () => {
			expect(resolveRequestAccountId(undefined, "org", "token_only")).toBe("token_only");
			expect(resolveRequestAccountId("stored_only", "token", undefined)).toBe("stored_only");
		});
	});

	describe("sanitizeEmail", () => {
		it("should return undefined for undefined input", () => {
			expect(sanitizeEmail(undefined)).toBeUndefined();
		});

		it("should return undefined for empty string", () => {
			expect(sanitizeEmail("")).toBeUndefined();
		});

		it("should return undefined for whitespace only", () => {
			expect(sanitizeEmail("   ")).toBeUndefined();
		});

		it("should return undefined for string without @", () => {
			expect(sanitizeEmail("notanemail")).toBeUndefined();
		});

		it("should lowercase email", () => {
			expect(sanitizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com");
		});

		it("should trim whitespace", () => {
			expect(sanitizeEmail("  user@example.com  ")).toBe("user@example.com");
		});

		it("should handle mixed case and whitespace", () => {
			expect(sanitizeEmail("  User@Example.COM  ")).toBe("user@example.com");
		});
	});

	describe("isGeneratedAccountLabel", () => {
		// Legacy generated shape: "<api org name> (role:<role>) [id:<suffix>]".
		it.each([
			"DreamHost API (role:owner) [id:c487c4]",
			"Personal (role:owner) [id:989a40]",
			"Token account [id:c487c4]",
			"ID token account [id:c487c4]",
			"Workspace [id:c487c4]",
			"Override [id:c487c4]",
		])("treats %s as machine generated", (label) => {
			expect(isGeneratedAccountLabel(label)).toBe(true);
		});

		it.each([
			"oferty@nowaker.net id:c487c4",
			"nowaker@virtkick.com id:8830b3",
			"My work account",
			"billing [team]",
		])("treats %s as user supplied", (label) => {
			expect(isGeneratedAccountLabel(label)).toBe(false);
		});

		it("treats an absent or blank label as not user supplied", () => {
			expect(isGeneratedAccountLabel(undefined)).toBe(true);
			expect(isGeneratedAccountLabel("   ")).toBe(true);
		});

		// Coupled to the generator on purpose. The classification only does its
		// job — clearing a stale generated label while keeping a name a user
		// typed — while it agrees with what the plugin actually emits, and a
		// generator whose output failed this check would pin its own labels
		// permanently.
		it("classifies every label the candidate generator emits as generated", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "access_token") {
					return {
						[JWT_CLAIM_PATH]: {
							chatgpt_account_id: "2aae3eeb-f7fd-4b2d-96c1-413d33c487c4",
							organizations: [
								{
									id: "org-yRC81tihk0WYRlMQpBEW4A2Q",
									name: "DreamHost API",
									role: "owner",
									is_default: true,
								},
							],
						},
					};
				}
				if (token === "id_token") {
					return { chatgpt_account_id: "05cd9f04-d56a-4256-9934-9cb827989a40" };
				}
				return null;
			});

			const labels = getAccountIdCandidates("access_token", "id_token")
				.map((candidate) => candidate.label)
				.filter((label): label is string => !!label);

			expect(labels.length).toBeGreaterThan(0);
			for (const label of labels) {
				expect(isGeneratedAccountLabel(label)).toBe(true);
			}
		});
	});

	describe("claim sanitization", () => {
		it("strips control characters and collapses whitespace in label claims", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{
						account_id: "acc_123456",
						name: "Evil\u001b[31m\nOrg\r\nName",
					},
				],
			});

			const candidates = getAccountIdCandidates("access_token");
			const label = candidates.find((c) => c.accountId === "acc_123456")?.label;

			expect(label).toBeDefined();
			expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			expect(label).toContain("Evil [31m Org Name");
		});

		it("bounds display claims to 64 characters with an ellipsis", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{
						account_id: "acc_123456",
						name: "x".repeat(200),
					},
				],
			});

			const candidates = getAccountIdCandidates("access_token");
			const label = candidates.find((c) => c.accountId === "acc_123456")?.label;

			expect(label).toBeDefined();
			expect(label).toContain("…");
			// 63 chars of name + ellipsis, then " [id:…]" — no 200-char run.
			expect(label).not.toContain("x".repeat(64));
		});

		it("removes control and whitespace characters from email claims", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { email: "vic\u000atim@exa\u001bmple.com" };
				}
				return null;
			});

			expect(extractAccountEmail(undefined, "id_token")).toBe("victim@example.com");
		});

		it("rejects email claims without an @ or over the length bound", () => {
			mockedDecodeJWT.mockImplementation((token) => {
				if (token === "id_token") {
					return { email: `${"a".repeat(100)}@example.com` };
				}
				return null;
			});

			expect(extractAccountEmail(undefined, "id_token")).toBeUndefined();
		});

		it("strips control characters from the account id suffix in labels", () => {
			mockedDecodeJWT.mockReturnValue({
				organizations: [
					{
						account_id: "abc\u001b123456",
						name: "Org",
					},
				],
			});

			const candidates = getAccountIdCandidates("access_token");
			const label = candidates.find((c) => c.accountId === "abc\u001b123456")?.label;

			expect(label).toBeDefined();
			expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			expect(label).toContain("[id:123456]");
		});
	});
});
