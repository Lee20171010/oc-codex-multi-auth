import { afterEach, expect, it, vi } from "vitest";
import { discoverV2Models } from "../lib/v2-model-discovery.js";

vi.mock("../lib/storage.js", () => ({ loadAccounts: async () => null }));
afterEach(() => vi.unstubAllGlobals());

it("retains the host catalog by returning no additions when discovery is unavailable", async () => {
 vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
 expect(await discoverV2Models("openai", async () => ({ type: "api", key: "test" }))).toEqual([]);
});
