import * as fc from "fast-check";

/**
 * Shared fast-check configuration for the property suites. Registered as a
 * vitest `setupFiles` entry, so these globals apply to every `fc.assert` the
 * worker runs (including ad-hoc fast-check use outside test/property/).
 *
 * FC_SEED=<integer> pins the seed for the whole run so a CI failure can be
 * replayed locally (`FC_SEED=12345 npx vitest run test/property`). Unset or
 * empty means the default random-per-run behavior.
 */
const rawSeed = process.env.FC_SEED;
let seed: number | undefined;
if (rawSeed !== undefined && rawSeed !== "") {
	seed = Number(rawSeed);
	// A malformed value that silently fell back to random would read exactly
	// like a successful replay, so the misconfiguration is made loud.
	if (!Number.isInteger(seed)) {
		throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(rawSeed)}`);
	}
}

fc.configureGlobal({
	numRuns: 100,
	verbose: false,
	endOnFailure: true,
	skipAllAfterTimeLimit: 10000,
	...(seed === undefined ? {} : { seed }),
});
