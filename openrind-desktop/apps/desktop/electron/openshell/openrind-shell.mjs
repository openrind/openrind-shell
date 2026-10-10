// Public desktop facade for the primary Openrind Shell FUSE runtime.
//
// Provisioning, initialization, PostgreSQL validation, and the Claude runtime
// belong to the supervisor-owned FUSE image. The desktop orchestrates only
// documented OpenShell operations. A one-shot marker is the sole desktop-only
// addition: it tells an interactive connect to launch the selected Claude
// session through the image-provided PTY bridge. Direct CLI connects remain
// ordinary shells as described in README.md.

import { createHash } from "node:crypto";

import {
  buildFuseCliCommand,
  buildFuseWslEnv,
  shellQuote,
} from "./fuse-runtime.mjs";
import { DISTRO_NAME, wslRun } from "./wsl.mjs";

export {
  createOpenrindShellSandbox,
  deleteWorkspaceFile,
  downloadWorkspaceFile,
  ensureOpenrindShellHaloop,
  listWorkspaceFiles,
  resolveOpenrindShellSandboxWorkspaceId,
  restoreOpenrindShellHaloopIncumbent,
  revokeOpenrindShellHaloopIntegration,
  revokeOpenrindShellHaloopForSandbox,
  rotateOpenrindShellHaloop,
  uploadWorkspaceFile,
} from "./fuse-sandbox.mjs";
export {
  deletePrimaryFuseSandbox as deleteOpenrindShellSandbox,
  listPrimaryFuseSandboxes as listSandboxes,
  probePrimaryFuseDatabase as probeDatabaseUrl,
} from "./fuse-management.mjs";
export {
  activateExistingHaloopRoute,
  buildHaloopAgentLifecycleEvent,
  getHaloopCaptureStatus,
  getHaloopDiagnosticRoute,
  exportHaloopTraces,
  exportHaloopEvalCases,
  exportHaloopHarborDataset,
  generateHaloopEvalCases,
  getHaloopAnalysisStatus,
  getHaloopRuntimeActiveRoute,
  getHaloopRuntimeStatus,
  loadHaloopAnalysisReport,
  loadHaloopEvalCases,
  recordHaloopApplicationSpans,
  resolveHaloopUpstreamApiKey,
  restartHaloopRuntime,
  restoreHaloopIncumbentRoute,
  revokeHaloopIntegration,
  revokeHaloopSandboxProfiles,
  rotateHaloopRuntime,
  startHaloopAnalysis,
  stopHaloopRuntime,
} from "./haloop-runtime.mjs";
export { shellQuote };

const FUSE_IMAGE = "openrind-shell-fuse:local";
const SESSION_MARKER_PATH = "/var/lib/openrind-shell/runtime/desktop-claude-launch";
const SESSION_HOOK_SENTINEL = "Openrind Desktop Claude interactive hook.";
const CLAUDE_SESSION_NAMESPACE = "6f9b1e2a-0c3d-4b7a-9e21-8a4c1d5f7b30";
const HALOOP_SESSION_ASSERTION_PATTERN =
  /^v1\.[0-9a-f]{32}\.[1-9][0-9]{9,15}\.[1-9][0-9]{9,15}\.[0-9a-f]{64}$/;

export function imageForProfile(profile) {
  if (!["openrind-shell-claude", "openrind-shell-openclaw", "openrind-shell-openhands", "openrind-shell-openhands-script"].includes(profile)) {
    throw new Error(
      `The primary FUSE runtime supports Claude, OpenClaw, and OpenHands profiles only; received ${JSON.stringify(profile)}.`,
    );
  }
  return process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE?.trim() || FUSE_IMAGE;
}

function assertSandboxName(name) {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name ?? "") || String(name).length > 19) {
    throw new Error(`Invalid OpenShell sandbox name: ${JSON.stringify(name)}`);
  }
}

function deriveClaudeSessionUuid(sessionId) {
  const namespace = Buffer.from(CLAUDE_SESSION_NAMESPACE.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(Buffer.from(sessionId, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Return the marker consumed by the desktop-only `.bashrc` hook. `auto` starts
 * a normal fresh Claude session; a UUID creates or resumes the matching Claude
 * transcript for a selected desktop session.
 */
export function resolveAgentSessionValue(profile, agentSessionId, haloopSessionAssertion) {
  if (!["openrind-shell-claude", "openrind-shell-openclaw", "openrind-shell-openhands", "openrind-shell-openhands-script"].includes(profile)) {
    throw new Error("The primary FUSE runtime supports Claude, OpenClaw, and OpenHands profiles only.");
  }
  const sessionId = String(agentSessionId ?? "").trim();
  const value = sessionId ? deriveClaudeSessionUuid(sessionId) : "auto";
  const assertion = String(haloopSessionAssertion ?? "").trim();
  if (!HALOOP_SESSION_ASSERTION_PATTERN.test(assertion)) {
    throw new Error("A signed Haloop conversation context is required for agent launch.");
  }
  return `${profile}:${value}:${assertion}`;
}

function markerCommand(name, script) {
  assertSandboxName(name);
  return buildFuseCliCommand([
    "sandbox",
    "exec",
    "-n",
    name,
    "--",
    "sh",
    "-c",
    script,
  ]);
}

async function runMarkerScript(name, script, timeoutMs, stdin) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const result = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-lc",
      `timeout ${timeoutSeconds} ${markerCommand(name, script)}`,
    ],
    { env: buildFuseWslEnv(), timeout: timeoutMs + 5_000, stdin },
  );
  return result;
}

function markerError(action, result) {
  const detail = String(result?.stderr || result?.stdout || "").trim();
  return new Error(
    `OpenShell desktop Claude ${action} failed (exit ${result?.exitCode ?? "unknown"}): ${detail || "(no output)"}`,
  );
}

/** Write the one-shot marker immediately before a new desktop connect. */
export async function writeCurrentSessionMarker(name, value, browserGrant) {
  const marker = String(value ?? "").trim();
  if (
    marker &&
    !new RegExp(
      `^(?:openrind-shell-claude|openrind-shell-openclaw|openrind-shell-openhands|openrind-shell-openhands-script):(?:auto|[0-9a-f]{8}-[0-9a-f-]{27}):${HALOOP_SESSION_ASSERTION_PATTERN.source.slice(1, -1)}$`,
    ).test(marker)
  ) {
    throw new Error("Invalid desktop Claude session marker.");
  }
  if (browserGrant !== undefined && (!marker.startsWith('openrind-shell-claude:') ||
      typeof browserGrant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(browserGrant))) {
    throw new Error('Invalid browser launch grant.');
  }
  // Repair the interactive hook in the same exec that writes the marker. This
  // keeps already-created sandboxes compatible when their setup predates the
  // dedicated hook sentinel, without adding another launch-time round trip.
  const interactiveHook = [
    `# ${SESSION_HOOK_SENTINEL}`,
    `if [ -f ${SESSION_MARKER_PATH} ]; then`,
    `  exec /usr/local/bin/openrind-desktop-claude-launch`,
    `fi`,
  ].join("\n");
  const repairHook = [
    `touch /sandbox/.bashrc`,
    `if ! grep -Fq ${shellQuote(SESSION_HOOK_SENTINEL)} /sandbox/.bashrc; then`,
    `  printf '\\n%s\\n' ${shellQuote(interactiveHook)} >> /sandbox/.bashrc`,
    `fi`,
  ].join("\n");
  const script = marker
    ? `set -eu; umask 077; ${repairHook}; mkdir -p /var/lib/openrind-shell/runtime; cat > ${SESSION_MARKER_PATH}; chmod 600 ${SESSION_MARKER_PATH}`
    : `rm -f ${SESSION_MARKER_PATH}`;
  // Credentials travel through stdin rather than appearing in process arguments.
  const payload = browserGrant === undefined ? marker : `${marker}:${browserGrant}`;
  const result = await runMarkerScript(name, script, 30_000, payload);
  if (result.exitCode !== 0) throw markerError("launch-marker write", result);
}

/**
 * Wait briefly for the connecting shell to consume the marker. This preserves
 * the session-to-PTY association when a user opens two desktop conversations in
 * one sandbox concurrently. A timeout is non-fatal: the next write replaces a
 * marker belonging to a connect that never reached the shell.
 */
export async function waitCurrentSessionMarkerConsumed(name, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await runMarkerScript(
        name,
        `if [ -f ${SESSION_MARKER_PATH} ]; then printf present; else printf absent; fi`,
        15_000,
      );
      if (result.exitCode !== 0 || !/present/.test(result.stdout ?? "")) return true;
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const __testing = {
  FUSE_IMAGE,
  SESSION_MARKER_PATH,
  deriveClaudeSessionUuid,
  imageForProfile,
  markerCommand,
};
