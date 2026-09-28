/**
 * Repeatable performance benchmark suite for oc-codex-multi-auth.
 *
 * Measures the shipped artifact (dist/) — the same code OpenCode loads.
 * Runnable via `npm run bench` (builds first). NOT part of the test suite or
 * CI gating — vitest only picks up `test/**\/*.test.ts`.
 *
 * Usage:
 *   node --expose-gc test/perf/bench.mjs                  # everything
 *   node --expose-gc test/perf/bench.mjs transform sse    # subset by name fragment
 *   node --expose-gc test/perf/bench.mjs --json=out.json  # also write machine-readable results
 *
 * Baselines live in test/perf/perf-baselines.json — update them deliberately
 * when a benchmark's harness or a measured contract changes.
 *
 * Methodology:
 *   - warmup + steady-state batch sampling. Each *sample* is `batch` timed ops;
 *     the reported per-op time is batch_elapsed/batch, which amortizes the
 *     ~30ns performance.now() overhead for sub-microsecond ops.
 *   - Multiple independent runs per benchmark expose run-to-run variance
 *     (reported as CV% across run means).
 *   - p50/p95/p99 are taken over the pooled per-batch samples.
 */

import { performance, PerformanceObserver } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PERF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(PERF_DIR)); // test/perf -> repo root
const DIST = join(REPO, "dist");
const NS_PER_MS = 1e6;
const NS_PER_US = 1e3;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];

function percentile(sorted, p) {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(p * sorted.length) - 1),
	);
	return sorted[idx];
}

function summarize(samples) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
	const variance =
		samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
		Math.max(1, s.length - 1);
	return {
		n: s.length,
		mean,
		sd: Math.sqrt(variance),
		min: s[0] ?? NaN,
		p50: percentile(s, 0.5),
		p95: percentile(s, 0.95),
		p99: percentile(s, 0.99),
		max: s[s.length - 1] ?? NaN,
	};
}

/**
 * Run a synchronous benchmark.
 * @param {object} o {name, unit, batch, samples, runs, warmup, setup, fn}
 *   `fn(iteration)` is called `batch` times per sample. `unit` scales output:
 *   pass a function `(perBatchNs)=>perOp` to convert (e.g. MB/s).
 */
async function benchSync(o) {
	const {
		name,
		unit = "ns/op",
		batch = 100,
		samples = 30,
		runs = 3,
		warmup = 3,
		setup,
		fn,
		convert = (perBatchNs) => perBatchNs / batch,
	} = o;
	const pooled = [];
	const runMeans = [];
	for (let r = 0; r < runs; r++) {
		const ctx = setup ? await setup(r) : undefined;
		for (let i = 0; i < warmup; i++) fn(i, ctx);
		const runSamples = [];
		for (let s = 0; s < samples; s++) {
			const t0 = performance.now();
			for (let i = 0; i < batch; i++) fn(s * batch + i, ctx);
			// performance.now() is milliseconds; converts below assume ns.
			const dt = (performance.now() - t0) * 1e6;
			runSamples.push(convert(dt));
		}
		pooled.push(...runSamples);
		runMeans.push(runSamples.reduce((a, b) => a + b, 0) / runSamples.length);
		globalThis.gc?.();
	}
	const stat = summarize(pooled);
	const runsStat = summarize(runMeans);
	report(name, unit, stat, runsStat);
	return stat;
}

/** Async variant of benchSync — `fn` is awaited once per op. */
async function benchAsync(o) {
	const {
		name,
		unit = "ns/op",
		batch = 1,
		samples = 30,
		runs = 3,
		warmup = 2,
		setup,
		fn,
		convert = (perBatchNs) => perBatchNs / batch,
	} = o;
	const pooled = [];
	const runMeans = [];
	for (let r = 0; r < runs; r++) {
		const ctx = setup ? await setup(r) : undefined;
		for (let i = 0; i < warmup; i++) await fn(i, ctx);
		const runSamples = [];
		for (let s = 0; s < samples; s++) {
			const t0 = performance.now();
			for (let i = 0; i < batch; i++) await fn(s * batch + i, ctx);
			// performance.now() is milliseconds; converts below assume ns.
			const dt = (performance.now() - t0) * 1e6;
			runSamples.push(convert(dt));
		}
		pooled.push(...runSamples);
		runMeans.push(runSamples.reduce((a, b) => a + b, 0) / runSamples.length);
		globalThis.gc?.();
	}
	const stat = summarize(pooled);
	const runsStat = summarize(runMeans);
	report(name, unit, stat, runsStat);
	return stat;
}

function fmt(v, unit) {
	if (!Number.isFinite(v)) return "n/a";
	if (unit === "MB/s" || unit === "ops/s") return v.toFixed(1);
	if (unit === "ms") return v.toFixed(3);
	if (unit === "µs" || unit === "us") return v.toFixed(2);
	if (unit === "ns") return v.toFixed(1);
	return v.toPrecision(4);
}

function report(name, unit, stat, runsStat) {
	const cv = stat.mean > 0 ? (100 * runsStat.sd) / runsStat.mean : 0;
	results.push({ name, unit, ...stat, runCvPct: cv });
	console.log(
		`${name.padEnd(52)} ${fmt(stat.mean, unit).padStart(12)} ${unit.padEnd(5)} ` +
			`p50=${fmt(stat.p50, unit)} p95=${fmt(stat.p95, unit)} ` +
			`p99=${fmt(stat.p99, unit)} min=${fmt(stat.min, unit)} max=${fmt(stat.max, unit)} ` +
			`(n=${stat.n}, cv=${cv.toFixed(1)}%)`,
	);
}

function section(title) {
	console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 76 - title.length))}`);
}

// ---------------------------------------------------------------------------
// Environment: fake HOME *before* any dist import so module-level homedir()
// calls (CONFIG_PATH, CACHE_DIR) resolve into the sandbox.
// ---------------------------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), "ocperf-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CODEX_KEYCHAIN;
delete process.env.ENABLE_PLUGIN_REQUEST_LOGGING;
delete process.env.CODEX_PLUGIN_LOG_BODIES;
delete process.env.DEBUG_CODEX_PLUGIN;

const OPENCODE_DIR = join(HOME, ".opencode");
const CACHE_DIR = join(OPENCODE_DIR, "cache");
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(join(HOME, ".local", "share", "opencode"), { recursive: true });

// A fake project dir (has an .opencode marker so findProjectRoot picks it).
const FAKE_PROJECT = mkdtempSync(join(tmpdir(), "ocperf-proj-"));
mkdirSync(join(FAKE_PROJECT, ".opencode"), { recursive: true });
// Markerless directory variant (global storage path).
const BARE_DIR = mkdtempSync(join(tmpdir(), "ocperf-bare-"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function fakeJwt(i) {
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: `org_${i % 7}`,
			chatgpt_account_user_id: `user_${i}`,
			chatgpt_plan_type: i % 3 ? "plus" : "pro",
		},
		"https://api.openai.com/profile": { email: `user${i}@example.com` },
		email: `user${i}@example.com`,
	};
	return `${b64u({ alg: "none", typ: "JWT" })}.${b64u(payload)}.${b64u({ s: i })}`;
}

function makeAccountsStorage(n) {
	const now = Date.now();
	const accounts = [];
	for (let i = 0; i < n; i++) {
		accounts.push({
			accountId: `acc_${i % 7}`,
			accountUserId: `user_${i}`,
			organizationId: `org_${i % 7}`,
			accountIdSource: "token",
			...(i % 5 === 0 ? { accountLabel: `Work seat ${i}` } : {}),
			planType: i % 3 ? "plus" : "pro",
			...(i % 6 === 0 ? { accountTags: ["team:a", "seat"] } : {}),
			email: `user${i}@example.com`,
			refreshToken: `rt_${i}_${"x".repeat(720)}`,
			enabled: i % 41 !== 0, // a few disabled
			accessToken: fakeJwt(i),
			expiresAt: now + 3_600_000,
			oauthScope: "openid profile email offline_access",
			tokenRotatedAt: now - 86_400_000,
			addedAt: now - (i + 1) * 60_000,
			lastUsed: now - (i + 1) * 30_000,
			lastSwitchReason: "rotation",
			rateLimitResetTimes:
				i % 4 === 0
					? { codex: now - 1_000, "gpt-5.6-sol": now + 30_000 }
					: {},
		});
	}
	const activeIndexByFamily = {};
	for (const f of [
		"gpt-5-codex", "codex-max", "codex", "gpt-6-astra", "gpt-6-sol",
		"gpt-6-luna", "gpt-daybreak-blue", "gpt-daybreak-red", "gpt-5.6-cyber",
		"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4",
		"gpt-5.4-mini", "gpt-5.4-pro", "gpt-5.2", "gpt-5.1",
	]) activeIndexByFamily[f] = 0;
	return { version: 3, accounts, activeIndex: 0, activeIndexByFamily };
}

const ACCOUNTS_FILE = join(OPENCODE_DIR, "oc-codex-multi-auth-accounts.json");
const storage200 = makeAccountsStorage(200);
writeFileSync(ACCOUNTS_FILE, JSON.stringify(storage200, null, 2));
const accountsFileText = readFileSync(ACCOUNTS_FILE, "utf-8");
const accountsFileParsed = JSON.parse(accountsFileText);

// Plugin config (representative, exercises the schema).
const CONFIG_FILE = join(OPENCODE_DIR, "openai-codex-auth-config.json");
const configA = JSON.stringify(
	{
		rotationStrategy: "hybrid",
		perProjectAccounts: true,
		fastSession: false,
		fastSessionStrategy: "hybrid",
		fastSessionMaxInputItems: 30,
		retryProfile: "balanced",
		retryAllAccountsMaxRetries: 6,
		retryAllAccountsMaxWaitMs: 0,
		quotaDisplay: "free",
		quotaStatus: {
			mode: ["active", "overview"],
			rotateMs: 4000,
			layout: "accounts",
			accountNames: "number",
			order: "number",
			resetTimes: "low",
			resetCredits: true,
			recovery: true,
			resetsMinUsedPercent: 90,
			rows: 1,
			showFor: "always",
		},
		quotaNotifications: { enabled: false, intervalMs: 300000, thresholds: [25, 10] },
	},
	null,
	2,
);
const configB = configA.replace('"rotateMs": 4000', '"rotateMs": 5000');
writeFileSync(CONFIG_FILE, configA);

// Host auth store so the plugin-instantiation backfill early-returns.
writeFileSync(
	join(HOME, ".local", "share", "opencode", "auth.json"),
	JSON.stringify({
		openai: {
			type: "oauth",
			access: "host-access",
			refresh: "host-refresh",
			expires: Date.now() + 3_600_000,
		},
	}),
);

// Prompt cache so getOpenCodeCodexPrompt resolves from disk, never network.
const FAKE_CODEX_TXT = [
	"You are a coding agent running in the OpenCode CLI.",
	"Follow the user's instructions precisely. " + "be concise. ".repeat(120),
].join("\n\n");
writeFileSync(join(CACHE_DIR, "opencode-codex.txt"), FAKE_CODEX_TXT);
writeFileSync(
	join(CACHE_DIR, "opencode-codex-meta.json"),
	JSON.stringify({
		etag: '"bench"',
		lastChecked: Date.now(),
		sourceUrl:
			"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
	}),
);

// ---------------------------------------------------------------------------
// Request-body fixture (realistic OpenCode/AI-SDK shape)
// ---------------------------------------------------------------------------

function makeToolSchema(i) {
	return {
		type: "object",
		properties: {
			path: { type: "string", description: `path parameter for tool ${i}` },
			pattern: { type: ["string", "null"], description: "optional pattern" },
			options: {
				type: "object",
				properties: {
					recursive: { type: "boolean" },
					maxDepth: { type: "number", description: "depth cap" },
					choice: { anyOf: [{ const: "a" }, { const: "b" }] },
				},
				required: ["recursive"],
			},
		},
		required: ["path", `ghost_${i}`],
		additionalProperties: false,
		title: `Tool${i}Params`,
	};
}

const TOOLS = Array.from({ length: 24 }, (_, i) => ({
	type: "function",
	function: {
		name: i === 3 ? "request_user_input" : `tool_${i}`,
		description: `tool number ${i} description`,
		parameters: makeToolSchema(i),
	},
}));

const msg = (role, text, extra = {}) => ({
	type: "message",
	role,
	content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
	...extra,
});

function makeInput() {
	const items = [
		msg("developer", "You are OpenCode, an agent. ".repeat(60), { id: "dev_1" }),
		msg("user", "Please refactor the auth module to split storage from rotation."),
	];
	for (let i = 0; i < 5; i++) {
		items.push(
			{
				type: "function_call",
				id: `fc_${i}`,
				call_id: `call_${i}`,
				name: i % 2 ? "read_file" : "shell",
				arguments: JSON.stringify({ path: `src/file_${i}.ts` }),
			},
			{
				type: "function_call_output",
				id: `fo_${i}`,
				call_id: `call_${i}`,
				output: `result of call ${i} `.repeat(20),
			},
		);
		items.push(
			msg("assistant", `Working on step ${i}. `.repeat(30), { id: `as_${i}` }),
			msg("user", `Follow-up question ${i}: does rotation handle 429s?`),
		);
	}
	items.push(
		{ type: "reasoning", id: "rs_1", summary: [] },
		{ type: "item_reference", id: "ref_x" },
		msg("user", "Final check — any remaining concerns?"),
	);
	return items;
}

const INSTRUCTIONS = "Codex base instructions. ".repeat(80);

function makeBody(model) {
	return {
		model,
		input: makeInput(),
		tools: TOOLS,
		reasoning: { effort: "medium", summary: "auto" },
		text: { verbosity: "medium" },
		max_completion_tokens: 8192,
	};
}

const cloneBody = (b) => JSON.parse(JSON.stringify(b));

// ---------------------------------------------------------------------------
// SSE fixture (~10 MB)
// ---------------------------------------------------------------------------

function buildSseText(targetBytes) {
	const parts = [];
	let size = 0;
	const filler = "const x = compute(value); ".repeat(12); // ~300B deltas
	let i = 0;
	while (size < targetBytes) {
		// Every 4097th delta embeds a quoted "response.done" inside the delta
		// text — a deliberate marker-gate false positive.
		const trap = i % 4097 === 4096 ? ' mentions "response.done" inline' : "";
		const line =
			`data: {"type":"response.output_text.delta","item_id":"msg_1",` +
			`"output_index":0,"content_index":0,` +
			`"delta":"${filler}${trap}"}\n\n`;
		parts.push(line);
		size += line.length;
		i++;
	}
	const finalPayload = {
		type: "response.completed",
		response: {
			id: "resp_bench",
			object: "response",
			status: "completed",
			model: "gpt-6-sol",
			output: [
				{
					type: "message",
					role: "assistant",
					content: [
						{ type: "output_text", text: "done ".repeat(200) },
					],
				},
			],
			usage: { input_tokens: 1200, output_tokens: 8000 },
		},
	};
	parts.push(`data: ${JSON.stringify(finalPayload)}\n\n`);
	parts.push("data: [DONE]\n\n");
	return parts.join("");
}

// MAX_SSE_SIZE in response-handler is 10 MiB; stay under it (~9.8MB final)
// or the bench measures the SSE_TOO_LARGE error path instead of a full parse.
const sseText = buildSseText(9.3 * 1024 * 1024);
const sseBuf = new TextEncoder().encode(sseText);
const SSE_BYTES = sseBuf.byteLength;

function chunkStream(buf, chunkSize) {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= buf.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkSize, buf.length);
			controller.enqueue(buf.subarray(offset, end));
			offset = end;
		},
	});
}

// ---------------------------------------------------------------------------
// dist imports (after env setup)
// ---------------------------------------------------------------------------

const transformer = await import(
	pathToFileURL(join(DIST, "lib/request/request-transformer.js")).href
);
const fetchHelpers = await import(
	pathToFileURL(join(DIST, "lib/request/fetch-helpers.js")).href
);
const promptsCodex = await import(
	pathToFileURL(join(DIST, "lib/prompts/codex.js")).href
);
const lite = await import(
	pathToFileURL(join(DIST, "lib/request/helpers/responses-lite.js")).href
);
const toolUtils = await import(
	pathToFileURL(join(DIST, "lib/request/helpers/tool-utils.js")).href
);
const responseHandler = await import(
	pathToFileURL(join(DIST, "lib/request/response-handler.js")).href
);
const rotation = await import(
	pathToFileURL(join(DIST, "lib/rotation.js")).href
);
const accountsMod = await import(
	pathToFileURL(join(DIST, "lib/accounts.js")).href
);
const probe = await import(
	pathToFileURL(join(DIST, "lib/parallel-probe.js")).href
);
const backoff = await import(
	pathToFileURL(join(DIST, "lib/request/rate-limit-backoff.js")).href
);
const retryBudget = await import(
	pathToFileURL(join(DIST, "lib/request/retry-budget.js")).href
);
const storageMod = await import(
	pathToFileURL(join(DIST, "lib/storage.js")).href
);
const normalize = await import(
	pathToFileURL(join(DIST, "lib/storage/normalize.js")).href
);
const storageState = await import(
	pathToFileURL(join(DIST, "lib/storage/state.js")).href
);
const keychain = await import(
	pathToFileURL(join(DIST, "lib/storage/keychain.js")).href
);
const config = await import(
	pathToFileURL(join(DIST, "lib/config.js")).href
);
const tuiStatus = await import(
	pathToFileURL(join(DIST, "lib/tui-status.js")).href
);
const indexMod = await import(pathToFileURL(join(DIST, "index.js")).href);
const tuiMod = await import(pathToFileURL(join(DIST, "tui.js")).href);

const {
	transformRequestBody,
	filterInput,
	getModelConfig,
	normalizeModel,
} = transformer;
const { transformRequestForCodex } = fetchHelpers;
const { getCodexInstructions } = promptsCodex;
const { shapeBodyForModel } = lite;
const { cleanupToolDefinitions } = toolUtils;
const { convertSseToJson } = responseHandler;
const {
	selectHybridAccount,
	HealthScoreTracker,
	TokenBucketTracker,
	resetTrackers,
} = rotation;
const { AccountManager } = accountsMod;
const { getTopCandidates } = probe;
const { getRateLimitBackoffWithReason, clearRateLimitBackoffState } = backoff;
const { RetryBudgetTracker, resolveRetryBudgetLimits } = retryBudget;
const { loadAccounts } = storageMod;
const { normalizeAccountStorage } = normalize;
const { setStoragePathDirect } = storageState;
const { loadPluginConfig, resetPluginConfigCache } = config;
const { formatPromptStatusText, formatQuotaOverviewStatusLines } = tuiStatus;
const { OpenAIOAuthPlugin } = indexMod;
const { measureStatusSlot } = tuiMod;

const rawArgs = process.argv.slice(2);
const only = [];
for (let i = 0; i < rawArgs.length; i++) {
	const a = rawArgs[i];
	if (a === "--json") {
		// bare --json writes the default results.json; a value form consumes it
		continue;
	}
	if (a.startsWith("--")) continue;
	only.push(a);
}
const want = (name) =>
	only.length === 0 || only.some((f) => name.toLowerCase().includes(f));

// ===========================================================================
// 1. Plugin import / instantiation
// ===========================================================================

if (want("import")) {
	section("plugin import (cold, fresh subprocess each rep)");
	const importCode = (spec) =>
		`const t=performance.now();await import(${JSON.stringify(spec)});` +
		`console.log((performance.now()-t).toFixed(4))`;
	const indexUrl = pathToFileURL(join(DIST, "index.js")).href;
	const tuiUrl = pathToFileURL(join(DIST, "tui.js")).href;
	const spawnImport = (url) => {
		const env = { ...process.env, HOME, USERPROFILE: HOME };
		const t0 = performance.now();
		const out = execFileSync(
			process.execPath,
			["--input-type=module", "-e", importCode(url)],
			{ env, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return { moduleMs: parseFloat(out.trim()), wallMs: performance.now() - t0 };
	};
	const REPS = 10;
	const modSamples = [];
	const wallSamples = [];
	for (let i = 0; i < REPS; i++) {
		const { moduleMs, wallMs } = spawnImport(indexUrl);
		modSamples.push(moduleMs);
		wallSamples.push(wallMs);
	}
	report("import dist/index.js module-eval (cold)", "ms", summarize(modSamples), summarize(modSamples));
	report("import dist/index.js wall (incl. node boot)", "ms", summarize(wallSamples), summarize(wallSamples));
	const tuiModSamples = [];
	for (let i = 0; i < REPS; i++) tuiModSamples.push(spawnImport(tuiUrl).moduleMs);
	report("import dist/tui.js module-eval (cold)", "ms", summarize(tuiModSamples), summarize(tuiModSamples));

	// Node boot reference (empty eval)
	const bootSamples = [];
	for (let i = 0; i < REPS; i++) {
		const t0 = performance.now();
		execFileSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
		bootSamples.push(performance.now() - t0);
	}
	report("node -e 0 baseline (reference)", "ms", summarize(bootSamples), summarize(bootSamples));
}

if (want("runtime") || want("instanti") || want("plugin")) {
	section("createPluginRuntime via OpenAIOAuthPlugin (warm, in-process)");
	const stubClient = {
		app: { log: async () => undefined },
		tui: {
			showToast: async () => undefined,
			showToastMessage: async () => undefined,
		},
	};
	// First call double-duties as warmup; subsequent = steady-state.
	const runtimes = [];
	await benchAsync({
		name: "createPluginRuntime (client, markerless dir)",
		unit: "ms",
		batch: 1,
		samples: 60,
		runs: 3,
		warmup: 5,
		convert: (dt) => dt / NS_PER_MS,
		fn: async () => {
			const hooks = await OpenAIOAuthPlugin({
				client: stubClient,
				directory: BARE_DIR,
			});
			runtimes.push(hooks);
			// Dispose immediately so quota-monitor timers don't accumulate.
			await hooks?.event?.({ event: { type: "server.instance.disposed" } });
		},
	});
	await benchAsync({
		name: "createPluginRuntime (client, project dir)",
		unit: "ms",
		batch: 1,
		samples: 60,
		runs: 3,
		warmup: 5,
		convert: (dt) => dt / NS_PER_MS,
		fn: async () => {
			const hooks = await OpenAIOAuthPlugin({
				client: stubClient,
				directory: FAKE_PROJECT,
			});
			runtimes.push(hooks);
			await hooks?.event?.({ event: { type: "server.instance.disposed" } });
		},
	});
	setStoragePathDirect(ACCOUNTS_FILE); // restore pinned path for later suites
}

// ===========================================================================
// 2. transformRequestBody per model family
// ===========================================================================

if (want("transform")) {
	section("transformRequestBody per model family (clone+transform vs clone)");

	const bodyTemplates = {
		"gpt-5.1": makeBody("gpt-5.1"),
		"gpt-5-codex": makeBody("gpt-5-codex"),
		"gpt-5.6-sol": makeBody("gpt-5.6-sol"),
		"gpt-6-astra": makeBody("gpt-6-astra"),
		"openai/gpt-5.1-codex-max-xhigh": makeBody("openai/gpt-5.1-codex-max-xhigh"),
		"GPT 5 Codex Low (ChatGPT Subscription)": makeBody(
			"GPT 5 Codex Low (ChatGPT Subscription)",
		),
	};
	const userConfig = { global: {}, models: {} };

	// Warm the prompt + per-family instruction caches once (first call reads
	// disk/fetches; every later call is a memory hit with fresh TTL).
	await transformRequestBody(cloneBody(bodyTemplates["gpt-5.1"]), INSTRUCTIONS, userConfig);
	for (const m of ["gpt-5-codex", "gpt-5.1", "gpt-5.6-sol", "gpt-6-astra"]) {
		await getCodexInstructions(m).catch(() => {});
	}

	await benchAsync({
		name: "clone body (fixture cost, for reference)",
		unit: "µs",
		batch: 50,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 50 / NS_PER_US,
		fn: () => cloneBody(bodyTemplates["gpt-5.1"]),
	});

	for (const [label, tpl] of Object.entries(bodyTemplates)) {
		await benchAsync({
			name: `transform ${label}`,
			unit: "µs",
			batch: 30,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 30 / NS_PER_US,
			fn: async () => {
				const body = cloneBody(tpl);
				await transformRequestBody(body, INSTRUCTIONS, userConfig);
			},
		});
	}

	// Full request-path for lite models: transform + shapeBodyForModel.
	for (const label of ["gpt-5.6-sol", "gpt-6-astra"]) {
		const tpl = bodyTemplates[label];
		await benchAsync({
			name: `transform+shapeBodyForModel ${label}`,
			unit: "µs",
			batch: 30,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 30 / NS_PER_US,
			fn: async () => {
				const body = cloneBody(tpl);
				const out = await transformRequestBody(body, INSTRUCTIONS, userConfig);
				shapeBodyForModel(out);
			},
		});
	}

	// Minimal body — no tools, 2 input items. Approximates what a "38µs"
	// baseline most plausibly measured (fixture size dominates this bench).
	const minimalBody = { model: "gpt-5-codex", input: [msg("user", "hi")], reasoning: { effort: "medium" } };
	await benchAsync({
		name: "transform minimal body (no tools)",
		unit: "µs",
		batch: 100,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 100 / NS_PER_US,
		fn: async () => {
			await transformRequestBody(cloneBody(minimalBody), INSTRUCTIONS, userConfig);
		},
	});

	// The real entry point — transformRequestForCodex — covering parse,
	// native vs legacy modes, lite shaping, and re-serialization.
	section("transformRequestForCodex end-to-end (parse + transform + serialize)");
	const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
	for (const mode of ["legacy", "native"]) {
		for (const label of ["gpt-5-codex", "gpt-5.6-sol", "gpt-6-astra"]) {
			const bodyText = JSON.stringify(bodyTemplates[label]);
			await benchAsync({
				name: `transformRequestForCodex ${mode} ${label}`,
				unit: "µs",
				batch: 30,
				samples: 24,
				runs: 3,
				convert: (dt) => dt / 30 / NS_PER_US,
				fn: async () => {
					await transformRequestForCodex(
						{ method: "POST", body: bodyText },
						CODEX_URL,
						userConfig,
						true,
						undefined,
						{ requestTransformMode: mode },
					);
				},
			});
		}
	}

	// Decomposition: the pieces on the hot path.
	section("transform hot-path decomposition");
	const inputFixture = makeInput();
	await benchSync({
		name: "filterInput (34 items)",
		unit: "µs",
		batch: 500,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 500 / NS_PER_US,
		fn: () => filterInput(inputFixture),
	});
	await benchSync({
		name: "cleanupToolDefinitions (24 tools)",
		unit: "µs",
		batch: 100,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 100 / NS_PER_US,
		fn: () => cleanupToolDefinitions(TOOLS),
	});
	const oneTool = TOOLS[5];
	await benchSync({
		name: "JSON deep-clone 1 tool (tool-utils path)",
		unit: "µs",
		batch: 500,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 500 / NS_PER_US,
		fn: () => JSON.parse(JSON.stringify(oneTool)),
	});
	await benchSync({
		name: "structuredClone 1 tool (alternative)",
		unit: "µs",
		batch: 500,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 500 / NS_PER_US,
		fn: () => structuredClone(oneTool),
	});
	await benchSync({
		name: "normalizeModel(gpt-5-codex)",
		unit: "ns",
		batch: 5000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 5000,
		fn: () => normalizeModel("openai/gpt-5-codex-low"),
	});
	await benchSync({
		name: "getModelConfig(gpt-5.6-sol)",
		unit: "ns",
		batch: 5000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 5000,
		fn: () => getModelConfig("gpt-5.6-sol", userConfig),
	});
	await benchSync({
		name: "shapeBodyForModel only (lite, 34 items + 24 tools)",
		unit: "µs",
		batch: 100,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 100 / NS_PER_US,
		setup: async () => {
			const body = cloneBody(bodyTemplates["gpt-5.6-sol"]);
			return await transformRequestBody(body, INSTRUCTIONS, userConfig);
		},
		fn: (_i, transformed) => shapeBodyForModel(transformed),
	});
}

// ===========================================================================
// 3. SSE parse throughput
// ===========================================================================

if (want("sse")) {
	section(`convertSseToJson on ${(SSE_BYTES / 1e6).toFixed(1)} MB stream`);

	const origParse = JSON.parse;
	// Full-stream runs: 64KB chunks. The 1B case is run on a 512KB slice:
	// every decoded chunk is retained in textParts[] (and the pendingText
	// rope), so a 9.8MB stream at 1B/chunk allocates ~4GB of tiny objects and
	// OOMs the default heap — itself a finding, not something to bench through.
	const smallSseBuf = sseBuf.subarray(0, 512 * 1024);
	for (const [chunk, buf] of [[64 * 1024, sseBuf], [1, smallSseBuf]]) {
		const runs = chunk === 1 ? 3 : 6;
		const samples = [];
		let parseCount = 0;
		// One untimed warmup stream per chunk size — the first parse of a 10MB
		// stream is still inside JIT warmup and drags p50/cv badly otherwise.
		await convertSseToJson(
			new Response(chunkStream(buf, chunk)),
			new Headers(),
		);
		for (let r = 0; r < runs; r++) {
			JSON.parse = (...a) => { parseCount++; return origParse(...a); };
			const res = new Response(chunkStream(buf, chunk));
			const t0 = performance.now();
			await convertSseToJson(res, new Headers());
			const dt = performance.now() - t0;
			JSON.parse = origParse;
			samples.push(buf.byteLength / (dt / 1000) / 1e6); // MB/s
		}
		const label =
			chunk >= 1024
				? `SSE ${(buf.byteLength / 1e6).toFixed(0)}MB @ ${chunk / 1024}KB chunks`
				: `SSE ${(buf.byteLength / 1024).toFixed(0)}KB @ 1B chunks`;
		report(label, "MB/s", summarize(samples), summarize(samples));
		results.push({ name: `SSE JSON.parse calls @${chunk}B`, unit: "count", mean: parseCount / runs });
		const dataLineCount = sseText.split("\n").filter((l) => l.startsWith("data:")).length;
		const parsesPerStream = parseCount / runs;
		const verdict = parsesPerStream < dataLineCount * 0.05
			? "marker gate WORKS (parses ≪ data lines)"
			: "marker gate INEFFECTIVE (parsing most lines)";
		console.log(
			`   JSON.parse invocations: ${parsesPerStream} per stream ` +
				`(${dataLineCount} data lines in the full fixture) — ${verdict}`,
		);
	}
}

// ===========================================================================
// 3b. Carry-buffer scaling on newline-free streams (drainLines O(n^2) check)
// ===========================================================================
//
// drainLines() re-scans `pendingText` from offset 0 on every chunk. With
// newlines present the scan stops at the first line boundary, so total work
// is linear in stream size. A stream with NO newline keeps the entire decoded
// prefix in pendingText, so every drain is O(pendingText) and total work is
// O(n^2 / chunkSize). A real-world trigger: non-SSE bodies (plain JSON error
// pages) are routed through convertSseToJson unconditionally, and compact
// JSON has no newlines.
//
// Fixed chunk size with doubling payload should show ~4x time growth if
// quadratic; fixed payload with 4x smaller chunks should show ~4x time.

if (want("carry") || want("drain") || want("nonewline") || want("quadratic")) {
	section("carry-buffer scan on newline-free streams (drainLines O(n^2) check)");

	// Single-line JSON, no SSE framing -> processLine sees no `data:` prefix,
	// sawSseLine stays false, body passes through. Under the 10MiB cap.
	const noNlBytes = (n) =>
		new TextEncoder().encode(`{"error":{"message":"${"x".repeat(n)}"}}`);

	const timeOnce = async (buf, chunk) => {
		const t0 = performance.now();
		await convertSseToJson(new Response(chunkStream(buf, chunk)), new Headers());
		return performance.now() - t0;
	};

	// Payload scaling at fixed 64KB chunks: 2/4/8MB (quadratic => 1x/4x/16x).
	for (const mb of [2, 4, 8]) {
		const buf = noNlBytes(mb * 1024 * 1024);
		const samples = [];
		for (let r = 0; r < 3; r++) samples.push(await timeOnce(buf, 64 * 1024));
		report(`newline-free ${mb}MB @ 64KB chunks`, "ms", summarize(samples), summarize(samples));
	}

	// Chunk scaling at fixed 8MB: 64/16/4KB (quadratic => ~4x per 4x shrink).
	{
		const buf = noNlBytes(8 * 1024 * 1024);
		for (const cs of [64 * 1024, 16 * 1024, 4 * 1024]) {
			const samples = [];
			for (let r = 0; r < 3; r++) samples.push(await timeOnce(buf, cs));
			report(`newline-free 8MB @ ${cs / 1024}KB chunks`, "ms", summarize(samples), summarize(samples));
		}
	}

	// Control: same byte volume WITH newlines every ~430B — carry stays small.
	{
		const lineText = `${"x".repeat(430)}\n`;
		const nlBuf = new TextEncoder().encode(lineText.repeat(Math.ceil((8 * 1024 * 1024) / lineText.length)));
		const samples = [];
		for (let r = 0; r < 3; r++) samples.push(await timeOnce(nlBuf, 64 * 1024));
		report("newline-rich 8MB @ 64KB chunks (control)", "ms", summarize(samples), summarize(samples));
	}
}

// ===========================================================================
// 4. Account selection / rotation at pool sizes
// ===========================================================================

if (want("rotation") || want("account")) {
	section("account selection / rotation vs pool size");

	const POOLS = [1, 10, 50, 200];
	const managers = {};
	for (const n of POOLS) {
		const stored = n === 200 ? storage200 : makeAccountsStorage(n);
		managers[n] = new AccountManager(undefined, stored);
	}

	// AccountManager construction cost itself
	for (const n of [50, 200]) {
		const stored = makeAccountsStorage(n);
		await benchSync({
			name: `new AccountManager from storage (${n} accts)`,
			unit: "µs",
			batch: 50,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 50 / NS_PER_US,
			fn: () => new AccountManager(undefined, stored),
		});
	}

	for (const n of POOLS) {
		resetTrackers();
		const m = managers[n];
		for (const strategy of ["hybrid", "round-robin", "sticky"]) {
			await benchSync({
				name: `getAccountForStrategy(${strategy}) pool=${n}`,
				unit: "µs",
				batch: 2000,
				samples: 24,
				runs: 3,
				convert: (dt) => dt / 2000 / NS_PER_US,
				fn: () => m.getAccountForStrategy(strategy, "codex"),
			});
		}
		// Hybrid full scan: a static excluded set converges to the current-account
		// fast path after one selection (the winner becomes the family cursor).
		// Track the cursor and exclude it every call so each op really scans.
		// lastPicked seeds from the fixture's initial codex cursor (index 0) and
		// is NOT reset between runs — it must always equal the live cursor.
		let lastPicked = 0;
		// Prime lastPicked to the live cursor left by the strategy loop above:
		// one untracked call with nothing excluded returns the cursor's account.
		lastPicked = m.getAccountForStrategy("hybrid", "codex")?.index ?? 0;
		await benchSync({
			name: `hybrid forced-scan (cursor excluded) pool=${n}`,
			unit: "µs",
			batch: 500,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 500 / NS_PER_US,
			fn: () => {
				const r = m.getAccountForStrategy(
					"hybrid",
					"codex",
					null,
					undefined,
					undefined,
					"preferred",
					new Set([lastPicked]),
				);
				if (r) lastPicked = r.index;
			},
		});
	}

	// Raw selectHybridAccount on synthetic metrics (pure scoring loop).
	section("selectHybridAccount (raw scoring loop)");
	for (const n of POOLS) {
		const h = new HealthScoreTracker();
		const t = new TokenBucketTracker();
		const metrics = Array.from({ length: n }, (_, i) => ({
			index: i,
			isAvailable: true,
			lastUsed: Date.now() - i * 60_000,
		}));
		await benchSync({
			name: `selectHybridAccount pool=${n}`,
			unit: "ns",
			batch: 5000,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 5000,
			fn: () => selectHybridAccount(metrics, h, t, "codex"),
		});
	}
}

// ===========================================================================
// 5. loadAccounts / parse+normalize on 200-account file
// ===========================================================================

if (want("storage") || want("load") || want("normalize")) {
	section("loadAccounts + parse/normalize (200-account V3 file)");
	setStoragePathDirect(ACCOUNTS_FILE);

	await benchAsync({
		name: "loadAccounts (200 accts, full pipeline)",
		unit: "ms",
		batch: 1,
		samples: 40,
		runs: 3,
		convert: (dt) => dt / NS_PER_MS,
		fn: () => loadAccounts(),
	});
	await benchSync({
		name: "fs.readFileSync 200-acct file",
		unit: "µs",
		batch: 100,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 100 / NS_PER_US,
		fn: () => readFileSync(ACCOUNTS_FILE, "utf-8"),
	});
	await benchSync({
		name: `JSON.parse ${(accountsFileText.length / 1024).toFixed(0)}KB accounts`,
		unit: "µs",
		batch: 50,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 50 / NS_PER_US,
		fn: () => JSON.parse(accountsFileText),
	});
	await benchSync({
		name: "normalizeAccountStorage (200 accts)",
		unit: "µs",
		batch: 50,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 50 / NS_PER_US,
		fn: () => normalizeAccountStorage(accountsFileParsed, ACCOUNTS_FILE),
	});

	// Mutation check: does normalize mutate its input?
	const before = JSON.stringify(accountsFileParsed);
	normalizeAccountStorage(accountsFileParsed, ACCOUNTS_FILE);
	const mutated = JSON.stringify(accountsFileParsed) !== before;
	results.push({ name: "normalizeAccountStorage mutates input", unit: "bool", mean: mutated ? 1 : 0 });
	if (mutated) console.log("   NOTE: normalizeAccountStorage mutates its input object");
}

// ===========================================================================
// 6. Config stat-gate: hit vs miss
// ===========================================================================

if (want("config") || want("stat")) {
	section("loadPluginConfig stat-gate: hit vs same-content vs re-parse");
	resetPluginConfigCache();
	writeFileSync(CONFIG_FILE, configA);
	loadPluginConfig(); // prime

	// Bare-syscall references: a stat-gated HIT should cost ~1 statSync.
	await benchSync({
		name: "fs.statSync config (reference)",
		unit: "ns",
		batch: 5000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 5000,
		fn: () => statSync(CONFIG_FILE),
	});
	await benchSync({
		name: "fs.readFileSync config (reference)",
		unit: "ns",
		batch: 5000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 5000,
		fn: () => readFileSync(CONFIG_FILE, "utf-8"),
	});
	await benchSync({
		name: "loadPluginConfig HIT (stat only)",
		unit: "ns",
		batch: 5000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 5000,
		fn: () => loadPluginConfig(),
	});
	await benchSync({
		name: "fs.writeFileSync config (reference)",
		unit: "µs",
		batch: 200,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 200 / NS_PER_US,
		fn: () => writeFileSync(CONFIG_FILE, configA),
	});
	await benchSync({
		name: "loadPluginConfig stat-miss/content-hit",
		unit: "µs",
		batch: 20,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 20 / NS_PER_US,
		fn: (i) => {
			writeFileSync(CONFIG_FILE, configA); // new stat signature, same bytes
			loadPluginConfig();
		},
	});
	await benchSync({
		name: "loadPluginConfig MISS (read+parse+validate)",
		unit: "µs",
		batch: 20,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 20 / NS_PER_US,
		fn: (i) => {
			writeFileSync(CONFIG_FILE, i % 2 ? configA : configB);
			loadPluginConfig();
		},
	});
	writeFileSync(CONFIG_FILE, configA);
}

// ===========================================================================
// 7. Keychain-on path (mock backend)
// ===========================================================================

if (want("keychain")) {
	section("keychain opt-in path (mock backend)");
	setStoragePathDirect(ACCOUNTS_FILE);
	const blob = JSON.stringify(storage200);

	await benchAsync({
		name: "loadAccounts JSON (CODEX_KEYCHAIN unset)",
		unit: "ms",
		batch: 1,
		samples: 30,
		runs: 3,
		convert: (dt) => dt / NS_PER_MS,
		setup: async () => {
			delete process.env.CODEX_KEYCHAIN;
		},
		fn: () => loadAccounts(),
	});

	keychain._setBackendForTests({
		get: () => Promise.resolve(blob),
		set: () => Promise.resolve(),
		delete: () => Promise.resolve(true),
		isAvailable: () => Promise.resolve(true),
	});
	process.env.CODEX_KEYCHAIN = "1";

	await benchSync({
		name: "isKeychainOptInEnabled (branch check)",
		unit: "ns",
		batch: 20000,
		samples: 20,
		runs: 3,
		convert: (dt) => dt / 20000,
		fn: () => keychain.isKeychainOptInEnabled(),
	});
	await benchAsync({
		name: "readFromKeychain (mock get->blob)",
		unit: "µs",
		batch: 100,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 100 / NS_PER_US,
		fn: () => keychain.readFromKeychain(null),
	});
	await benchAsync({
		name: "loadAccounts keychain-HIT (200 accts)",
		unit: "ms",
		batch: 1,
		samples: 30,
		runs: 3,
		convert: (dt) => dt / NS_PER_MS,
		fn: () => loadAccounts(),
	});

	// Backend present but no entry -> JSON fallback.
	keychain._setBackendForTests({
		get: () => Promise.resolve(null),
		set: () => Promise.resolve(),
		delete: () => Promise.resolve(false),
		isAvailable: () => Promise.resolve(true),
	});
	await benchAsync({
		name: "loadAccounts keychain-MISS -> JSON fallback",
		unit: "ms",
		batch: 1,
		samples: 30,
		runs: 3,
		convert: (dt) => dt / NS_PER_MS,
		fn: () => loadAccounts(),
	});
	delete process.env.CODEX_KEYCHAIN;
}

// ===========================================================================
// 8. Retry-decision path under 429 storms + probe scoring
// ===========================================================================

if (want("retry") || want("429") || want("backoff")) {
	section("retry-decision under 429 storms");

	for (const keys of [10, 100, 500]) {
		clearRateLimitBackoffState();
		for (let i = 0; i < keys; i++) {
			getRateLimitBackoffWithReason(i, "codex", 30_000, "quota");
		}
		await benchSync({
			name: `getRateLimitBackoffWithReason dedup-storm (map=${keys})`,
			unit: "ns",
			batch: 2000,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 2000,
			fn: (i) =>
				getRateLimitBackoffWithReason(i % keys, "codex", 30_000, "quota"),
		});
	}

	// Fresh-key insert storm: every call adds a new map entry.
	clearRateLimitBackoffState();
	let keyCounter = 0;
	await benchSync({
		name: "getRateLimitBackoff fresh-key storm (map grows)",
		unit: "ns",
		batch: 1000,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 1000,
		setup: () => {
			clearRateLimitBackoffState();
			keyCounter = 0;
		},
		fn: () => {
			getRateLimitBackoffWithReason(keyCounter++, "codex", 30_000, "quota");
		},
	});

	const budget = new RetryBudgetTracker(resolveRetryBudgetLimits("balanced"));
	await benchSync({
		name: "RetryBudgetTracker.consumeWait",
		unit: "ns",
		batch: 10000,
		samples: 20,
		runs: 3,
		convert: (dt) => dt / 10000,
		fn: (i) => budget.consumeWait(i % 2 ? "network" : "rateLimitShort", 1200),
	});

	// All-blocked pool wait calculation.
	const blocked = makeAccountsStorage(200);
	const future = Date.now() + 60_000;
	for (const a of blocked.accounts) {
		a.rateLimitResetTimes = { codex: future, "gpt-5.6-sol": future + 5000 };
		a.coolingDownUntil = future + 10_000;
	}
	const blockedManager = new AccountManager(undefined, blocked);
	await benchSync({
		name: "getMinWaitTimeForFamily (200 blocked accts)",
		unit: "µs",
		batch: 200,
		samples: 24,
		runs: 3,
		convert: (dt) => dt / 200 / NS_PER_US,
		fn: () => blockedManager.getMinWaitTimeForFamily("codex"),
	});
}

if (want("probe")) {
	section("parallel-probe candidate scoring");
	for (const n of [10, 50, 200]) {
		const stored = n === 200 ? storage200 : makeAccountsStorage(n);
		const m = new AccountManager(undefined, stored);
		await benchSync({
			name: `getTopCandidates pool=${n}`,
			unit: "µs",
			batch: 500,
			samples: 24,
			runs: 3,
			convert: (dt) => dt / 500 / NS_PER_US,
			fn: () => getTopCandidates(m, "codex", null, 2),
		});
	}
}

// ===========================================================================
// 9. TUI status render
// ===========================================================================

if (want("tui") || want("status")) {
	section("measureStatusSlot + status render vs width");

	const leaf = {};
	const mid = { parent: undefined };
	leaf.parent = mid;
	const makeRow = (width) => ({
		primaryAxis: "row",
		width,
		getChildren: () => [mid, { other: true }],
	});
	for (const width of [20, 40, 80, 200]) {
		mid.parent = makeRow(width);
		await benchSync({
			name: `measureStatusSlot row.width=${width}`,
			unit: "ns",
			batch: 10000,
			samples: 20,
			runs: 3,
			convert: (dt) => dt / 10000,
			fn: () => measureStatusSlot(leaf),
		});
	}

	const readyQuota = {
		type: "ready",
		limits: [
			{ label: "5h", leftPercent: 63, windowMinutes: 300, resetAtMs: Date.now() + 7.2e6 },
			{ label: "weekly", leftPercent: 12, windowMinutes: 10080, resetAtMs: Date.now() + 3.6e6 },
		],
		stale: false,
		fetchedAt: Date.now(),
		accountIndex: 2,
		accountCount: 5,
		accountEmail: "user2@example.com",
		planType: "plus",
	};
	for (const width of [20, 40, 80, 200]) {
		await benchSync({
			name: `formatPromptStatusText width=${width}`,
			unit: "µs",
			batch: 2000,
			samples: 20,
			runs: 3,
			convert: (dt) => dt / 2000 / NS_PER_US,
			fn: () =>
				formatPromptStatusText({
					variant: "high",
					quota: readyQuota,
					width,
					maskEmail: false,
				}),
		});
	}

	const overviewAccounts = (n) =>
		Array.from({ length: n }, (_, i) => ({
			index: i + 1,
			label: `acct${i}`,
			email: `user${i}@example.com`,
			planType: i % 3 ? "plus" : "pro",
			windows: [
				{ leftPercent: (i * 7) % 100, resetAtMs: Date.now() + i * 3.6e6 },
				{ leftPercent: (i * 13) % 100, resetAtMs: Date.now() + i * 8.64e7 },
			],
			resetCredits: i % 11 === 0 ? 1 : 0,
		}));
	const overviewOpts = {
		mode: "free",
		layout: "accounts",
		names: "number",
		order: "number",
		multipliers: false,
		allotment: false,
		resetTimes: "low",
		resetCredits: true,
		recovery: false,
		maskEmail: false,
		now: Date.now(),
	};
	for (const n of [10, 50, 200]) {
		for (const width of [80, 200]) {
			const accts = overviewAccounts(n);
			await benchSync({
				name: `formatQuotaOverviewStatusLines pool=${n} width=${width}`,
				unit: "µs",
				batch: 500,
				samples: 20,
				runs: 3,
				convert: (dt) => dt / 500 / NS_PER_US,
				fn: () =>
					formatQuotaOverviewStatusLines({
						accounts: accts,
						options: overviewOpts,
						width,
						maxRows: 1,
					}),
			});
		}
	}
}

// ===========================================================================
// 10. Hot-path allocation probing
// ===========================================================================
//
// heapUsed delta across a batch with no mid-batch GC (GC-dirty batches are
// discarded via a buffered 'gc' PerformanceObserver). --expose-gc improves
// cleanliness but is optional.

if (want("alloc")) {
	section("allocation per op (heapUsed delta, GC-clean batches only)");

	// There is no cumulative-allocated-bytes counter in v8.getHeapStatistics
	// on this Node, so measure heapUsed growth across a batch with no GC in
	// the middle: op garbage is still resident, so the delta approximates
	// true per-op allocation. Batches where a GC ran are discarded — the
	// delta would undercount by whatever was collected.
	const gcObserver = new PerformanceObserver(() => {});
	gcObserver.observe({ entryTypes: ["gc"], buffered: true });

	const allocBench = async (name, op, { batch = 20, reps = 12 } = {}) => {
		// One untimed warmup batch so JIT/allocation stability reflects steady state.
		for (let i = 0; i < batch; i++) await op(i);
		const samples = [];
		let gcBatches = 0;
		for (let r = 0; r < reps; r++) {
			globalThis.gc?.();
			globalThis.gc?.();
			gcObserver.takeRecords(); // drain
			const h0 = process.memoryUsage().heapUsed;
			for (let i = 0; i < batch; i++) await op(r * batch + i);
			const h1 = process.memoryUsage().heapUsed;
			const gcEntries = gcObserver.takeRecords();
			if (gcEntries.length > 0) {
				gcBatches++;
				continue;
			}
			samples.push(Math.max(0, (h1 - h0) / batch));
		}
		const s = samples.sort((a, b) => a - b);
		const med = s.length ? s[Math.floor(s.length / 2)] : NaN;
		const note = gcBatches ? ` (${gcBatches}/${reps} batches had GC)` : "";
		results.push({ name: `alloc ${name}`, unit: "B/op", mean: med, p50: med });
		console.log(
			`alloc ${name.padEnd(50)} ${Number.isFinite(med) ? med.toFixed(0).padStart(10) : "n/a".padStart(10)} B/op${note}`,
		);
	};

	const userConfig = { global: {}, models: {} };
	const tplNative = makeBody("gpt-5-codex");
	const tplLite = makeBody("gpt-5.6-sol");
	await transformRequestBody(cloneBody(tplNative), INSTRUCTIONS, userConfig); // warm prompt cache
	const transformedLite = await transformRequestBody(cloneBody(tplLite), INSTRUCTIONS, userConfig);
	const inputFixture = makeInput();

	await allocBench("cloneBody fixture (reference)", () => cloneBody(tplNative), { batch: 10 });
	await allocBench("transformRequestBody gpt-5-codex", async () => {
		await transformRequestBody(cloneBody(tplNative), INSTRUCTIONS, userConfig);
	}, { batch: 10 });
	await allocBench("transformRequestBody gpt-5.6-sol (lite)", async () => {
		await transformRequestBody(cloneBody(tplLite), INSTRUCTIONS, userConfig);
	}, { batch: 10 });
	await allocBench("shapeBodyForModel (lite, clones internally)", () => {
		shapeBodyForModel(transformedLite);
	}, { batch: 10 });
	await allocBench("filterInput (34 items)", () => filterInput(inputFixture), { batch: 50 });
	await allocBench("cleanupToolDefinitions (24 tools)", () => cleanupToolDefinitions(TOOLS), { batch: 30 });

	// Storage / normalize
	setStoragePathDirect(ACCOUNTS_FILE);
	await allocBench("normalizeAccountStorage (200 accts)", () =>
		normalizeAccountStorage(cloneBody(accountsFileParsed), ACCOUNTS_FILE), { batch: 5 });
	await allocBench("loadAccounts (200 accts, e2e)", () => loadAccounts(), { batch: 3, reps: 7 });
	await allocBench("JSON.parse accounts file", () => JSON.parse(accountsFileText), { batch: 10 });

	// Config
	writeFileSync(CONFIG_FILE, configA);
	resetPluginConfigCache();
	loadPluginConfig();
	await allocBench("loadPluginConfig HIT", () => loadPluginConfig(), { batch: 500 });

	// Rotation / probe
	{
		const m200 = new AccountManager(undefined, makeAccountsStorage(200));
		const h = new HealthScoreTracker();
		const t = new TokenBucketTracker();
		const metrics200 = Array.from({ length: 200 }, (_, i) => ({
			index: i, isAvailable: true, lastUsed: Date.now() - i * 60_000,
		}));
		await allocBench("new AccountManager (200 accts)", () =>
			new AccountManager(undefined, makeAccountsStorage(200)), { batch: 10 });
		await allocBench("getAccountForStrategy(hybrid) pool=200", () =>
			m200.getAccountForStrategy("hybrid", "codex"), { batch: 200 });
		await allocBench("selectHybridAccount pool=200", () =>
			selectHybridAccount(metrics200, h, t, "codex"), { batch: 200 });
		await allocBench("getTopCandidates pool=200", () =>
			getTopCandidates(m200, "codex", null, 2), { batch: 50 });
		await allocBench("getRateLimitBackoffWithReason dedup", (i) =>
			getRateLimitBackoffWithReason(i % 200, "codex", 30_000, "quota"), { batch: 200 });
	}

	// TUI render
	const readyQuota = {
		type: "ready",
		limits: [
			{ label: "5h", leftPercent: 63, windowMinutes: 300, resetAtMs: Date.now() + 7.2e6 },
			{ label: "weekly", leftPercent: 12, windowMinutes: 10080, resetAtMs: Date.now() + 3.6e6 },
		],
		stale: false,
		fetchedAt: Date.now(),
		accountIndex: 2,
		accountCount: 5,
		accountEmail: "user2@example.com",
		planType: "plus",
	};
	await allocBench("formatPromptStatusText width=80", () =>
		formatPromptStatusText({ variant: "high", quota: readyQuota, width: 80, maskEmail: false }),
		{ batch: 200 });
	{
		const accts200 = Array.from({ length: 200 }, (_, i) => ({
			index: i + 1, label: `acct${i}`, email: `user${i}@example.com`,
			planType: i % 3 ? "plus" : "pro",
			windows: [
				{ leftPercent: (i * 7) % 100, resetAtMs: Date.now() + i * 3.6e6 },
				{ leftPercent: (i * 13) % 100, resetAtMs: Date.now() + i * 8.64e7 },
			],
			resetCredits: i % 11 === 0 ? 1 : 0,
		}));
		const opts = {
			mode: "free", layout: "accounts", names: "number", order: "number",
			multipliers: false, allotment: false, resetTimes: "low",
			resetCredits: true, recovery: false, maskEmail: false, now: Date.now(),
		};
		await allocBench("formatQuotaOverviewStatusLines pool=200 w=80", () =>
			formatQuotaOverviewStatusLines({ accounts: accts200, options: opts, width: 80, maxRows: 1 }),
			{ batch: 50 });
	}

	// SSE per-stream allocation on a small stream (512KB @64KB)
	{
		const small = sseBuf.subarray(0, 512 * 1024);
		await allocBench("convertSseToJson 512KB @64KB", async () => {
			await convertSseToJson(new Response(chunkStream(small, 64 * 1024)), new Headers());
		}, { batch: 3, reps: 7 });
	}
	writeFileSync(CONFIG_FILE, configA);
}

// ===========================================================================
// Baseline comparison
// ===========================================================================

// Fixture caveat (kept from the audit): the recorded "transform 38µs" did not
// publish its body shape. On this suite's realistic ~18KB body (24 tools, 34
// input items), transformRequestBody alone runs ~110µs (clone excluded); a
// minimal body is ~4µs. Treat ratios as "same-fixture tracking going
// forward", not a literal like-for-like regression verdict.
const BASELINES = JSON.parse(
	readFileSync(join(PERF_DIR, "perf-baselines.json"), "utf-8"),
);

section("baseline comparison (regression = >20% worse)");
for (const b of BASELINES) {
	const r = results.find((x) => x.name === b.match);
	if (!r) {
		console.log(`${b.label.padEnd(28)} ${b.match.padEnd(50)} — not run`);
		continue;
	}
	const current = r.p50;
	const ratio = current / b.baseline;
	// For throughput units a *lower* ratio is better; flip before the check.
	const effective = b.higherIsBetter ? 1 / ratio : ratio;
	const flag = effective > 1.2 ? "REGRESSION" : effective < 0.83 ? "improved" : "ok";
	console.log(
		`${b.label.padEnd(28)} ${b.match.padEnd(50)} ` +
			`base=${b.baseline}${b.unit} now=${fmt(current, b.unit)}${b.unit} ` +
			`x${ratio.toFixed(2)} ${flag}`,
	);
}

// ===========================================================================
// Machine-readable output
// ===========================================================================

const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.slice(7)
	?? (process.argv.includes("--json") ? join(PERF_DIR, "results.json") : null);
if (jsonOut) {
	const payload = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		worktree: REPO,
		sseBytes: SSE_BYTES,
		results,
		baselines: BASELINES,
	};
	writeFileSync(jsonOut, JSON.stringify(payload, null, 2));
	console.log(`\nwrote ${jsonOut}`);
}

console.log("\ndone.");
process.exit(0);
