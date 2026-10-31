import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import * as openrindShell from "./openshell/fuse-sandbox.mjs";
import { openshellDoctor } from "./openshell/doctor.mjs";
import { deriveOpenrindShellSandboxName } from "./openshell/openrind-shell-terminal.mjs";

// Tracks per-workspace detached host metadata from orchestratorStartDetached
// so orchestratorInstanceDispose can find and tear down the right
// orchestrator + sandbox when a session closes. Keyed by
// normalizeWorkspaceKey(workspacePath).
const activeDetachedHosts = new Map();

// Resolves the packaged banking-strict.yaml when openshell mode is
// requested without an explicit --sandbox-policy override. Kept in sync
// with main.mjs's resolveOpenShellPoliciesDir() — both look in the
// process.resourcesPath/openshell-policies/ directory in production and
// fall back to the source tree for dev builds.
function resolveOpenShellDefaultPolicy() {
  const override = process.env.OPENRIND_DESKTOP_OPENSHELL_DEFAULT_POLICY;
  if (override) return override;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "openshell-policies", "banking-strict.yaml"));
  }
  // Source-tree fallback for dev builds where electron-builder hasn't
  // run yet. runtime.mjs lives at apps/desktop/electron/runtime.mjs;
  // the policies are at apps/orchestrator/policies/.
  candidates.push(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "orchestrator", "policies", "banking-strict.yaml"),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const DIRECT_RUNTIME = "direct";

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

// Child stdout/stderr can echo credentials (tokens and the opencode password
// are passed to children via env/flags). Scrub known secret values before
// storing, since these buffers are returned to the renderer in snapshots.
const SECRET_STATE_KEYS = ["opencodePassword", "clientToken", "ownerToken", "hostToken"];

function redactSecrets(text, state) {
  let out = text;
  for (const key of SECRET_STATE_KEYS) {
    const secret = state?.[key];
    if (typeof secret === "string" && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join(`[redacted:${key}]`);
    }
  }
  return out;
}

function appendOutput(state, key, chunk) {
  const next = redactSecrets(`${state[key] ?? ""}${String(chunk ?? "")}`, state);
  state[key] = truncateOutput(next);
}

function normalizeWorkspaceKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();
}

function nowMs() {
  return Date.now();
}

function createEngineState() {
  return {
    child: null,
    childExited: true,
    runtime: DIRECT_RUNTIME,
    projectDir: null,
    hostname: null,
    port: null,
    baseUrl: null,
    opencodeUsername: null,
    opencodePassword: null,
    opencodeBinPath: null,
    opencodeBinSource: null,
    lastStdout: null,
    lastStderr: null,
  };
}

function snapshotEngineState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
    runtime: state.runtime,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    // Never expose the opencode password to the renderer; nothing in apps/app
    // reads it (verified) and internal callers read state directly.
    opencodePassword: null,
    opencodeBinPath: state.opencodeBinPath,
    opencodeBinSource: state.opencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function createOpenrindDesktopServerState() {
  return {
    child: null,
    childExited: true,
    remoteAccessEnabled: false,
    host: null,
    port: null,
    baseUrl: null,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: null,
    ownerToken: null,
    hostToken: null,
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    lastStdout: null,
    lastStderr: null,
  };
}

function snapshotOpenrindDesktopServerState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
    remoteAccessEnabled: state.remoteAccessEnabled,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    connectUrl: state.connectUrl,
    mdnsUrl: state.mdnsUrl,
    lanUrl: state.lanUrl,
    clientToken: state.clientToken,
    ownerToken: state.ownerToken,
    hostToken: state.hostToken,
    managedOpencodeBinPath: state.managedOpencodeBinPath,
    managedOpencodeBinSource: state.managedOpencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function assertOpenrindDesktopServerReady(snapshot) {
  if (!snapshot?.running) {
    throw new Error("Openrind Desktop server did not stay running after startup.");
  }
  if (!snapshot.baseUrl) {
    throw new Error("Openrind Desktop server did not report a base URL after startup.");
  }
  if (!snapshot.ownerToken && !snapshot.clientToken) {
    throw new Error("Openrind Desktop server did not report an access token after startup.");
  }
  return snapshot;
}

function createOrchestratorState() {
  return {
    child: null,
    childExited: true,
    dataDir: null,
    baseUrl: null,
    daemonPort: null,
    lastStdout: null,
    lastStderr: null,
  };
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function selectLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry && entry.family === "IPv4" && entry.internal === false) {
        return entry.address;
      }
    }
  }
  return null;
}

function buildConnectUrls(port) {
  const hostname = os.hostname().trim();
  const mdnsUrl = hostname ? `http://${hostname.replace(/\.local$/i, "")}.local:${port}` : null;
  const lan = selectLanAddress();
  const lanUrl = lan ? `http://${lan}:${port}` : null;
  return {
    connectUrl: lanUrl ?? mdnsUrl,
    mdnsUrl,
    lanUrl,
  };
}

function targetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
}

function binaryFileNames(baseName) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const triple = targetTriple();
  return [
    triple ? `${baseName}-${triple}${ext}` : null,
    `${baseName}${ext}`,
  ].filter(Boolean);
}

function prependedPath(sidecarDirs) {
  const filtered = sidecarDirs.filter((dir) => existsSync(dir));
  if (filtered.length === 0) return null;
  return `${filtered.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`;
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Resolves ~/.config/openrind-desktop/env.json (or %APPDATA%\openrind-desktop\env.json on
// Windows) — must agree byte-for-byte with apps/server/src/env-file.ts and
// apps/desktop/src-tauri/src/env_file.rs. Honor OPENRIND_DESKTOP_ENV_STORE override.
function resolveUserEnvFilePath() {
  const override = String(process.env.OPENRIND_DESKTOP_ENV_STORE ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim();
    const root = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(root, "openrind-desktop", "env.json");
  }
  return path.join(os.homedir(), ".config", "openrind-desktop", "env.json");
}

const USER_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_ENV_RESERVED_PREFIXES = ["OPENRIND_DESKTOP_", "OPENCODE_"];

// Synchronous, best-effort; absent or malformed returns {}. Reserved prefixes
// are stripped so a tampered file can never shadow OPENRIND_DESKTOP_* / OPENCODE_*.
function loadUserEnvFile() {
  try {
    const raw = readFileSync(resolveUserEnvFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.variables)) return {};
    const out = {};
    for (const entry of parsed.variables) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!USER_ENV_KEY_PATTERN.test(key)) continue;
      if (USER_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths }) {
  const engineState = createEngineState();
  const openrindDesktopServerState = createOpenrindDesktopServerState();
  const orchestratorState = createOrchestratorState();

  // Serialize engine lifecycle operations. Without this, concurrent renderer
  // invocations of engineStart/engineStop/engineRestart race: each call's
  // stopAllRuntimeChildren kills the previous call's freshly-spawned
  // orchestrator daemon, and the prior call then times out its /health probe.
  let runtimeLifecycleQueue = Promise.resolve();
  let lifecycleState = "idle";
  function withRuntimeLifecycle(fn) {
    const next = runtimeLifecycleQueue.then(fn, fn);
    runtimeLifecycleQueue = next.catch(() => {});
    return next;
  }

  const userDataDir = app.getPath("userData");
  const sidecarDirs = [
    path.join(desktopRoot, "resources", "sidecars"),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    path.join(path.dirname(app.getPath("exe")), "sidecars"),
  ].filter(Boolean);

  function openrindDesktopServerTokenStorePath() {
    return path.join(userDataDir, "openrind-desktop-server-tokens.json");
  }

  function openrindDesktopServerStatePath() {
    return path.join(userDataDir, "openrind-desktop-server-state.json");
  }

  function managedOpencodeWorkdir() {
    return path.join(userDataDir, "managed-opencode-workdir");
  }

  function orchestratorDataDir() {
    const envDir = process.env.OPENRIND_DESKTOP_DATA_DIR?.trim();
    if (envDir) return envDir;
    return path.join(app.getPath("home"), ".openrind-desktop", "openrind-desktop-orchestrator");
  }

  function orchestratorStatePath(dataDir) {
    return path.join(dataDir, "openrind-desktop-orchestrator-state.json");
  }

  function orchestratorAuthPath(dataDir) {
    return path.join(dataDir, "openrind-desktop-orchestrator-auth.json");
  }

  async function readOrchestratorStateFile(dataDir) {
    return readJsonFile(orchestratorStatePath(dataDir), null);
  }

  async function readOrchestratorAuthFile(dataDir) {
    return readJsonFile(orchestratorAuthPath(dataDir), null);
  }

  async function writeOrchestratorAuthFile(dataDir, auth) {
    const filePath = orchestratorAuthPath(dataDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ ...auth, updatedAt: nowMs() }, null, 2)}\n`, "utf8");
  }

  async function clearOrchestratorAuthFile(dataDir) {
    await rm(orchestratorAuthPath(dataDir), { force: true });
  }

  async function requestOrchestratorShutdown(dataDir) {
    const state = await readOrchestratorStateFile(dataDir);
    const baseUrl = state?.daemon?.baseUrl?.trim();
    if (!baseUrl) return false;
    try {
      await fetch(`${baseUrl.replace(/\/+$/, "")}/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function loadTokenStore() {
    return readJsonFile(openrindDesktopServerTokenStorePath(), { version: 1, workspaces: {} });
  }

  async function saveTokenStore(store) {
    const filePath = openrindDesktopServerTokenStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    // Tokens are cleartext; keep the store owner-only. mode applies on create,
    // chmod covers stores created before this was added. (safeStorage encryption
    // is a possible follow-up; it must handle existing plaintext stores.)
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
  }

  async function loadPortState() {
    return readJsonFile(openrindDesktopServerStatePath(), {
      version: 3,
      workspacePorts: {},
      preferredPort: null,
    });
  }

  async function savePortState(state) {
    const filePath = openrindDesktopServerStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function loadOrCreateWorkspaceTokens(workspaceKey) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (store.workspaces?.[normalized]) {
      return store.workspaces[normalized];
    }
    const next = {
      clientToken: randomUUID(),
      hostToken: randomUUID(),
      ownerToken: null,
      updatedAt: nowMs(),
    };
    store.workspaces ??= {};
    store.workspaces[normalized] = next;
    await saveTokenStore(store);
    return next;
  }

  async function persistWorkspaceOwnerToken(workspaceKey, ownerToken) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (!store.workspaces?.[normalized]) return;
    store.workspaces[normalized].ownerToken = ownerToken;
    store.workspaces[normalized].updatedAt = nowMs();
    await saveTokenStore(store);
  }

  async function persistPreferredOpenrindDesktopPort(workspaceKey, port) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    state.version = 3;
    state.workspacePorts ??= {};
    if (normalized) {
      state.workspacePorts[normalized] = port;
      state.preferredPort = null;
    } else {
      state.preferredPort = port;
    }
    await savePortState(state);
  }

  async function resolveOpenrindDesktopPort(host, workspaceKey) {
    // Use a fresh port every boot. Persisted preferred ports made prod starts
    // fragile when an old sidecar held the previous port or shutdown was
    // unclean; Electron publishes the chosen URL to React after boot.
    return findFreePort(host);
  }

  async function ensureDevModePaths() {
    const root = path.join(userDataDir, "openrind-desktop-dev-data");
    const paths = {
      homeDir: path.join(root, "home"),
      xdgConfigHome: path.join(root, "xdg", "config"),
      xdgDataHome: path.join(root, "xdg", "data"),
      xdgCacheHome: path.join(root, "xdg", "cache"),
      xdgStateHome: path.join(root, "xdg", "state"),
      opencodeConfigDir: path.join(root, "config", "opencode"),
    };

    for (const dir of Object.values(paths)) {
      await mkdir(dir, { recursive: true });
    }
    await mkdir(path.join(paths.xdgDataHome, "opencode"), { recursive: true });
    return paths;
  }

  async function buildChildEnv(extra = {}) {
    /** @type {NodeJS.ProcessEnv} */
    // User env is layered first so process.env + any caller overrides always
    // win. See apps/server/src/env-file.ts and src-tauri/src/env_file.rs —
    // all three loaders must agree on path + reserved-keys policy.
    const env = {
      ...loadUserEnvFile(),
      ...process.env,
      BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
      ...extra,
    };
    const pathEnv = prependedPath(sidecarDirs);
    if (pathEnv) {
      env.PATH = pathEnv;
    }
    if (process.env.OPENRIND_DESKTOP_DEV_MODE === "1") {
      const devPaths = await ensureDevModePaths();
      env.OPENRIND_DESKTOP_DEV_MODE = "1";
      env.HOME = devPaths.homeDir;
      env.USERPROFILE = devPaths.homeDir;
      env.XDG_CONFIG_HOME = devPaths.xdgConfigHome;
      env.XDG_DATA_HOME = devPaths.xdgDataHome;
      env.XDG_CACHE_HOME = devPaths.xdgCacheHome;
      env.XDG_STATE_HOME = devPaths.xdgStateHome;
      env.OPENCODE_CONFIG_DIR = devPaths.opencodeConfigDir;
      env.OPENCODE_TEST_HOME = devPaths.homeDir;
    }
    return env;
  }

  function resolveBinaryInfo(baseName, extraPaths = []) {
    for (const directory of [...sidecarDirs, ...extraPaths]) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(directory, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "bundled" };
        }
      }
    }

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(entry, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "path" };
        }
      }
    }

    if (baseName === "opencode") {
      for (const candidate of [
        path.join(app.getPath("home"), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/opt/homebrew/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/local/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
      ]) {
        if (existsSync(candidate)) {
          return { path: candidate, source: "known-location" };
        }
      }
    }

    return null;
  }

  function resolveBinary(baseName, extraPaths = []) {
    return resolveBinaryInfo(baseName, extraPaths)?.path ?? null;
  }

  function resolveOpencodeBinary(opencodeBinPath) {
    const explicitPath = typeof opencodeBinPath === "string" ? opencodeBinPath.trim() : "";
    if (!explicitPath) return resolveBinaryInfo("opencode");
    // Renderer-supplied path: require an existing regular file before it is
    // handed to OPENRIND_DESKTOP_OPENCODE_BIN / --opencode-bin and executed.
    const resolved = path.resolve(explicitPath);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`Custom opencode binary is not a file: ${resolved}`);
    }
    return { path: resolved, source: "custom" };
  }

  function resolveDockerCandidates() {
    const candidates = [];
    const seen = new Set();

    for (const key of ["OPENRIND_DESKTOP_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"]) {
      const value = process.env[key]?.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        candidates.push(value);
      }
    }

    for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(entry, process.platform === "win32" ? "docker.exe" : "docker");
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    for (const candidate of [
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    return candidates.filter((candidate) => existsSync(candidate));
  }

  function runDockerCommandDetailed(args, timeoutMs = 8000) {
    const tried = [...resolveDockerCandidates(), process.platform === "win32" ? "docker.exe" : "docker"];
    const errors = [];

    for (const program of tried) {
      try {
        const result = spawnSync(program, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
        });
        return {
          program,
          status: typeof result.status === "number" ? result.status : -1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Failed to run docker: ${errors.join("; ")} (Set OPENRIND_DESKTOP_DOCKER_BIN to your docker binary if needed)`,
    );
  }

  function parseDockerClientVersion(stdout) {
    const line = String(stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    return line.toLowerCase().startsWith("docker version") ? line : null;
  }

  function parseDockerServerVersion(stdout) {
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Server Version:")) {
        return trimmed.slice("Server Version:".length).trim() || null;
      }
    }
    return null;
  }

  function deriveOrchestratorContainerName(runId) {
    const sanitized = String(runId ?? "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .slice(0, 24);
    return `openrind-desktop-orchestrator-${sanitized}`;
  }

  async function listOpenrindDesktopManagedContainers() {
    const result = runDockerCommandDetailed(["ps", "-a", "--format", "{{.Names}}"], 8000);
    if (result.status !== 0) {
      const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
      throw new Error(combined || `docker ps -a failed (status ${result.status})`);
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name && (name.startsWith("openrind-desktop-orchestrator-") || name.startsWith("openrind-desktop-dev-") || name.startsWith("openwrk-")))
      .sort();
  }

  async function runShellCommand(program, args, options = {}) {
    const result = spawnSync(program, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    return {
      status: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function engineDoctor(options = {}) {
    // resolveOpencodeBinary throws when a configured custom path is invalid;
    // report that as a doctor finding instead of failing the IPC call.
    let resolved = null;
    let resolveError = null;
    try {
      resolved = resolveOpencodeBinary(options?.opencodeBinPath);
    } catch (error) {
      resolveError = error instanceof Error ? error.message : String(error);
    }
    if (!resolved?.path) {
      return {
        found: false,
        inPath: false,
        resolvedPath: null,
        resolvedSource: null,
        version: null,
        supportsServe: false,
        notes: [resolveError ?? "OpenCode binary not found in bundled sidecars or PATH."],
        serveHelpStatus: null,
        serveHelpStdout: null,
        serveHelpStderr: null,
      };
    }

    const versionResult = spawnSync(resolved.path, ["--version"], { encoding: "utf8" });
    const helpResult = spawnSync(resolved.path, ["serve", "--help"], { encoding: "utf8" });
    const notes = [`Using ${resolved.source}: ${resolved.path}`];
    if (versionResult.status !== 0) {
      notes.push("OpenCode version probe failed.");
    }
    if (helpResult.status !== 0) {
      notes.push("OpenCode serve --help probe failed.");
    }

    return {
      found: true,
      inPath: resolved.source === "path",
      resolvedPath: resolved.path,
      resolvedSource: resolved.source,
      version: versionResult.stdout?.trim() || versionResult.stderr?.trim() || null,
      supportsServe: helpResult.status === 0,
      notes,
      serveHelpStatus: typeof helpResult.status === "number" ? helpResult.status : null,
      serveHelpStdout: helpResult.stdout?.trim() || null,
      serveHelpStderr: helpResult.stderr?.trim() || null,
    };
  }

  async function pinnedOpencodeInstallCommand() {
    const constantsPath = path.resolve(desktopRoot, "../../constants.json");
    const payload = JSON.parse(await readFile(constantsPath, "utf8"));
    const version = String(payload?.opencodeVersion ?? "").trim().replace(/^v/, "");
    if (!version) {
      throw new Error("constants.json is missing opencodeVersion");
    }
    return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version} --no-modify-path`;
  }

  function spawnManagedChild(state, program, args, options = {}) {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    state.child = child;
    state.childExited = false;
    state.lastStdout = null;
    state.lastStderr = null;

    child.stdout?.on("data", (chunk) => appendOutput(state, "lastStdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => appendOutput(state, "lastStderr", chunk.toString()));
    child.on("exit", (code) => {
      state.childExited = true;
      if (code != null && code !== 0) {
        appendOutput(state, "lastStderr", `Process exited with code ${code}.\n`);
      }
      options.onExit?.(code);
    });
    child.on("error", (error) => {
      state.childExited = true;
      appendOutput(state, "lastStderr", `${error instanceof Error ? error.message : String(error)}\n`);
    });

    return child;
  }

  function processMatchesSidecar(command) {
    const value = String(command ?? "");
    return sidecarDirs.some((dir) => value.includes(dir)) &&
      (
        value.includes("openrind-desktop-orchestrator") ||
        value.includes("openrind-desktop-server") ||
        value.includes("opencode serve")
      );
  }

  function killProcessId(pid, signal = "SIGTERM") {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or is not ours.
    }
  }

  async function cleanupPackagedSidecars() {
    if (!app.isPackaged) return;

    // First ask the previously recorded orchestrator daemon to shut itself and
    // its OpenCode child down. This handles the happy path without relying on
    // process-list parsing.
    await requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()).catch(() => false);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Safety net: an unclean Electron quit can orphan sidecars. Packaged builds
    // should always own a fresh runtime per app launch, so remove any leftover
    // sidecars from this app bundle before choosing ports for the new runtime.
    const result = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    const rows = String(result.stdout ?? "").split(/\r?\n/);
    const pids = [];
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (processMatchesSidecar(command)) pids.push(pid);
    }
    for (const pid of pids) killProcessId(pid, "SIGTERM");
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const pid of pids) killProcessId(pid, "SIGKILL");
    }
  }

  async function stopChild(state, options = {}) {
    const child = state.child;
    state.child = null;
    state.childExited = true;
    if (!child || child.exitCode != null || child.killed) return;

    if (options.requestShutdown) {
      try {
        const shutdownRequested = await options.requestShutdown();
        if (shutdownRequested) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch {
        // ignore
      }
    }

    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async function ensureOpencodeConfig(projectDir) {
    const configPath = path.join(projectDir, "opencode.json");
    if (await fileExists(configPath)) return;
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  function generateManagedCredentials() {
    return [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")];
  }

  async function issueOwnerToken(baseUrl, hostToken) {
    const payload = await fetchJson(
      `${baseUrl.replace(/\/+$/, "")}/tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenrindDesktop-Host-Token": hostToken,
        },
        body: JSON.stringify({ scope: "owner", label: "Openrind Desktop desktop owner token" }),
      },
      5000,
    );
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    return token || null;
  }

  async function startOpenrindDesktopServer(options) {
    await stopChild(openrindDesktopServerState);

    const workspacePaths = options.workspacePaths.filter((value) => value.trim().length > 0);
    const activeWorkspace = workspacePaths[0] ?? "";
    const host = options.remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
    const port = await resolveOpenrindDesktopPort(host, activeWorkspace);
    const baseUrl = `http://127.0.0.1:${port}`;
    const tokens = await loadOrCreateWorkspaceTokens(activeWorkspace);
    const program = resolveBinary("openrind-desktop-server");
    if (!program) {
      throw new Error("Failed to locate openrind-desktop-server.");
    }

    const args = [
      "--host",
      host,
      "--port",
      String(port),
      "--cors",
      "*",
      "--approval",
      "auto",
      ...workspacePaths.flatMap((workspacePath) => ["--workspace", workspacePath]),
      ...(options.opencodeBaseUrl ? ["--opencode-base-url", options.opencodeBaseUrl] : []),
      ...(activeWorkspace ? ["--opencode-directory", activeWorkspace] : []),
    ];

    const managedOpencode = options.manageOpencode ? resolveOpencodeBinary(options.opencodeBinPath) : null;
    openrindDesktopServerState.managedOpencodeBinPath = managedOpencode?.path ?? null;
    openrindDesktopServerState.managedOpencodeBinSource = managedOpencode?.source ?? null;
    if (options.manageOpencode) {
      engineState.opencodeBinPath = managedOpencode?.path ?? null;
      engineState.opencodeBinSource = managedOpencode?.source ?? null;
    }

    const env = await buildChildEnv({
      OPENRIND_DESKTOP_TOKEN: tokens.clientToken,
      OPENRIND_DESKTOP_HOST_TOKEN: tokens.hostToken,
      ...(options.manageOpencode ? { OPENRIND_DESKTOP_MANAGE_OPENCODE: "1" } : {}),
      ...(options.manageOpencode ? { OPENRIND_DESKTOP_OPENCODE_BIN: managedOpencode?.path ?? "" } : {}),
      ...(options.manageOpencode ? { OPENRIND_DESKTOP_MANAGED_OPENCODE_CWD: managedOpencodeWorkdir() } : {}),
      ...(options.opencodeUsername ? { OPENRIND_DESKTOP_OPENCODE_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENRIND_DESKTOP_OPENCODE_PASSWORD: options.opencodePassword } : {}),
    });

    spawnManagedChild(openrindDesktopServerState, program, args, {
      cwd: activeWorkspace || desktopRoot,
      env,
    });

    openrindDesktopServerState.remoteAccessEnabled = options.remoteAccessEnabled;
    openrindDesktopServerState.host = host;
    openrindDesktopServerState.port = port;
    openrindDesktopServerState.baseUrl = baseUrl;
    openrindDesktopServerState.clientToken = tokens.clientToken;
    openrindDesktopServerState.hostToken = tokens.hostToken;

    const connectUrls = options.remoteAccessEnabled ? buildConnectUrls(port) : { connectUrl: null, mdnsUrl: null, lanUrl: null };
    openrindDesktopServerState.connectUrl = connectUrls.connectUrl;
    openrindDesktopServerState.mdnsUrl = connectUrls.mdnsUrl;
    openrindDesktopServerState.lanUrl = connectUrls.lanUrl;

    await waitForHttpOk(`${baseUrl}/health`, 10_000);
    // Owner tokens live in the Openrind Desktop server token store, which can be reset
    // independently from the desktop runtime token cache. Always mint a fresh
    // owner token for the newly-started server instead of trusting the cached
    // value; otherwise the renderer can receive a stale bearer token and all
    // workspace calls fail with 401.
    const ownerToken = await issueOwnerToken(baseUrl, tokens.hostToken);
    openrindDesktopServerState.ownerToken = ownerToken;
    if (ownerToken) {
      await persistWorkspaceOwnerToken(activeWorkspace, ownerToken);
    }
    if (ownerToken) {
      try {
        const list = await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
        const first = Array.isArray(list?.items) ? list.items[0] : undefined;
        const opencode = first?.opencode;
        if (opencode?.baseUrl) {
          engineState.runtime = DIRECT_RUNTIME;
          engineState.projectDir = opencode.directory ?? activeWorkspace ?? null;
          engineState.hostname = new URL(opencode.baseUrl).hostname;
          engineState.port = Number(new URL(opencode.baseUrl).port) || null;
          engineState.baseUrl = opencode.baseUrl;
          engineState.opencodeUsername = opencode.username ?? null;
          engineState.opencodePassword = opencode.password ?? null;
          engineState.child = null;
          engineState.childExited = false;
        }
      } catch (error) {
        appendOutput(openrindDesktopServerState, "lastStderr", `Openrind Desktop server workspace probe: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    await persistPreferredOpenrindDesktopPort(activeWorkspace, port);
    return snapshotOpenrindDesktopServerState(openrindDesktopServerState);
  }

  async function stopAllRuntimeChildren() {
    await stopChild(openrindDesktopServerState);
    await stopChild(orchestratorState, {
      requestShutdown: () => requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()),
    });
    await clearOrchestratorAuthFile(orchestratorState.dataDir || orchestratorDataDir()).catch(() => undefined);
    await stopChild(engineState);

    Object.assign(engineState, createEngineState());
    Object.assign(openrindDesktopServerState, createOpenrindDesktopServerState());
    Object.assign(orchestratorState, createOrchestratorState());
  }

  async function prepareFreshRuntime() {
    lifecycleState = "cleaning";
    await stopAllRuntimeChildren();
    await cleanupPackagedSidecars();
    lifecycleState = "idle";
  }

  async function ensureOpenrindDesktop(options) {
    let openrindDesktopServer;
    try {
      openrindDesktopServer = await startOpenrindDesktopServer({
        workspacePaths: options.workspacePaths,
        opencodeBaseUrl: engineState.baseUrl,
        opencodeUsername: engineState.opencodeUsername,
        opencodePassword: engineState.opencodePassword,
        remoteAccessEnabled: options.remoteAccessEnabled,
        manageOpencode: options.manageOpencode === true,
        opencodeBinPath: options.opencodeBinPath,
      });
    } catch (error) {
      appendOutput(engineState, "lastStderr", `Openrind Desktop server: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }

    assertOpenrindDesktopServerReady(openrindDesktopServer);
  }

  async function engineStart(projectDir, options = {}) {
    const safeProjectDir = String(projectDir ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("projectDir is required");
    }
    await mkdir(safeProjectDir, { recursive: true });
    await ensureOpencodeConfig(safeProjectDir);
    await prepareFreshRuntime();

    const workspacePaths = [safeProjectDir, ...((options.workspacePaths ?? []).filter(Boolean))].filter(
      (value, index, list) => list.indexOf(value) === index,
    );
    const runtime = DIRECT_RUNTIME;

    try {
      lifecycleState = "starting";
      engineState.runtime = runtime;
      engineState.projectDir = safeProjectDir;
      engineState.child = null;
      engineState.childExited = true;

      await ensureOpenrindDesktop({
        projectDir: safeProjectDir,
        workspacePaths,
        remoteAccessEnabled: options.openrindDesktopRemoteAccess === true,
        manageOpencode: true,
        opencodeBinPath: options.opencodeBinPath,
      });

      lifecycleState = "healthy";
      return snapshotEngineState(engineState);
    } catch (error) {
      lifecycleState = "error";
      throw error;
    }
  }

  async function engineStop() {
    lifecycleState = "stopping";
    await stopAllRuntimeChildren();
    lifecycleState = "idle";
    return snapshotEngineState(engineState);
  }

  async function engineRestart(options = {}) {
    const projectDir = engineState.projectDir;
    if (!projectDir) {
      throw new Error("OpenCode is not configured for a local workspace");
    }
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeEnableExa: options.opencodeEnableExa,
      openrindDesktopRemoteAccess: options.openrindDesktopRemoteAccess,
    });
  }

  async function engineInfo() {
    return { ...snapshotEngineState(engineState), lifecycleState };
  }

  async function runtimeStatus() {
    return {
      lifecycleState,
      engine: await engineInfo(),
      openrindDesktopServer: snapshotOpenrindDesktopServerState(openrindDesktopServerState),
    };
  }

  async function openrindDesktopServerInfo() {
    return snapshotOpenrindDesktopServerState(openrindDesktopServerState);
  }

  async function openrindDesktopServerRestart(options = {}) {
    const workspacePaths = (await listLocalWorkspacePaths()).filter(Boolean);
    return startOpenrindDesktopServer({
      workspacePaths,
      opencodeBaseUrl: engineState.baseUrl,
      opencodeUsername: engineState.opencodeUsername,
      opencodePassword: engineState.opencodePassword,
      remoteAccessEnabled: options.remoteAccessEnabled === true,
    });
  }

  async function orchestratorStatus() {
    const engine = snapshotEngineState(engineState);
    const openrindDesktopServer = snapshotOpenrindDesktopServerState(openrindDesktopServerState);
    const workspaces = engine.projectDir
      ? [{ id: normalizeWorkspaceKey(engine.projectDir), path: engine.projectDir, name: path.basename(engine.projectDir) || "Workspace" }]
      : [];
    return {
      running: engine.running,
      dataDir: null,
      daemon: openrindDesktopServer.running
        ? { baseUrl: openrindDesktopServer.baseUrl, port: openrindDesktopServer.port, pid: openrindDesktopServer.pid, runtime: "direct" }
        : null,
      opencode: engine.running
        ? { baseUrl: engine.baseUrl, port: engine.port, pid: engine.pid, projectDir: engine.projectDir, runtime: "direct" }
        : null,
      cliVersion: null,
      sidecar: null,
      binaries: null,
      activeId: workspaces[0]?.id ?? null,
      workspaceCount: workspaces.length,
      workspaces,
      lastError: engine.lastStderr,
    };
  }

  async function orchestratorWorkspaceActivate(input) {
    const workspacePath = String(input?.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }
    const resolved = path.resolve(workspacePath);
    if (normalizeWorkspaceKey(engineState.projectDir) !== normalizeWorkspaceKey(resolved)) {
      await engineStart(resolved, {
        runtime: DIRECT_RUNTIME,
        workspacePaths: [resolved],
      });
    }
    return {
      id: normalizeWorkspaceKey(resolved),
      path: resolved,
      name: input?.name ?? (path.basename(resolved) || "Workspace"),
    };
  }

  // Per spec §2.3: POST /shutdown to the orchestrator process, wait 5s
  // for graceful exit, and — when the backend is openshell — delete the
  // sandbox and clean up the staging dir. Idempotent: a dispose for a
  // workspace with no tracked host is a no-op return true.
  async function orchestratorInstanceDispose(workspacePath) {
    const key = normalizeWorkspaceKey(workspacePath);
    const host = activeDetachedHosts.get(key);
    if (!host) return true;

    // Openrind Shell profiles short-circuit: sandbox name = workspace ID is
    // the cross-machine portability story, so the sandbox MUST survive
    // a session close. The external terminal exiting is what ends the
    // user-facing interaction. No HTTP shutdown, no sandbox delete,
    // no staging cleanup (Openrind Shell has no host-side staging dir).
    if (
      host.sandboxProfile === "openrind-shell-claude" ||
      host.sandboxProfile === "openrind-shell-openclaw" ||
      host.sandboxProfile === "openrind-shell-codex"
    ) {
      activeDetachedHosts.delete(key);
      return true;
    }

    // 1. Ask the orchestrator child to exit gracefully. Best-effort —
    // if it's already gone we just continue to teardown.
    if (host.openrindDesktopUrl) {
      try {
        await fetch(`${host.openrindDesktopUrl.replace(/\/+$/, "")}/shutdown`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(host.hostToken ? { Authorization: `Bearer ${host.hostToken}` } : {}),
          },
        });
      } catch {
        // The orchestrator child may already be down; that's fine.
      }
    }

    // 2. Wait up to 5s for the orchestrator to exit on its own. We don't
    // have the child process handle (it was detach+unref'd), so we just
    // sleep — the orchestrator typically exits in <2s after /shutdown.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // 3. OpenShell-specific: explicit sandbox delete so the pod doesn't
    // linger after the orchestrator dies. spawnSync + --force makes
    // this idempotent against an already-deleted sandbox.
    if (host.sandboxBackend === "openshell" && host.sandboxContainerName) {
      try {
        spawnSync(
          "wsl.exe",
          [
            "-d",
            "openrind-desktop-openshell",
            "--",
            "openshell",
            "sandbox",
            "delete",
            host.sandboxContainerName,
            "--force",
          ],
          { windowsHide: true, timeout: 30_000 },
        );
      } catch {
        // Best-effort teardown — the next session start would surface
        // a residual sandbox via the listSandboxes IPC anyway.
      }
    }

    // 4. Clean the staging directory the orchestrator child used. The
    // path is the same pattern as cli.ts's stageSandboxRuntime base.
    if (host.sandboxRunId) {
      const stagingDir = path.join(
        os.homedir(),
        ".openrind-desktop",
        "runs",
        host.sandboxRunId,
      );
      try {
        await rm(stagingDir, { recursive: true, force: true });
      } catch {
        // Permission errors or already-removed: ignore.
      }
    }

    activeDetachedHosts.delete(key);
    return true;
  }

  async function engineInstall() {
    if (process.platform === "win32") {
      return {
        ok: false,
        status: -1,
        stdout: "",
        stderr:
          "Guided install is not supported on Windows yet. Install the Openrind Desktop-pinned OpenCode version manually, then restart Openrind Desktop.",
      };
    }

    const installDir = path.join(app.getPath("home"), ".opencode", "bin");
    const command = await pinnedOpencodeInstallCommand();
    const result = await runShellCommand("bash", ["-lc", command], {
      env: { ...(await buildChildEnv()), OPENCODE_INSTALL_DIR: installDir },
      timeoutMs: 180_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function opencodeMcpAuth(projectDir, serverName) {
    const safeProjectDir = String(projectDir ?? "").trim();
    const safeServerName = String(serverName ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("project_dir is required");
    }
    if (!safeServerName) {
      throw new Error("server_name is required");
    }

    const program = resolveBinary("opencode");
    if (!program) {
      throw new Error("Failed to locate opencode.");
    }

    const result = await runShellCommand(program, ["mcp", "auth", safeServerName], {
      cwd: safeProjectDir,
      env: await buildChildEnv(),
      timeoutMs: 120_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function sandboxDoctor() {
    const candidates = resolveDockerCandidates();
    const debug = {
      candidates,
      selectedBin: null,
      versionCommand: null,
      infoCommand: null,
    };

    let version;
    try {
      version = runDockerCommandDetailed(["--version"], 2000);
    } catch (error) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.selectedBin = version.program;
    debug.versionCommand = {
      status: version.status,
      stdout: truncateOutput(version.stdout, 1200),
      stderr: truncateOutput(version.stderr, 1200),
    };

    const clientVersion = parseDockerClientVersion(version.stdout);
    if (version.status !== 0) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: `docker --version failed (status ${version.status}): ${version.stderr.trim()}`,
        debug,
      };
    }

    let info;
    try {
      info = runDockerCommandDetailed(["info"], 8000);
    } catch (error) {
      return {
        installed: true,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.infoCommand = {
      status: info.status,
      stdout: truncateOutput(info.stdout, 1200),
      stderr: truncateOutput(info.stderr, 1200),
    };

    if (info.status === 0) {
      return {
        installed: true,
        daemonRunning: true,
        permissionOk: true,
        ready: true,
        clientVersion,
        serverVersion: parseDockerServerVersion(info.stdout),
        error: null,
        debug,
      };
    }

    const combined = `${info.stdout.trim()}\n${info.stderr.trim()}`.trim().toLowerCase();
    const permissionOk = !combined.includes("permission denied") && !combined.includes("access is denied");
    const daemonRunning = !combined.includes("cannot connect to the docker daemon") && !combined.includes("is the docker daemon running") && !combined.includes("connection refused") && !combined.includes("no such file or directory");

    return {
      installed: true,
      daemonRunning,
      permissionOk,
      ready: false,
      clientVersion,
      serverVersion: null,
      error: `${info.stdout.trim()}\n${info.stderr.trim()}`.trim() || `docker info failed (status ${info.status})`,
      debug,
    };
  }

  async function sandboxStop(containerName) {
    const name = String(containerName ?? "").trim();
    if (!name) {
      throw new Error("containerName is required");
    }
    if (!name.startsWith("openrind-desktop-orchestrator-")) {
      throw new Error("Refusing to stop container: expected name starting with 'openrind-desktop-orchestrator-'");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("containerName contains invalid characters");
    }
    const result = runDockerCommandDetailed(["stop", name], 15_000);
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function sandboxCleanupOpenrindDesktopContainers() {
    const candidates = await listOpenrindDesktopManagedContainers().catch((error) => {
      throw error;
    });
    const removed = [];
    const errors = [];

    for (const name of candidates) {
      try {
        const result = runDockerCommandDetailed(["rm", "-f", name], 20_000);
        if (result.status === 0) {
          removed.push(name);
        } else {
          errors.push(`${name}: exit ${result.status}: ${(result.stdout + "\n" + result.stderr).trim()}`);
        }
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { candidates, removed, errors };
  }

  async function orchestratorStartDetached(options = {}) {
    const workspacePath = String(options.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }

    const sandboxBackend = String(options.sandboxBackend ?? "none").trim().toLowerCase();
    if (!["none", "docker", "microsandbox", "openshell"].includes(sandboxBackend)) {
      throw new Error("sandboxBackend must be one of: none, docker, microsandbox, openshell");
    }

    const sandboxProfile = String(options.sandboxProfile ?? "openrind-desktop").trim();
    const isOpenrindShellProfile =
      sandboxProfile === "openrind-shell-claude" ||
      sandboxProfile === "openrind-shell-openclaw" ||
      sandboxProfile === "openrind-shell-codex";

    // Fail fast for openshell — spec §9.2 calls for hard-fail, not silent
    // fallback to docker, so the banker is never running under weaker
    // isolation than their policy assumes.
    if (sandboxBackend === "openshell" && !isOpenrindShellProfile) {
      const doc = await openshellDoctor();
      if (doc.status !== "ready") {
        const reason =
          doc.fatal[0] ?? doc.actionable[0] ?? `OpenShell status: ${doc.status}`;
        throw new Error(`OpenShell is not ready: ${reason}`);
      }
    }

    // Openrind Shell profile branch: skip the npm orchestrator entirely.
    // Openrind Shell's agent (Claude Code / OpenClaw) runs as a foreground TTY
    // process inside the sandbox — there is no openrind-desktop-server HTTP
    // endpoint to spawn. We create (or resume) the sandbox here and
    // return a slimmer host-info shape (no openrindDesktopUrl). The renderer's
    // <OpenrindShellTerminal> component (apps/app/src/react-app/domains/
    // session/surface/openrind-shell-terminal.tsx) then opens an in-window
    // xterm.js bound to the sandbox via openrindPtyOpen — per spec §2.2
    // ("Renderer: opens xterm.js + chat UI bound to openrindDesktopUrl").
    // No external OS terminal is launched.
    if (sandboxBackend === "openshell" && isOpenrindShellProfile) {
      const workspaceId =
        String(options.workspaceId ?? "").trim() || path.basename(workspacePath);
      const sandboxName = deriveOpenrindShellSandboxName(workspaceId);
      const result = await openrindShell.createOpenrindShellSandbox({
        name: sandboxName,
        workspaceId,
        profile: sandboxProfile,
      });
      const hostInfo = {
        openrindDesktopUrl: null,
        token: null,
        ownerToken: null,
        hostToken: null,
        port: null,
        sandboxBackend,
        sandboxProfile,
        sandboxRunId: sandboxName,
        sandboxContainerName: sandboxName,
        openrindExisted: result.existed,
        terminalLaunch: null,
        terminalError: null,
      };
      activeDetachedHosts.set(normalizeWorkspaceKey(workspacePath), hostInfo);
      return hostInfo;
    }

    const wantsContainerSandbox =
      sandboxBackend === "docker" ||
      sandboxBackend === "microsandbox" ||
      sandboxBackend === "openshell";
    const runId = String(options.runId ?? randomUUID()).trim();
    const containerName = wantsContainerSandbox ? deriveOrchestratorContainerName(runId) : null;
    const port = await findFreePort("127.0.0.1");
    const token = String(options.openrindDesktopToken ?? randomUUID()).trim();
    const hostToken = String(options.openrindDesktopHostToken ?? randomUUID()).trim();
    const openrindDesktopUrl = `http://127.0.0.1:${port}`;
    const program = resolveBinary("openrind-desktop-orchestrator") ?? resolveBinary("openrind-desktop");
    if (!program) {
      throw new Error("Failed to locate openrind-desktop orchestrator.");
    }

    const args = [
      "start",
      "--workspace",
      workspacePath,
      "--approval",
      "auto",
      "--detach",
      "--openrind-desktop-port",
      String(port),
      "--run-id",
      runId,
      ...(sandboxBackend === "docker" || sandboxBackend === "microsandbox"
        ? ["--sandbox", "docker"]
        : []),
      ...(sandboxBackend === "openshell"
        ? (() => {
            // Caller-provided ref wins; otherwise fall back to the
            // packaged banking-strict.yaml (spec §9 recommendation —
            // predictable conservative default for banker workspaces).
            const explicit = options.sandboxPolicyRef
              ? String(options.sandboxPolicyRef)
              : null;
            const resolved = explicit ?? resolveOpenShellDefaultPolicy();
            const flags = ["--sandbox", "openshell"];
            if (resolved) flags.push("--sandbox-policy", resolved);
            return flags;
          })()
        : []),
      ...(options.sandboxImageRef ? ["--sandbox-image", String(options.sandboxImageRef)] : []),
    ];

    const child = spawn(program, args, {
      env: { ...(await buildChildEnv()), OPENRIND_DESKTOP_TOKEN: token, OPENRIND_DESKTOP_HOST_TOKEN: hostToken },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // Detached children have no stdio; without a listener a spawn failure
    // (ENOENT/EACCES) becomes an uncaught exception in the main process.
    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
    child.unref();

    try {
      await waitForHttpOk(`${openrindDesktopUrl}/health`, wantsContainerSandbox ? 90_000 : 12_000);
    } catch (error) {
      // Do not leave an orphaned detached orchestrator behind when it never
      // became healthy.
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore: child already exited
      }
      throw spawnError ?? error;
    }
    const ownerToken = await issueOwnerToken(openrindDesktopUrl, hostToken).catch(() => null);

    const hostInfo = {
      openrindDesktopUrl,
      token,
      ownerToken,
      hostToken,
      port,
      sandboxBackend: wantsContainerSandbox ? sandboxBackend : null,
      sandboxProfile: wantsContainerSandbox ? sandboxProfile : null,
      sandboxRunId: wantsContainerSandbox ? runId : null,
      sandboxContainerName: containerName,
    };
    activeDetachedHosts.set(normalizeWorkspaceKey(workspacePath), hostInfo);
    return hostInfo;
  }

  async function sandboxDebugProbe() {
    const startedAt = nowMs();
    const runId = `probe-${randomUUID()}`;
    const workspacePath = path.join(os.tmpdir(), `openrind-desktop-sandbox-probe-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });

    const doctor = await sandboxDoctor();
    let detachedHost = null;
    let dockerInspect = null;
    let dockerLogs = null;
    let error = null;
    const cleanupErrors = [];
    let containerRemoved = false;
    let workspaceRemoved = false;
    let removeResult = null;

    if (doctor.ready) {
      try {
        detachedHost = await orchestratorStartDetached({
          workspacePath,
          sandboxBackend: "docker",
          runId,
        });
        const containerName = detachedHost.sandboxContainerName ?? deriveOrchestratorContainerName(runId);
        try {
          const inspectResult = runDockerCommandDetailed(["inspect", containerName], 6000);
          dockerInspect = {
            status: inspectResult.status,
            stdout: truncateOutput(inspectResult.stdout, 48000),
            stderr: truncateOutput(inspectResult.stderr, 48000),
          };
        } catch (inspectError) {
          cleanupErrors.push(`docker inspect failed: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
        }
        try {
          const logsResult = runDockerCommandDetailed(["logs", "--timestamps", "--tail", "400", containerName], 8000);
          dockerLogs = {
            status: logsResult.status,
            stdout: truncateOutput(logsResult.stdout, 48000),
            stderr: truncateOutput(logsResult.stderr, 48000),
          };
        } catch (logsError) {
          cleanupErrors.push(`docker logs failed: ${logsError instanceof Error ? logsError.message : String(logsError)}`);
        }

        try {
          const rmResult = runDockerCommandDetailed(["rm", "-f", containerName], 20_000);
          containerRemoved = rmResult.status === 0;
          removeResult = {
            status: rmResult.status,
            stdout: truncateOutput(rmResult.stdout, 48000),
            stderr: truncateOutput(rmResult.stderr, 48000),
          };
        } catch (removeError) {
          cleanupErrors.push(`docker rm -f ${containerName} failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      } catch (probeError) {
        error = `Sandbox probe failed to start: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
      }
    } else {
      error = doctor.error ?? "Docker is not ready for sandbox creation";
    }

    try {
      await rm(workspacePath, { recursive: true, force: true });
      workspaceRemoved = true;
    } catch (workspaceError) {
      cleanupErrors.push(`Failed to remove probe workspace: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}`);
    }

    return {
      startedAt,
      finishedAt: nowMs(),
      runId,
      workspacePath,
      ready: doctor.ready && !error,
      doctor,
      detachedHost,
      dockerInspect,
      dockerLogs,
      cleanup: {
        containerName: detachedHost?.sandboxContainerName ?? null,
        containerRemoved,
        removeResult,
        workspaceRemoved,
        errors: cleanupErrors,
      },
      error,
    };
  }

  return {
    engineStart: (projectDir, options) => withRuntimeLifecycle(() => engineStart(projectDir, options)),
    engineStop: () => withRuntimeLifecycle(() => engineStop()),
    engineRestart: (options) => withRuntimeLifecycle(() => engineRestart(options)),
    prepareFreshRuntime: () => withRuntimeLifecycle(() => prepareFreshRuntime()),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    runtimeStatus,
    engineInfo,
    engineDoctor,
    engineInstall,
    openrindDesktopServerInfo,
    openrindDesktopServerRestart,
    orchestratorStatus,
    orchestratorWorkspaceActivate,
    orchestratorInstanceDispose,
    orchestratorStartDetached,
    opencodeMcpAuth,
    sandboxDoctor,
    sandboxStop,
    sandboxCleanupOpenrindDesktopContainers,
    sandboxDebugProbe,
  };
}
