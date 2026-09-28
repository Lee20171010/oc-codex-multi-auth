/**
 * Path resolution utilities for account storage.
 * Extracted from storage.ts to reduce module size.
 */

import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { StorageError } from "../errors.js";

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".opencode"];
const PROJECTS_DIR = "projects";
const PROJECT_KEY_HASH_LENGTH = 12;

export function getConfigDir(): string {
	return join(homedir(), ".opencode");
}

export function getProjectConfigDir(projectPath: string): string {
	return join(projectPath, ".opencode");
}

function normalizeProjectPath(projectPath: string): string {
	const resolvedPath = resolve(projectPath);
	const normalizedSeparators = resolvedPath.replace(/\\/g, "/");
	return process.platform === "win32"
		? normalizedSeparators.toLowerCase()
		: normalizedSeparators;
}

function sanitizeProjectName(projectPath: string): string {
	const name = basename(projectPath);
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "project";
}

export function getProjectStorageKey(projectPath: string): string {
	const normalizedPath = normalizeProjectPath(projectPath);
	const hash = createHash("sha256")
		.update(normalizedPath)
		.digest("hex")
		.slice(0, PROJECT_KEY_HASH_LENGTH);
	const projectName = sanitizeProjectName(normalizedPath).slice(0, 40);
	return `${projectName}-${hash}`;
}

/**
 * Per-project storage is namespaced under ~/.opencode/projects
 * to avoid writing account files into user repositories.
 */
export function getProjectGlobalConfigDir(projectPath: string): string {
	return join(getConfigDir(), PROJECTS_DIR, getProjectStorageKey(projectPath));
}

export function isProjectDirectory(dir: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

export function findProjectRoot(startDir: string): string | null {
	let current = startDir;
	const root = dirname(current) === current ? current : null;
	
	while (current) {
		if (isProjectDirectory(current)) {
			return current;
		}
		
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	
	return root && isProjectDirectory(root) ? root : null;
}

function normalizePathForComparison(filePath: string): string {
	const resolvedPath = resolve(filePath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function isWithinDirectory(baseDir: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const rel = relative(normalizedBase, normalizedTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolvePath(filePath: string): string {
	let resolved: string;
	if (filePath.startsWith("~")) {
		resolved = join(homedir(), filePath.slice(1));
	} else {
		resolved = resolve(filePath);
	}

	// Collapse symlinks for the containment check so a symlink inside an
	// allowed root cannot smuggle a read or write outside it (e.g. a link
	// under ~/ pointing at /etc, or a symlinked storage directory). Best
	// effort: realpath fails when the target does not exist yet — which is
	// every export-to-new-file case — so walk up to the nearest existing
	// ancestor and realpath THAT, re-appending the missing tail lexically.
	// Resolving only the immediate parent is not enough: `~/link -> /etc`
	// plus a target of `~/link/newdir/out.json` fails both realpath calls
	// while `~/link` already resolves outside every allowed root. The caller
	// keeps the lexical path: `canonical` is only the authority on WHERE the
	// bytes would land, which is what the root check must govern.
	let canonical = resolved;
	try {
		canonical = realpathSync(resolved);
	} catch {
		const missingTail: string[] = [basename(resolved)];
		let ancestor = dirname(resolved);
		while (true) {
			try {
				canonical = join(realpathSync(ancestor), ...missingTail);
				break;
			} catch {
				const parent = dirname(ancestor);
				if (parent === ancestor) break; // reached fs root — keep lexical
				missingTail.unshift(basename(ancestor));
				ancestor = parent;
			}
		}
	}

	// `canonical` is physical when any ancestor resolved, so the boundary
	// roots must be realpathed too — a symlinked HOME (/home -> /data/home,
	// macOS /tmp -> /private/tmp) would otherwise compare a real canonical
	// against a lexical root and reject valid exports. The lexical form is
	// kept as a second candidate for the case where canonical fell back to
	// the lexical path because no ancestor existed at all.
	const boundaries = [homedir(), process.cwd(), tmpdir()].flatMap((root) => {
		try {
			return [realpathSync(root), root];
		} catch {
			return [root];
		}
	});
	if (!boundaries.some((root) => isWithinDirectory(root, canonical))) {
		throw new StorageError(
			`Access denied: path must be within home directory, project directory, or temp directory`,
			"PATH_ACCESS_DENIED",
			canonical,
			"The requested path is outside the allowed roots (home, project, temp). Pick a path inside one of those directories.",
		);
	}

	return resolved;
}
