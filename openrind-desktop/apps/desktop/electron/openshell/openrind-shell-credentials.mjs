// Openrind Shell credential storage. User-managed secrets live here:
//   - databaseUrl       PostgreSQL connection string for the `_openrind` schema
//   - anthropicApiKey   Upstream key owned by the required Haloop runtime
//   - openrindGatewayApiKey  Billing/account API key; never an inference route
// Haloop's per-sandbox client tokens share this encrypted store through a
// main-process-only registry and are never included in renderer status.
//
// All values are encrypted at rest via Electron's safeStorage API (Keychain
// on macOS, DPAPI on Windows, libsecret/kwallet on Linux). The renderer
// never sees the plaintext — only "set"/"unset" status flags. The
// openrind-shell.mjs module in Phase O3 reads decrypted values directly from
// the main process when staging the credential bundle for a sandbox.
//
// Electron is loaded LAZILY (inside each function) so this module can be
// imported under node --test on a dev box that doesn't ship electron.
// When OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR is set, the module reads/writes
// plain files inside that directory instead — a test seam for the
// openrind-shell.mjs suite.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), ".openrind-desktop", "openrind-shell-credentials.json");
const HALOOP_TEST_PROFILES_FILE = "haloop-client-profiles.json";
const MAX_HALOOP_PROFILES = 256;

let haloopRegistrationQueue = Promise.resolve();

function credentialsFile() {
  return process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
}

function testCredentialsDir() {
  return process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR || null;
}

async function getSafeStorage() {
  const { safeStorage } = await import("electron");
  return safeStorage;
}

/** @typedef {"databaseUrl" | "anthropicApiKey" | "openrindGatewayApiKey" | "elevenLabsApiKey"} CredentialKey */

const CREDENTIAL_KEYS = /** @type {const} */ ([
  "databaseUrl",
  "anthropicApiKey",
  "openrindGatewayApiKey",
  // ElevenLabs Scribe API key — optional, used for voice dictation
  // in the composer and sandbox terminal.
  "elevenLabsApiKey",
]);

function maskValue(value) {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function isKnownKey(key) {
  return CREDENTIAL_KEYS.includes(key);
}

async function loadBlob() {
  try {
    const text = await readFile(credentialsFile(), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    // Remove the retired temporary-testing credential from existing installs.
    if ("openrouterApiKey" in parsed) {
      delete parsed.openrouterApiKey;
      if (parsed.updatedAt && typeof parsed.updatedAt === "object") {
        delete parsed.updatedAt.openrouterApiKey;
      }
      await saveBlob(parsed);
    }
    return parsed;
  } catch {
    return {};
  }
}

async function saveBlob(blob) {
  await mkdir(path.dirname(credentialsFile()), { recursive: true });
  // Mode 0o600 caps the impact of safeStorage's fallback "basic" backend on
  // Linux systems without a keyring — even if the encryption is weak, only
  // this user can read the file.
  await atomicWriteFile(credentialsFile(), `${JSON.stringify(blob, null, 2)}\n`);
}

async function atomicWriteFile(destination, contents) {
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Encrypt and persist a credential. Throws if safeStorage's backend isn't
 * available (some headless Linux environments). UI surfaces the error so
 * the user knows secrets won't be stored.
 */
export async function setCredential(key, value) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  // Trim whitespace before storing. Users routinely paste from
  // dashboards / 1Password with a trailing newline or space, and a
  // postgres URL with " " on the end produces a confusing
  // "password authentication failed for user 'postgres'" downstream
  // because pg's URL parser treats trailing whitespace as part of the
  // password.
  let plaintext = String(value ?? "").trim();
  if (key === "databaseUrl") {
    if (plaintext.startsWith("DATABASE_URL=")) {
      plaintext = plaintext.slice("DATABASE_URL=".length).trim();
    }
    if ((plaintext.startsWith("'") && plaintext.endsWith("'")) ||
        (plaintext.startsWith('"') && plaintext.endsWith('"'))) {
      plaintext = plaintext.slice(1, -1).trim();
    }
  }
  if (!plaintext) {
    throw new Error("Credential value is empty.");
  }
  // Test seam: when OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR is set, write a plain
  // file in that dir. The openrind-shell.mjs test suite uses this to stub
  // credentials without needing the Electron runtime.
  const testDir = testCredentialsDir();
  if (testDir) {
    await mkdir(testDir, { recursive: true });
    await writeFile(path.join(testDir, key), plaintext, { mode: 0o600 });
    return;
  }
  const safeStorage = await getSafeStorage();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Encryption is not available on this system (no keyring detected). " +
        "Cannot store Openrind Shell credentials securely. " +
        "Install gnome-keyring or kwallet on Linux, or run from a logged-in desktop session.",
    );
  }
  const encrypted = safeStorage.encryptString(plaintext);
  const blob = await loadBlob();
  blob[key] = encrypted.toString("base64");
  if (!blob.updatedAt || typeof blob.updatedAt !== "object" || Array.isArray(blob.updatedAt)) {
    blob.updatedAt = {};
  }
  blob.updatedAt[key] = Date.now();
  await saveBlob(blob);
}

export async function clearCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  const testDir = testCredentialsDir();
  if (testDir) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(testDir, key), { force: true });
    } catch {
      // Best-effort.
    }
    return;
  }
  const blob = await loadBlob();
  if (key in blob) {
    delete blob[key];
    if (blob.updatedAt && typeof blob.updatedAt === "object" && !Array.isArray(blob.updatedAt) && key in blob.updatedAt) {
      delete blob.updatedAt[key];
    }
    await saveBlob(blob);
  }
}

/**
 * Internal helper for the openrind-shell.mjs module (Phase O3). NEVER exposed
 * via IPC — the renderer reaches credentials only by name, never by
 * value. Returns null on missing or decrypt failure.
 */
export async function getCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown Openrind Shell credential key: ${key}`);
  }
  const testDir = testCredentialsDir();
  if (testDir) {
    try {
      return await readFile(path.join(testDir, key), "utf8");
    } catch {
      return null;
    }
  }
  const blob = await loadBlob();
  if (!blob[key]) return null;
  try {
    const safeStorage = await getSafeStorage();
    return safeStorage.decryptString(Buffer.from(blob[key], "base64"));
  } catch {
    // safeStorage backend keys change when the user switches keyrings or
    // when /run/keyring is rotated. A decrypt failure is recoverable —
    // the user re-enters the credential.
    return null;
  }
}

function normalizeHaloopSandboxName(value) {
  const sandboxName = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(sandboxName)) {
    throw new Error("A valid sandbox name is required for Haloop registration.");
  }
  return sandboxName;
}

function normalizeHaloopProfileInput(options) {
  const sandboxName = normalizeHaloopSandboxName(options?.sandboxName);
  const workspaceId = String(options?.workspaceId ?? "").trim();
  const agentId = String(options?.agentId ?? "").trim().toLowerCase();
  if (!workspaceId || workspaceId.length > 512 || /[\u0000-\u001f\u007f]/.test(workspaceId)) {
    throw new Error("A valid workspace id is required for Haloop registration.");
  }
  if (agentId !== "claude" && agentId !== "openclaw" && agentId !== "openhands") {
    throw new Error("Haloop registration supports Claude, OpenClaw, and OpenHands only.");
  }
  const scopeId = createHash("sha256")
    .update("openrind-haloop-profile-v1\0")
    .update(workspaceId)
    .update("\0")
    .update(sandboxName)
    .update("\0")
    .update(agentId)
    .digest("hex");
  return { sandboxName, workspaceId, agentId, scopeId };
}

function publicHaloopProfile(entry, clientToken) {
  return {
    scopeId: entry.scopeId,
    id: `openrind-${entry.scopeId.slice(0, 32)}`,
    providerName: `haloop-${entry.scopeId.slice(0, 16)}`,
    clientToken,
    sandboxName: entry.sandboxName,
    workspaceId: entry.workspaceId,
    agentId: entry.agentId,
    updatedAt: Number(entry.updatedAt) || Date.now(),
  };
}

function publicRevokedHaloopProfile(entry) {
  return {
    scopeId: entry.scopeId,
    id: `openrind-${entry.scopeId.slice(0, 32)}`,
    providerName: `haloop-${entry.scopeId.slice(0, 16)}`,
    sandboxName: entry.sandboxName,
    workspaceId: entry.workspaceId,
    agentId: entry.agentId,
  };
}

/**
 * Deterministic public identity for a Haloop route. This contains no token and
 * lets Desktop reactivate an already-running PTY's route without touching the
 * encrypted registry or rebuilding the gateway configuration.
 */
export function resolveHaloopClientProfileIdentity(options) {
  const input = normalizeHaloopProfileInput(options);
  return {
    scopeId: input.scopeId,
    id: `openrind-${input.scopeId.slice(0, 32)}`,
    providerName: `haloop-${input.scopeId.slice(0, 16)}`,
    sandboxName: input.sandboxName,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  };
}

async function registerTestHaloopProfile(input, deferCommit = false) {
  const directory = testCredentialsDir();
  const profilePath = path.join(directory, HALOOP_TEST_PROFILES_FILE);
  await mkdir(directory, { recursive: true });
  let document = { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(await readFile(profilePath, "utf8"));
    if (parsed?.version === 1 && parsed.profiles && typeof parsed.profiles === "object") {
      document = parsed;
    }
  } catch {
    // A missing test registry starts empty.
  }
  const existing = document.profiles[input.scopeId];
  const token = typeof existing?.clientToken === "string" && existing.clientToken
    ? existing.clientToken
    : `orh_v1_${randomBytes(32).toString("base64url")}`;
  document.profiles[input.scopeId] = { ...input, clientToken: token, updatedAt: Date.now() };
  if (Object.keys(document.profiles).length > MAX_HALOOP_PROFILES) {
    throw new Error(`Haloop profile registry is full (${MAX_HALOOP_PROFILES} profiles). Revoke an unused profile before retrying.`);
  }
  const commit = async () => {
    let latest = { version: 1, profiles: {} };
    try { latest = JSON.parse(await readFile(profilePath, "utf8")); } catch {}
    latest.profiles[input.scopeId] = document.profiles[input.scopeId];
    if (Object.keys(latest.profiles).length > MAX_HALOOP_PROFILES) throw new Error("Haloop profile registry is full.");
    await atomicWriteFile(profilePath, `${JSON.stringify(latest, null, 2)}\n`);
  };
  if (!deferCommit) await commit();
  const profiles = Object.values(document.profiles).map((entry) =>
    publicHaloopProfile(entry, entry.clientToken),
  );
  return Object.assign(profiles, { commit });
}

async function rotateTestHaloopProfile(input) {
  const directory = testCredentialsDir();
  const profilePath = path.join(directory, HALOOP_TEST_PROFILES_FILE);
  let document;
  try {
    document = JSON.parse(await readFile(profilePath, "utf8"));
  } catch {
    throw new Error("The scoped Haloop client profile does not exist. Launch the sandbox before rotating its token.");
  }
  const existing = document?.version === 1 && document.profiles?.[input.scopeId];
  if (!existing || typeof existing !== "object") {
    throw new Error("The scoped Haloop client profile does not exist. Launch the sandbox before rotating its token.");
  }
  const token = `orh_v1_${randomBytes(32).toString("base64url")}`;
  document.profiles[input.scopeId] = { ...existing, ...input, clientToken: token, updatedAt: Date.now() };
  await atomicWriteFile(profilePath, `${JSON.stringify(document, null, 2)}\n`);
  return Object.values(document.profiles).map((entry) =>
    publicHaloopProfile(entry, entry.clientToken),
  );
}

async function revokeTestHaloopProfiles(sandboxName, beforePersist) {
  const profilePath = path.join(testCredentialsDir(), HALOOP_TEST_PROFILES_FILE);
  let document;
  try {
    document = JSON.parse(await readFile(profilePath, "utf8"));
  } catch {
    await beforePersist?.({ revoked: [] });
    return { revoked: [], profiles: [], unreadableProfiles: 0 };
  }
  if (document?.version !== 1 || !document.profiles || typeof document.profiles !== "object") {
    await beforePersist?.({ revoked: [] });
    return { revoked: [], profiles: [], unreadableProfiles: 0 };
  }
  const matches = Object.entries(document.profiles).filter(
    ([, entry]) => entry?.sandboxName === sandboxName,
  );
  await beforePersist?.({
    revoked: matches.map(([, entry]) => publicRevokedHaloopProfile(entry)),
  });
  if (matches.length === 0) {
    return {
      revoked: [],
      profiles: Object.values(document.profiles).map((entry) =>
        publicHaloopProfile(entry, entry.clientToken),
      ),
      unreadableProfiles: 0,
    };
  }
  for (const [scopeId] of matches) delete document.profiles[scopeId];
  await atomicWriteFile(profilePath, `${JSON.stringify(document, null, 2)}\n`);
  return {
    revoked: matches.map(([, entry]) => publicRevokedHaloopProfile(entry)),
    profiles: Object.values(document.profiles).map((entry) =>
      publicHaloopProfile(entry, entry.clientToken),
    ),
    unreadableProfiles: 0,
  };
}

async function revokeAllTestHaloopProfiles(beforePersist) {
  const profilePath = path.join(testCredentialsDir(), HALOOP_TEST_PROFILES_FILE);
  let document;
  try {
    document = JSON.parse(await readFile(profilePath, "utf8"));
  } catch {
    await beforePersist?.({ revoked: [] });
    return { revoked: [], profiles: [], unreadableProfiles: 0 };
  }
  const entries = document?.version === 1 && document.profiles && typeof document.profiles === "object"
    ? Object.values(document.profiles).filter((entry) => entry && typeof entry === "object")
    : [];
  const revoked = entries.map((entry) => publicRevokedHaloopProfile(entry));
  await beforePersist?.({ revoked });
  await rm(profilePath, { force: true });
  return { revoked, profiles: [], unreadableProfiles: 0 };
}

async function registerProductionHaloopProfile(input, deferCommit = false) {
  const safeStorage = await getSafeStorage();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Encryption is not available on this system. Cannot store the required Haloop client credential securely.",
    );
  }
  const blob = await loadBlob();
  if (!blob.haloopProfiles || typeof blob.haloopProfiles !== "object" || Array.isArray(blob.haloopProfiles)) {
    blob.haloopProfiles = {};
  }
  const existing = blob.haloopProfiles[input.scopeId];
  let token = null;
  if (typeof existing?.clientToken === "string") {
    try {
      token = safeStorage.decryptString(Buffer.from(existing.clientToken, "base64"));
    } catch {
      token = null;
    }
  }
  if (!token) token = `orh_v1_${randomBytes(32).toString("base64url")}`;
  blob.haloopProfiles[input.scopeId] = {
    ...input,
    clientToken: safeStorage.encryptString(token).toString("base64"),
    updatedAt: Date.now(),
  };
  if (Object.keys(blob.haloopProfiles).length > MAX_HALOOP_PROFILES) {
    throw new Error(`Haloop profile registry is full (${MAX_HALOOP_PROFILES} profiles). Revoke an unused profile before retrying.`);
  }
  const commit = async () => {
    const latest = await loadBlob();
    latest.haloopProfiles = { ...latest.haloopProfiles, [input.scopeId]: blob.haloopProfiles[input.scopeId] };
    if (Object.keys(latest.haloopProfiles).length > MAX_HALOOP_PROFILES) throw new Error("Haloop profile registry is full.");
    await saveBlob(latest);
  };
  if (!deferCommit) await commit();

  const profiles = [];
  for (const entry of Object.values(blob.haloopProfiles)) {
    if (!entry || typeof entry !== "object" || typeof entry.clientToken !== "string") continue;
    try {
      profiles.push(
        publicHaloopProfile(
          entry,
          safeStorage.decryptString(Buffer.from(entry.clientToken, "base64")),
        ),
      );
    } catch {
      // A profile whose encrypted token can no longer be opened is excluded;
      // its sandbox will fail closed until that exact profile is registered again.
    }
  }
  return Object.assign(profiles, { commit });
}

async function rotateProductionHaloopProfile(input) {
  const safeStorage = await getSafeStorage();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Encryption is not available on this system. Cannot rotate the required Haloop client credential securely.",
    );
  }
  const blob = await loadBlob();
  const existing = blob.haloopProfiles?.[input.scopeId];
  if (!existing || typeof existing !== "object") {
    throw new Error("The scoped Haloop client profile does not exist. Launch the sandbox before rotating its token.");
  }
  const token = `orh_v1_${randomBytes(32).toString("base64url")}`;
  blob.haloopProfiles[input.scopeId] = {
    ...existing,
    ...input,
    clientToken: safeStorage.encryptString(token).toString("base64"),
    updatedAt: Date.now(),
  };
  await saveBlob(blob);

  const profiles = [];
  for (const entry of Object.values(blob.haloopProfiles)) {
    if (!entry || typeof entry !== "object" || typeof entry.clientToken !== "string") continue;
    try {
      profiles.push(
        publicHaloopProfile(
          entry,
          safeStorage.decryptString(Buffer.from(entry.clientToken, "base64")),
        ),
      );
    } catch {
      // Keep unreadable entries out of the active registry. Their exact
      // sandboxes remain fail-closed until re-registered from Desktop.
    }
  }
  return profiles;
}

async function revokeProductionHaloopProfiles(sandboxName, beforePersist) {
  const blob = await loadBlob();
  if (!blob.haloopProfiles || typeof blob.haloopProfiles !== "object" || Array.isArray(blob.haloopProfiles)) {
    await beforePersist?.({ revoked: [] });
    return { revoked: [], profiles: [], unreadableProfiles: 0 };
  }
  const matches = Object.entries(blob.haloopProfiles).filter(
    ([, entry]) => entry?.sandboxName === sandboxName,
  );
  await beforePersist?.({
    revoked: matches.map(([, entry]) => publicRevokedHaloopProfile(entry)),
  });
  if (matches.length > 0) {
    for (const [scopeId] of matches) delete blob.haloopProfiles[scopeId];
    await saveBlob(blob);
  }

  const profiles = [];
  let unreadableProfiles = 0;
  let safeStorage = null;
  try {
    const candidate = await getSafeStorage();
    if (candidate.isEncryptionAvailable()) safeStorage = candidate;
  } catch {
    safeStorage = null;
  }
  for (const entry of Object.values(blob.haloopProfiles)) {
    if (!entry || typeof entry !== "object" || typeof entry.clientToken !== "string") continue;
    if (!safeStorage) {
      unreadableProfiles += 1;
      continue;
    }
    try {
      profiles.push(
        publicHaloopProfile(
          entry,
          safeStorage.decryptString(Buffer.from(entry.clientToken, "base64")),
        ),
      );
    } catch {
      unreadableProfiles += 1;
    }
  }
  return {
    revoked: matches.map(([, entry]) => publicRevokedHaloopProfile(entry)),
    profiles,
    unreadableProfiles,
  };
}

async function revokeAllProductionHaloopProfiles(beforePersist) {
  const blob = await loadBlob();
  const entries = blob.haloopProfiles && typeof blob.haloopProfiles === "object" && !Array.isArray(blob.haloopProfiles)
    ? Object.values(blob.haloopProfiles).filter((entry) => entry && typeof entry === "object")
    : [];
  const revoked = entries.map((entry) => publicRevokedHaloopProfile(entry));
  await beforePersist?.({ revoked });
  if ("haloopProfiles" in blob) {
    delete blob.haloopProfiles;
    await saveBlob(blob);
  }
  return { revoked, profiles: [], unreadableProfiles: 0 };
}

/**
 * Main-process-only Haloop credential registry. Each sandbox/agent tuple gets
 * its own stable client token. Only encrypted ciphertext is persisted outside
 * the explicit node-test seam, and this API is never exposed through IPC.
 */
export function registerHaloopClientProfile(options) {
  const input = normalizeHaloopProfileInput(options);
  const operation = haloopRegistrationQueue.then(() =>
    testCredentialsDir()
      ? registerTestHaloopProfile(input, options.deferCommit)
      : registerProductionHaloopProfile(input, options.deferCommit),
  );
  haloopRegistrationQueue = operation.catch(() => undefined);
  return operation.then((profiles) => ({
    current: profiles.find((profile) => profile.scopeId === input.scopeId),
    profiles,
    commit: () => {
      const commitOperation = haloopRegistrationQueue.then(profiles.commit);
      haloopRegistrationQueue = commitOperation.catch(() => undefined);
      return commitOperation;
    },
  }));
}

/**
 * Replace one existing scoped token while preserving its stable profile and
 * provider identities. Rotation never creates a missing profile: callers must
 * prove the exact workspace/sandbox/agent scope they intend to invalidate.
 */
export function rotateHaloopClientProfile(options) {
  const input = normalizeHaloopProfileInput(options);
  const operation = haloopRegistrationQueue.then(() =>
    testCredentialsDir()
      ? rotateTestHaloopProfile(input)
      : rotateProductionHaloopProfile(input),
  );
  haloopRegistrationQueue = operation.catch(() => undefined);
  return operation.then((profiles) => ({
    current: profiles.find((profile) => profile.scopeId === input.scopeId),
    profiles,
  }));
}

/**
 * Remove every token belonging to one sandbox. The optional callback runs
 * while the credential mutation queue is held and before ciphertext changes,
 * allowing the runtime to withdraw the old live edge first.
 */
export function revokeHaloopClientProfilesForSandbox(options) {
  const sandboxName = normalizeHaloopSandboxName(options?.sandboxName);
  const beforePersist = typeof options?.beforePersist === "function"
    ? options.beforePersist
    : undefined;
  const operation = haloopRegistrationQueue.then(() =>
    testCredentialsDir()
      ? revokeTestHaloopProfiles(sandboxName, beforePersist)
      : revokeProductionHaloopProfiles(sandboxName, beforePersist),
  );
  haloopRegistrationQueue = operation.catch(() => undefined);
  return operation;
}

/**
 * Remove every scoped Haloop token before the OpenShell integration is reset.
 * The callback runs while the registry queue is held and before ciphertext is
 * changed, so callers can withdraw the only serving edge and delete every
 * endpoint-bound provider first.
 */
export function revokeAllHaloopClientProfiles(options = {}) {
  const beforePersist = typeof options.beforePersist === "function"
    ? options.beforePersist
    : undefined;
  const operation = haloopRegistrationQueue.then(() =>
    testCredentialsDir()
      ? revokeAllTestHaloopProfiles(beforePersist)
      : revokeAllProductionHaloopProfiles(beforePersist),
  );
  haloopRegistrationQueue = operation.catch(() => undefined);
  return operation;
}

/**
 * Renderer-safe view of the credential state. Returns the literal string
 * "set" or "unset" per key — never the value. The renderer renders
 * status pills + Configure/Clear buttons from this shape alone.
 */
export async function getCredentialStatus() {
  const testDir = testCredentialsDir();
  const status = {};
  if (testDir) {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(testDir, "openrouterApiKey"), { force: true }).catch(() => {});
    for (const key of CREDENTIAL_KEYS) {
      try {
        const filePath = path.join(testDir, key);
        const val = await readFile(filePath, "utf8");
        status[key] = "set";
        status[`${key}_masked`] = maskValue(val);
        const { stat } = await import("node:fs/promises");
        const s = await stat(filePath).catch(() => null);
        status[`${key}_updatedAt`] = s ? s.mtimeMs : Date.now();
      } catch {
        status[key] = "unset";
      }
    }
    status.encryptionAvailable = true;
    return status;
  }
  const blob = await loadBlob();
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(credentialsFile()).catch(() => null);
  const fileMtime = fileStat ? fileStat.mtimeMs : Date.now();

  for (const key of CREDENTIAL_KEYS) {
    const isSet = !!blob[key];
    status[key] = isSet ? "set" : "unset";
    if (isSet) {
      const plaintext = await getCredential(key);
      if (plaintext) {
        status[`${key}_masked`] = maskValue(plaintext);
      }
      status[`${key}_updatedAt`] = (blob.updatedAt && blob.updatedAt[key]) || fileMtime;
    }
  }
  try {
    const safeStorage = await getSafeStorage();
    status.encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    status.encryptionAvailable = false;
  }
  return status;
}
