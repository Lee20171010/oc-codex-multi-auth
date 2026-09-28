import { describe, it, expect } from "vitest";
import { renderOAuthErrorHtml } from "../lib/oauth-success.js";

describe("renderOAuthErrorHtml", () => {
	it("escapes heading and detail interpolated into the page", () => {
		const html = renderOAuthErrorHtml(
			"nonce-123",
			`<img src=x onerror=alert(1)>`,
			`detail"><script>alert(2)</script>`,
		);

		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>alert(2)");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("&lt;script&gt;");
	});

	it("binds the style block to the supplied nonce and ships no scripts", () => {
		const html = renderOAuthErrorHtml("NONCE_VALUE", "Heading", "Detail");

		expect(html).toContain(`<style nonce="NONCE_VALUE">`);
		expect(html).not.toContain("<script");
		// Inline style must not reference the nonce of the success page shape.
		expect(html).not.toContain("fonts.googleapis.com");
	});

	it("tells the user to return to the terminal and restart login", () => {
		const html = renderOAuthErrorHtml("n", "Sign-in link mismatch", "detail");

		expect(html).toContain("Return to your terminal");
		expect(html).toContain("restart the login flow");
		expect(html).toContain("Sign-in link mismatch");
		expect(html).toContain("detail");
	});

	it("uses an error accent distinct from the success page", () => {
		const html = renderOAuthErrorHtml("n", "h", "d");

		expect(html).toContain("error-icon");
		expect(html).toContain("Authentication failed");
	});
});
