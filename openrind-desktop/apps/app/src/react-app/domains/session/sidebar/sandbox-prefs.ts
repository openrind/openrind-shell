/**
 * Small localStorage-backed preferences for Openrind Shell sandboxes.
 *
 * Sandboxes are decoupled from workspaces: the sidebar section and the
 * /sandboxes manager both need to know which agent profile a sandbox was
 * created with (the sandbox's .bashrc launch block is profile-specific, and
 * the marker written before each connect is resolved differently per agent).
 * `openshell sandbox list` does not report the profile, so we persist it at
 * creation time and fall back to Claude — the default profile — for
 * sandboxes created before this key existed.
 */

import type { SandboxProfile } from "../../../../app/lib/desktop";

const PROFILE_KEY_PREFIX = "openrind-shell-profile:";
const DISPLAY_KEY_PREFIX = "openrind-shell-display:";

export function readSandboxProfile(sandboxName: string): SandboxProfile {
  try {
    const value = localStorage.getItem(PROFILE_KEY_PREFIX + sandboxName);
    if (value === "openrind-shell-openclaw") return "openrind-shell-openclaw";
    if (value === "openrind-shell-codex") return "openrind-shell-codex";
    if (value === "openrind-shell-openhands" || value === "openrind-shell-openhands-script") return value;
    if (value === "openrind-shell-claude") return "openrind-shell-claude";

    // Fallback: if sandboxName starts with "or-", scan localStorage keys for a match
    if (sandboxName.startsWith("or-")) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PROFILE_KEY_PREFIX)) {
          const storedName = key.slice(PROFILE_KEY_PREFIX.length);
          if (storedName.startsWith("openrind-shell-")) {
            const suffix = storedName.slice("openrind-shell-".length);
            const normalized = suffix.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/[_.]/g, "-");
            const prefix = `or-${normalized.slice(0, 7)}-`;
            if (sandboxName.startsWith(prefix) || sandboxName === suffix) {
              const val = localStorage.getItem(key);
              if (val === "openrind-shell-openhands" || val === "openrind-shell-openhands-script") return val;
              if (val === "openrind-shell-openclaw") return "openrind-shell-openclaw";
              if (val === "openrind-shell-codex") return "openrind-shell-codex";
            }
          }
        }
      }
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return "openrind-shell-claude";
}

export function writeSandboxProfile(
  sandboxName: string,
  profile: SandboxProfile,
): void {
  try {
    localStorage.setItem(PROFILE_KEY_PREFIX + sandboxName, profile);
  } catch {
    // Best-effort.
  }
}

/**
 * User-facing label for a sandbox. The Openrind Shell terminal's rename action
 * writes `openrind-shell-display:<sandboxName>`; fall back to the name without the
 * `openrind-shell-` prefix.
 */
export function sandboxDisplayName(sandboxName: string): string {
  try {
    const value = localStorage.getItem(DISPLAY_KEY_PREFIX + sandboxName);
    if (value && value.trim()) return value.trim();
  } catch {
    // Best-effort.
  }
  return sandboxName.replace(/^or-/, "");
}

/**
 * Persist (or clear, when empty) the user-facing label for a sandbox. Uses
 * the same key the Openrind Shell terminal's header rename writes, so both stay
 * in sync. Renames are cosmetic — the openshell sandbox name never changes
 * (it is the sandbox's identity for the Postgres-backed restore story).
 */
export function writeSandboxDisplayName(
  sandboxName: string,
  displayName: string,
): void {
  try {
    const trimmed = displayName.trim();
    if (trimmed) {
      localStorage.setItem(DISPLAY_KEY_PREFIX + sandboxName, trimmed);
    } else {
      localStorage.removeItem(DISPLAY_KEY_PREFIX + sandboxName);
    }
  } catch {
    // Best-effort.
  }
}
