/**
 * Constants for session recovery storage paths.
 *
 * Based on opencode-antigravity-auth recovery module.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Get the XDG data directory for OpenCode storage.
 *
 * OpenCode resolves its data root as `XDG_DATA_HOME || ~/.local/share` on
 * every platform — its `Global.Path.data` goes through the `xdg-basedir`
 * package unconditionally, with no win32 branch. Session data on Windows
 * therefore lives at `%USERPROFILE%\.local\share\opencode`, NOT under
 * `%APPDATA%`; an APPDATA branch here points recovery at a directory
 * OpenCode never writes, making it a silent no-op on Windows.
 */
function getXdgData(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export const OPENCODE_STORAGE = join(getXdgData(), "opencode", "storage");
export const MESSAGE_STORAGE = join(OPENCODE_STORAGE, "message");
export const PART_STORAGE = join(OPENCODE_STORAGE, "part");

export const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
export const META_TYPES = new Set(["step-start", "step-finish"]);
export const CONTENT_TYPES = new Set(["text", "tool", "tool_use", "tool_result"]);
