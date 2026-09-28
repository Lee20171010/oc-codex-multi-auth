/**
 * Module-scoped storage state and the single shared mutex that serializes
 * every read-modify-write against the accounts files.
 *
 * Split out of `lib/storage.ts` in RC-2 so the identity helpers, normalize,
 * load/save, flagged, and export-import modules can all share the same
 * resolved path and the same lock without creating circular imports.
 *
 * Invariants this module preserves:
 *   - `currentStoragePath` is either `null` (use global fallback) or an
 *     absolute path to a project-scoped accounts file.
 *   - `currentProjectRoot` is only non-null when `currentStoragePath` is
 *     project-scoped; `setStoragePathDirect` deliberately clears it so
 *     ad-hoc overrides (tests, one-off CLI paths) never look like a real
 *     project.
 *   - `withStorageLock` chains every critical section through a single
 *     promise so nothing can interleave between a load and its paired save.
 */

import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ACCOUNTS_FILE_NAME, LEGACY_ACCOUNTS_FILE_NAME } from "../constants.js";
import {
  findProjectRoot,
  getConfigDir,
  getProjectConfigDir,
  getProjectGlobalConfigDir,
  getProjectStorageKey,
} from "./paths.js";

let storageMutex: Promise<void> = Promise.resolve();

/**
 * Serializes storage I/O to keep account file reads/writes lock-step and avoid
 * cross-request races during migration/seeding flows.
 */
export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousMutex = storageMutex;
  let releaseLock: () => void;
  storageMutex = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  return previousMutex.then(fn).finally(() => releaseLock());
}

/** Create an independent path/listener set for one V2 location or the V1 default. */
function newStorageState() {
  return {
    currentStoragePath: null as string | null,
    currentLegacyProjectStoragePath: null as string | null,
    currentProjectRoot: null as string | null,
    storagePathListeners: new Set<() => void>(),
  };
}
const defaultState = newStorageState();
const storageScope = new AsyncLocalStorage<ReturnType<typeof newStorageState>>();
/**
 * A pinned read-view of the storage location. While a transaction pin is
 * active, path getters resolve the location that existed when the pin was
 * taken, so a `setStoragePath` scope flip mid-transaction cannot redirect a
 * load or persist to a file the filesystem lease does not cover. Mutations
 * (setStoragePath/setStoragePathDirect) deliberately bypass the pin and land
 * on the real location state — the flip is deferred inside the transaction,
 * then takes effect the moment the pin drops rather than being silently
 * discarded.
 */
const pinnedScope = new AsyncLocalStorage<ReturnType<typeof newStorageState>>();
/** Read the active location's state, honoring a transaction pin first. */
const state = () => pinnedScope.getStore() ?? storageScope.getStore() ?? defaultState;
/** Read the location state mutations target — intentionally pin-blind. */
const mutableState = () => storageScope.getStore() ?? defaultState;

/** V2 hosts multiple locations in one process. Timers inherit their owner's scope. */
export function createStorageScope() {
  const scoped = newStorageState();
  return <T>(operation: () => T): T => storageScope.run(scoped, operation);
}

/**
 * Pin the current storage location for the duration of `operation`.
 *
 * Every path getter (`getStoragePath`, `getCurrentStoragePath`,
 * `getCurrentProjectRoot`, `getCurrentLegacyProjectStoragePath`,
 * `getCurrentProjectStorageKey`, and anything derived from them such as
 * `getFlaggedAccountsPath`) resolves the location captured at entry, so all
 * reads, writes, keychain keys, snapshot paths, and transaction leases inside
 * the operation agree on one concrete file. A `setStoragePath` call made
 * inside the pin still applies — but to the real scope, where it takes effect
 * only after the pin is released.
 */
export function withPinnedStorageScope<T>(operation: () => T): T {
  const current = state();
  const snapshot: ReturnType<typeof newStorageState> = {
    currentStoragePath: current.currentStoragePath,
    currentLegacyProjectStoragePath: current.currentLegacyProjectStoragePath,
    currentProjectRoot: current.currentProjectRoot,
    // The pin is a read-view: listener registration/notification always
    // targets the real scope, so this set is never populated.
    storagePathListeners: new Set<() => void>(),
  };
  return pinnedScope.run(snapshot, operation);
}

/** Listen only for path changes in the current storage scope. */
export function subscribeToStoragePathChanges(listener: () => void): () => void {
  const { storagePathListeners } = mutableState();
  storagePathListeners.add(listener);
  return () => { storagePathListeners.delete(listener); };
}

/** Notify listeners belonging to the current location, not other V2 sessions. */
function notifyStoragePathChanged(): void {
  for (const listener of mutableState().storagePathListeners) listener();
}

/** Select project-scoped account files, or clear the selection for global storage. */
export function setStoragePath(projectPath: string | null): void {
  const current = mutableState();
  if (!projectPath) {
    current.currentStoragePath = null;
    current.currentLegacyProjectStoragePath = null;
    current.currentProjectRoot = null;
    notifyStoragePathChanged();
    return;
  }

  const projectRoot = findProjectRoot(projectPath);
  if (projectRoot) {
    current.currentProjectRoot = projectRoot;
    current.currentStoragePath = join(getProjectGlobalConfigDir(projectRoot), ACCOUNTS_FILE_NAME);
    current.currentLegacyProjectStoragePath = join(getProjectConfigDir(projectRoot), LEGACY_ACCOUNTS_FILE_NAME);
  } else {
    current.currentStoragePath = null;
    current.currentLegacyProjectStoragePath = null;
    current.currentProjectRoot = null;
  }
  notifyStoragePathChanged();
}

/** Override the active file without assigning a project identity (e.g. CLI/tests). */
export function setStoragePathDirect(path: string | null): void {
  const current = mutableState();
  current.currentStoragePath = path;
  current.currentLegacyProjectStoragePath = null;
  current.currentProjectRoot = null;
  notifyStoragePathChanged();
}

/**
 * Returns the file path for the account storage JSON file.
 * @returns Absolute path to the accounts.json file
 */
export function getStoragePath(): string {
  const { currentStoragePath } = state();
  if (currentStoragePath) {
    return currentStoragePath;
  }
  return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

// Internal accessors used by sibling storage modules. Not re-exported from the
// top-level barrel: callers outside `lib/storage/` should use the public
// `setStoragePath` / `getStoragePath` APIs.

/** Return the current location's explicit accounts path, if one is selected. */
export function getCurrentStoragePath(): string | null {
  return state().currentStoragePath;
}

/** Return the legacy project file path used for seeding, if configured. */
export function getCurrentLegacyProjectStoragePath(): string | null {
  return state().currentLegacyProjectStoragePath;
}

/** Return the resolved project root for the active storage location. */
export function getCurrentProjectRoot(): string | null {
  return state().currentProjectRoot;
}

/**
 * Returns the project storage key (e.g. `my-project-abc123def456`) that the
 * active project storage path is rooted under, or `null` when no per-project
 * root is active (global storage is in use). Used by the opt-in keychain
 * backend as the account identifier so each project's credentials live
 * under a distinct (service, account) pair in the OS keychain.
 *
 * When `setStoragePathDirect` overrode the path to something outside the
 * standard per-project layout (tests, custom CLI override), we fall back to
 * `null` because there is no meaningful project identity to key off.
 */
export function getCurrentProjectStorageKey(): string | null {
  const { currentProjectRoot } = state();
  if (!currentProjectRoot) return null;
  return getProjectStorageKey(currentProjectRoot);
}
