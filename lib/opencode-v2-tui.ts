import type { Plugin } from "@opencode/plugin/tui";
import { createElement, spread } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { CodexStatusRpc } from "./opencode-v2-rpc.js";
import { sanitizeDisplayBlock, sanitizeDisplayText } from "./ui/display-text.js";
import { resolveUiGlyphs } from "./ui/theme.js";

/** Register quota and account views; return a disposer for the V2 TUI slots. */
export function setupV2Tui(context: Plugin.Context) {
	const [text, setText] = createSignal("");
	const [accounts, setAccounts] = createSignal("Loading accounts…");
	const [accountStorage, setAccountStorage] = createSignal<"project" | "global" | "unknown">("unknown");
	const [showFor, setShowFor] = createSignal("always");
	const disposers = [context.ui.slot({
		append: "app",
		render: () => {
			let details = "Quota is loading.";
			let disposed = false;
			let pending = false;
			const controller = new AbortController();
			const rpc = context.client.rpc(CodexStatusRpc);
			const refresh = async () => {
				if (pending || disposed) return;
				pending = true;
				try {
					// The raw renderer width goes to the service; the status
					// formatters apply their own single-width reserve, so
					// subtracting here would discount the line twice. An unset or
					// zero width means "unknown", not a one-column terminal.
					const measured = context.renderer.width;
					const width =
						typeof measured === "number" && Number.isFinite(measured) && measured > 0
							? Math.max(1, Math.min(1000, Math.floor(measured)))
							: 80;
					const result = await rpc.status({ width }, {
						location: context.location ?? context.data.location.default(), signal: controller.signal,
					});
					if (disposed) return;
					// The payload crosses an RPC boundary, so treat it as untrusted:
					// strip escapes/controls before it reaches a rendered node. `auto`
					// resolves against this TUI's environment, not the service's.
					const glyphs = resolveUiGlyphs(result.glyphMode ?? "unicode");
					setText(sanitizeDisplayBlock(result.text, { maxLength: 1024 }) ?? "");
					setShowFor(result.showFor);
					setAccountStorage(result.accountStorage);
					setAccounts(result.accounts.length ? result.accounts.map((account) =>
						`${account.active ? glyphs.active : glyphs.inactive} ${account.index}. ${sanitizeDisplayText(account.label) ?? "unknown"}${account.enabled ? "" : " (disabled)"}`,
					).join("\n") : "No Codex accounts in this pool.");
					details = sanitizeDisplayBlock(result.details, { maxLength: 2048 }) ?? "Quota unavailable.";
				} catch {
					if (!disposed) {
						// No RPC result to take a glyph mode from — `auto` resolves
						// against this TUI's own environment.
						const fallback = resolveUiGlyphs("auto");
						setText("limits ?");
						setAccountStorage("unknown");
						setAccounts(`Accounts unavailable ${fallback.emDash} retry shortly.`);
						details = `Quota unavailable ${fallback.emDash} retry shortly.`;
					}
				} finally {
					pending = false;
				}
			};
			void refresh();
			const timer = setInterval(() => { void refresh(); }, 2_000);
			context.keymap.layer(() => ({
				mode: "global",
				commands: [{
					id: "codex.quota.details", title: "Codex quota details", group: "Codex", palette: true,
					async run() {
						await refresh();
						await context.ui.dialog.alert({ title: "Codex quota", message: details });
					},
				}, {
					id: "codex.logout", title: "Codex logout", group: "Codex", palette: true,
					slash: { name: "codex-logout" },
					description: "Remove the OpenAI OAuth connection stored in OpenCode",
					async run() {
						const integration = (await context.client.integration.list().catch(() => undefined))?.data
							.find((item) => item.id === "openai");
						const credentials = (integration?.connections ?? []).flatMap((connection) =>
							connection.type === "credential" && connection.method === "oauth" ? [connection] : [],
						);
						if (credentials.length === 0) {
							await context.ui.dialog.alert({
								title: "Codex logout",
								message:
									"No OpenAI OAuth connection is stored in OpenCode. The Codex account pool is managed separately — see /codex-accounts.",
							});
							return;
						}
						// Credential labels come from the connected service — sanitize
						// before they are interpolated into a rendered dialog.
						const connectionNames = credentials.map(
							(connection) =>
								sanitizeDisplayText(connection.label || connection.id) ?? "unnamed",
						);
						const confirmed = await context.ui.dialog.confirm({
							title: "Codex logout",
							message:
								connectionNames.length === 1
									? `Remove the OpenAI OAuth connection (${connectionNames[0]})? The Codex account pool is kept — reconnect any account with opencode auth login.`
									: `Remove ${connectionNames.length} OpenAI OAuth connections (${connectionNames.join(", ")})? The Codex account pool is kept — reconnect any account with opencode auth login.`,
							label: { confirm: "Log out" },
						});
						if (confirmed !== true) return;
						let removed = 0;
						for (const connection of credentials) {
							try {
								await context.client.credential.remove({ credentialID: connection.id });
								removed += 1;
							} catch {
								// Counted below so a partial failure surfaces in the result alert.
							}
						}
						await refresh();
						await context.ui.dialog.alert({
							title: "Codex logout",
							message:
								removed === credentials.length
									? "Signed out of OpenAI. The Codex account pool is unchanged — remove pool accounts from /codex-accounts if needed."
									: `Removed ${removed} of ${credentials.length} OpenAI OAuth connection(s). Check opencode auth list and retry the rest.`,
						});
					},
				}, {
					id: "codex.accounts", title: "Codex accounts", group: "Codex", palette: true,
					slash: { name: "codex-accounts" },
					async run() {
						await refresh();
						await context.ui.dialog.alert({
							title: "Codex accounts",
							message: `${accounts()}\n\n${accountStorage() === "project"
								? "Account storage: this project uses its own pool. If it has no account file yet, an existing global pool is used to seed it; later changes stay in this project."
								: accountStorage() === "global"
									? "Account storage: the global pool is shared across projects."
									: "Account storage: unavailable — retry shortly to check which pool is in use."}\nTo change this, set "perProjectAccounts" to true (per-project) or false (global) in ~/.opencode/openai-codex-auth-config.json, then restart the OpenCode service and TUI. CODEX_AUTH_PER_PROJECT_ACCOUNTS overrides this setting: 1 enables per-project storage; 0 disables it.\n\nAdd an account: run opencode auth login${accountStorage() === "project" ? " from this project directory" : ""}, then select OpenAI → Codex OAuth (Add account — ChatGPT Plus/Pro). Repeat for each account, using a private browser window to choose a different login.`,
						});
					},
				}],
			}));
			onCleanup(() => { disposed = true; controller.abort(); clearInterval(timer); });
			return null;
		},
	}), context.ui.slot({
		append: "prompt.footer.status",
		render: (props) => {
			const element = createElement("text");
			spread(element, {
				get children() {
					let providerID = props.sessionID ? context.data.session.get(props.sessionID)?.model?.providerID : undefined;
					if (props.sessionID) {
						const messages = context.data.session.message.list(props.sessionID) ?? [];
						for (let index = messages.length - 1; index >= 0; index -= 1) {
							const message = messages[index];
							if (message?.type !== "assistant") continue;
							providerID = message.model.providerID;
							break;
						}
					}
					return showFor() === "codex-models" && providerID && providerID !== "openai" ? "" : text();
				},
				get fg() { return context.theme.text.base; },
			});
			return element;
		},
	}), context.ui.slot({
		append: "sidebar.content",
		render: () => {
			const element = createElement("text");
			spread(element, {
				get children() { return `\nCodex accounts\n${accounts()}\n/codex-accounts`; },
				get fg() { return context.theme.text.base; },
			});
			return element;
		},
	})];
	return () => { for (const dispose of disposers) dispose(); };
}
