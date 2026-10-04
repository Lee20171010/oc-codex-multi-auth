import { expect, it } from "vitest";
import { normalizeModel } from "../lib/request/request-transformer.js";
import { withV2ModelRequest } from "../lib/v2-request-scope.js";

it("preserves only this native request's exact new wire ID across async transforms", async () => {
 const before = normalizeModel("gpt-9-future");
 await Promise.all(["gpt-9-future", "future-other"].map((model) => withV2ModelRequest({ model, context: 872000 }, async () => {
  await Promise.resolve();
  expect(normalizeModel(model)).toBe(model);
  expect(normalizeModel("unknown-outside-request")).not.toBe("unknown-outside-request");
 })));
 expect(normalizeModel("gpt-9-future")).toBe(before);
});
