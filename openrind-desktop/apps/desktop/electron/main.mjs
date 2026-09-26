import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} from "electron";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager } from "./runtime.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import {
  exportWorkspaceConfig,
  importWorkspaceConfig,
} from "./workspace-archive.mjs";
import * as openshellClient from "./openshell/client.mjs";
import * as openshellCli from "./openshell/cli.mjs";
import * as openrindShell from "./openshell/openrind-shell.mjs";
import * as openrindCredentials from "./openshell/openrind-shell-credentials.mjs";
import * as openrindPty from "./openshell/openrind-shell-pty.mjs";
import {
  deriveOpenrindShellSandboxName,
  launchExternalTerminalToSandbox,
} from "./openshell/openrind-shell-terminal.mjs";
import { openshellDoctor } from "./openshell/doctor.mjs";
import {
  installOpenShellStack,
  loadInstallerState as loadOpenShellInstallerState,
} from "./openshell/installer.mjs";
import {
  DISTRO_NAME as OPENSHELL_DISTRO_NAME,
  distroExists,
  ensureDistroRunning,
  wslRun,
} from "./openshell/wsl.mjs";

// Preflight gate for every Openrind Shell entry point. If the WSL distro
// isn't registered, the very first `wsl -d openrind-desktop-openshell -- docker
// pull ...` call fails with a raw WSL_E_DISTRO_NOT_FOUND error. We
// surface a phrase the renderer's BootstrapErrorCard recognises so the
// user sees the "Open Settings → Sandbox" CTA instead of a stack trace.
async function assertOpenShellReady() {
  let exists;
  try {
    exists = await distroExists();
  } catch (err) {
    // wsl.exe missing entirely (non-Windows host or WSL not installed)
    // surfaces here. Treat as not-ready.
    throw new Error(
      `OpenShell is not ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!exists) {
    throw new Error(
      `OpenShell is not ready: WSL distro "${OPENSHELL_DISTRO_NAME}" is not registered. ` +
        "Open Settings → Sandbox and run the installer.",
    );
  }
  // Distro is registered — make sure it is actually running before any
  // sandbox commands are issued. A stopped distro needs WSL to boot it
  // first, which can take 30–60 s on a cold machine; without this step
  // the subsequent `openshell sandbox list --json` (10 s timeout) races
  // against the boot and times out.
  try {
    await ensureDistroRunning();
  } catch (err) {
    throw new Error(
      `OpenShell is not ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DEEP_LINK_EVENT = "openrind-desktop:deep-link-native";
const TAURI_APP_IDENTIFIER = "com.differentai.openrind-desktop";
const DESKTOP_PROTOCOL_SCHEME = "openrind-desktop";

// Share the same on-disk state folder as the Tauri shell so in-place
// migration is a no-op for almost every file. Done BEFORE whenReady so all
// app.getPath("userData") callers see the unified path.
//
// Override via OPENRIND_DESKTOP_ELECTRON_USERDATA so dogfooders can isolate their
// Electron install from the real Tauri app.
app.setName("Openrind Desktop");
if (process.platform === "win32") {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
  } else {
    // In Windows development mode, we must pass the path to our main script/folder so Windows launches electron.exe with our app,
    // rather than trying to load the deep-link URL as the app entrypoint.
    app.setAsDefaultProtocolClient(
      DESKTOP_PROTOCOL_SCHEME,
      process.execPath,
      [path.resolve(process.argv[1])]
    );
  }
} else {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataOverride = process.env.OPENRIND_DESKTOP_ELECTRON_USERDATA?.trim();
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), TAURI_APP_IDENTIFIER),
  );
}

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: repo-relative path to the Electron resource icon set.
    path.resolve(__dirname, "../resources/icons/icon.png"),
    // Packaged: electron-builder copies extraResources but we fall back to this
    // if custom packaging ever exposes the icon here.
    path.join(process.resourcesPath ?? "", "icons", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH
  ? nativeImage.createFromPath(APP_ICON_PATH)
  : null;

if (
  process.platform === "darwin" &&
  APP_ICON_IMAGE &&
  !APP_ICON_IMAGE.isEmpty() &&
  app.dock
) {
  app.dock.setIcon(APP_ICON_IMAGE);
}

// Optional: expose Chrome DevTools Protocol so external tools (chrome-devtools
// MCP, raw CDP clients, etc.) can attach to this Electron instance.
// Enable by setting OPENRIND_DESKTOP_ELECTRON_REMOTE_DEBUG_PORT=<port> before launch.
const remoteDebugPort = Number.parseInt(
  process.env.OPENRIND_DESKTOP_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
if (Number.isFinite(remoteDebugPort) && remoteDebugPort > 0) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    String(remoteDebugPort),
  );
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
const DEFAULT_DEN_BASE_URL = "https://app.openrind-desktoplabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";

function envFlagDisabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

// SSRF guard for the renderer-facing __fetch proxy. The renderer can ask the
// main process to fetch arbitrary URLs (bundle/publisher/cloud flows). Without
// restrictions this is a server-side request-forgery hole: injected renderer
// content could read cloud metadata (169.254.169.254), loopback admin
// services, or LAN hosts with the main process's network privileges, bypassing
// CORS. We require https and reject any host that resolves to a private,
// loopback, link-local, or otherwise reserved address (checked post-DNS so
// rebinding to an internal IP is also blocked).
function isReservedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true; // loopback / unspecified
    if (v.startsWith("fe80")) return true; // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
    if (v.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check as v4.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isReservedIp(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal — reject
}

// A DNS lookup that resolves a hostname AND rejects it when any resolved
// address is reserved — in the SAME call whose result is then used for the
// actual TCP connection. Passing this as the socket `lookup` for every request
// (including each redirect hop) means the address that was validated is the
// exact address connected to. This closes the DNS-rebinding TOCTOU where a
// host validates as public and then re-resolves to a private/loopback IP for
// the real fetch: there is no second, unvalidated resolution.
function pinnedPublicLookup(hostname, options, callback) {
  const opts = { all: true };
  if (options && typeof options.family === "number" && options.family !== 0) {
    opts.family = options.family;
  }
  dnsLookup(hostname, opts).then(
    (addresses) => {
      if (
        addresses.length === 0 ||
        addresses.some((a) => isReservedIp(a.address))
      ) {
        callback(
          new Error(`Blocked request to a non-public host: ${hostname}`),
        );
        return;
      }
      if (options && options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    },
    (err) => callback(err),
  );
}

// Synchronous pre-checks that need no DNS: scheme, obvious loopback names, and
// reserved IP literals. Hostname resolution + reserved-range rejection happens
// at connect time in pinnedPublicLookup (the real security boundary).
function requirePublicHttpsUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https URLs are allowed.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost)$/i.test(host)) {
    throw new Error("Blocked request to a loopback host.");
  }
  if (net.isIP(host) && isReservedIp(host)) {
    throw new Error(`Blocked request to a non-public host: ${host}`);
  }
  return parsed;
}

const MAIN_FETCH_MAX_REDIRECTS = 5;
const MAIN_FETCH_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAIN_FETCH_TIMEOUT_MS = 30_000;

// SSRF-safe replacement for a bare fetch() in the __fetch IPC handler. Uses
// node:https with the pinned, validating DNS lookup above so the connection can
// only reach the vetted public address, and follows redirects MANUALLY so
// every hop is re-validated (https scheme + resolved address) instead of
// trusting fetch's automatic redirect following. Returns the same shape the
// renderer's desktopFetch expects: { status, statusText, headers, body }.
async function mainProcessFetch(
  rawUrl,
  init,
  redirectsLeft = MAIN_FETCH_MAX_REDIRECTS,
) {
  const parsed = requirePublicHttpsUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(
      parsed,
      {
        method: init && typeof init.method === "string" ? init.method : "GET",
        headers:
          init && init.headers && typeof init.headers === "object"
            ? init.headers
            : undefined,
        lookup: pinnedPublicLookup,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          typeof location === "string"
        ) {
          res.resume(); // discard the redirect body before following
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects."));
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(location, parsed).toString();
          } catch {
            reject(new Error("Invalid redirect location."));
            return;
          }
          // 303 downgrades to GET and drops the body; 307/308 preserve both.
          const nextInit =
            status === 303 ? { headers: init?.headers, method: "GET" } : init;
          mainProcessFetch(nextUrl, nextInit, redirectsLeft - 1).then(
            resolve,
            reject,
          );
          return;
        }
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on("data", (chunk) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAIN_FETCH_MAX_BODY_BYTES) {
            aborted = true;
            req.destroy();
            reject(new Error("Response body exceeded size limit."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          const headers = [];
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const v of value) headers.push([key, String(v)]);
            } else if (value != null) {
              headers.push([key, String(value)]);
            }
          }
          resolve({
            status,
            statusText: res.statusMessage ?? "",
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(MAIN_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timed out."));
    });
    if (init && typeof init.body === "string") {
      req.write(init.body);
    }
    req.end();
  });
}

// Only hand these schemes to the OS handler. Blocks file:/smb:/custom protocol
// URIs that a malicious deep link or bundle value could otherwise use to
// disclose local files or launch arbitrary registered handlers.
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["https:", "http:", "mailto:"]);

async function openExternalSafe(url) {
  if (typeof url !== "string" || url.trim().length === 0) return;
  let target;
  try {
    target = new URL(url);
  } catch {
    console.warn("[openExternal] blocked malformed URL");
    return;
  }
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(target.protocol)) {
    console.warn(`[openExternal] blocked URL scheme: ${target.protocol}`);
    return;
  }
  await shell.openExternal(target.toString());
}

async function installReactDevToolsForDev() {
  if (app.isPackaged || envFlagDisabled("OPENRIND_DESKTOP_REACT_DEVTOOLS")) return;
  try {
    const mod = await import("electron-devtools-installer");
    const installExtension =
      typeof mod.installExtension === "function"
        ? mod.installExtension
        : typeof mod.default === "function"
          ? mod.default
          : typeof mod.default?.installExtension === "function"
            ? mod.default.installExtension
            : null;
    const reactDevtools =
      mod.REACT_DEVELOPER_TOOLS ?? mod.default?.REACT_DEVELOPER_TOOLS;
    if (typeof installExtension !== "function" || !reactDevtools) {
      throw new Error(
        "electron-devtools-installer did not expose React DevTools",
      );
    }
    const name = await installExtension(reactDevtools);
    console.info(`[devtools] installed ${name}`);
  } catch (error) {
    console.warn("[devtools] failed to install React Developer Tools", error);
  }
}

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
  opencodeBinPath: null,
  opencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_OPENRIND_DESKTOP_SERVER_INFO = Object.freeze({
  running: false,
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
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_ROUTER_INFO = Object.freeze({
  running: false,
  version: null,
  workspacePath: null,
  opencodeUrl: null,
  healthPort: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

let mainWindow = null;
const pendingDeepLinks = [];

// OpenShell installer singleton. Only one install can run at a time; the
// renderer drives it via openshellInstallStart / openshellInstallStatus /
// openshellInstallCancel.
const openshellInstaller = {
  /** @type {Promise<unknown> | null} */ promise: null,
  /** @type {AbortController | null} */ abortController: null,
  /** @type {{ status: string, phase?: string, message?: string, error?: string } | null} */
  lastEvent: null,
  /** Most recent terminal status: "idle" | "running" | "ready" | "reboot_required" | "cancelled" | "failed". */
  status: "idle",
};

function resolveOpenShellRootfsPath() {
  // Bundled by electron-builder as an extraResource (Phase 9 wires this
  // into electron-builder.yml). Allow env override for dev workflows.
  const override = process.env.OPENRIND_DESKTOP_OPENSHELL_ROOTFS;
  if (override) return override;
  const base = process.resourcesPath || path.join(__dirname, "..", "resources");
  return path.join(base, "openshell", "ubuntu-24.04-openshell.tar.gz");
}

function resolveOpenShellPoliciesDir() {
  // In production the policies are mapped to process.resourcesPath/openshell-policies
  // by electron-builder.yml (Phase 9). In dev we fall back to the
  // source directory so devs see the policies they're editing.
  const override = process.env.OPENRIND_DESKTOP_OPENSHELL_POLICIES_DIR;
  if (override) return override;
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "openshell-policies");
    if (existsSync(packaged)) return packaged;
  }
  return path.join(__dirname, "..", "..", "orchestrator", "policies");
}

function emitOpenShellInstallProgress(payload) {
  openshellInstaller.lastEvent = payload;
  try {
    mainWindow?.webContents.send("openshell:install-progress", payload);
  } catch {
    // Window may have closed mid-install; the next status query still works.
  }
}

function emitOpenrindShellSessionProgress(payload) {
  try {
    mainWindow?.webContents.send("openrind-shell:session-progress", payload);
  } catch {
    // Window may have closed; renderer's next status query still works.
  }
}

function emitOpenrindShellPtyData(sessionId, data) {
  try {
    mainWindow?.webContents.send("openrind-shell:pty-data", { sessionId, data });
  } catch {
    // Window may have closed mid-stream. The renderer's next PTY open
    // reattaches handlers (attachHandlers) so a brief disconnect is fine.
  }
}

function emitOpenrindShellPtyExit(sessionId, exitCode, signal) {
  try {
    mainWindow?.webContents.send("openrind-shell:pty-exit", {
      sessionId,
      exitCode,
      signal,
    });
  } catch {
    // ignore
  }
}



/**
 * Dump a PTY session's retained scrollback to disk as BOTH a byte-exact `.raw`
 * file and a replayable asciinema-v2 `.cast`.
 *
 * DEVELOPER-ONLY: deliberately has no UI entry point — it is a debugging tool,
 * not a feature, and it was removed from the terminal's overflow menu because it
 * means nothing to an end user. Invoke it from DevTools:
 *
 *   const b = window.__OPENRIND_DESKTOP_ELECTRON__;
 *   const [s] = await b.invokeDesktop("openrindPtyList");
 *   await b.invokeDesktop("openrindPtyDumpBuffer", s.id);
 *
 * This exists to make terminal bugs measurable instead of guessable. The `.raw`
 * file is exactly what the agent wrote, so `cat dump.raw` in a known-good
 * terminal (or `asciinema play dump.cast`) reproduces the output with xterm.js
 * entirely out of the picture. If the artifact renders correctly there but not
 * in-app, the bug is ours (renderer/addons/theming/geometry); if it is mangled
 * there too, the bytes were already corrupt upstream and no amount of emulator
 * work will fix it. Always produce this before concluding anything about
 * xterm.js.
 *
 * @param {string} sessionId
 * @returns {Promise<{ rawPath: string, castPath: string, bytes: number,
 *   chunks: number }>}
 */
async function dumpOpenrindShellPtyBuffer(sessionId) {
  const bytes = openrindPty.getBufferBytes(sessionId);
  const recording = openrindPty.getBufferRecording(sessionId);
  if (!bytes || !recording) {
    throw new Error(`No PTY session found for id ${sessionId}`);
  }
  const dir = path.join(app.getPath("logs"), "openrind-shell-dumps");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeSandbox =
    recording.sandboxName.replace(/[^a-zA-Z0-9_.-]+/g, "-") || "sandbox";
  const base = path.join(dir, `${safeSandbox}-${stamp}`);
  const rawPath = `${base}.raw`;
  const castPath = `${base}.cast`;

  // Eviction means the oldest retained chunk rarely starts at t=0. Rebase onto
  // the first retained chunk so playback starts immediately instead of sitting
  // on a blank screen for however long the evicted prefix lasted.
  const t0 = recording.chunks.length > 0 ? recording.chunks[0].t : 0;
  const header = {
    version: 2,
    width: recording.cols,
    height: recording.rows,
    timestamp: Math.floor((recording.openedAt + t0 * 1000) / 1000),
    env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
  };
  const lines = [JSON.stringify(header)];
  for (const chunk of recording.chunks) {
    lines.push(JSON.stringify([Number((chunk.t - t0).toFixed(6)), "o", chunk.data]));
  }

  await writeFile(rawPath, bytes);
  await writeFile(castPath, `${lines.join("\n")}\n`, "utf8");
  return {
    rawPath,
    castPath,
    bytes: bytes.length,
    chunks: recording.chunks.length,
  };
}

/**
 * Build the extra env forwarded into the Openrind Shell PTY at spawn time:
 * decrypted Anthropic / OpenrindGateway keys (so Claude Code auto-configures
 * its provider on first run without an interactive prompt) plus COLUMNS /
 * LINES belt-and-suspenders alongside the stty call in openrind-shell-pty.mjs.
 * Shared by the openrindPtyOpen and openrindPtyAttachOrOpen handlers.
 *
 * @param {number | undefined} cols
 * @param {number | undefined} rows
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function buildOpenrindShellPtyEnv(cols, rows) {
  const extraEnv = {};
  try {
    const anthropicApiKey =
      await openrindCredentials.getCredential("anthropicApiKey");
    if (anthropicApiKey) extraEnv.ANTHROPIC_API_KEY = anthropicApiKey;
  } catch {
    /* safeStorage may be unavailable in some test environments */
  }
  try {
    const openrindGatewayApiKey =
      await openrindCredentials.getCredential("openrindGatewayApiKey");
    if (openrindGatewayApiKey) extraEnv.OPENRIND_GATEWAY_API_KEY = openrindGatewayApiKey;
  } catch {
    /* optional — OpenrindGateway tracking only */
  }
  const effectiveCols = Number.isFinite(cols) && cols > 0 ? cols : 120;
  const effectiveRows = Number.isFinite(rows) && rows > 0 ? rows : 32;
  extraEnv.COLUMNS = String(effectiveCols);
  extraEnv.LINES = String(effectiveRows);
  return Object.keys(extraEnv).length > 0 ? extraEnv : undefined;
}

/**
 * Write the per-connect "which agent conversation to launch" marker into the
 * sandbox before a FRESH PTY connect, so the .bashrc launch block binds the
 * auto-launched agent (Claude Code / OpenClaw) to the Openrind Desktop session the
 * user selected. Best-effort: any failure is swallowed so the connect still
 * proceeds (the agent just launches its default conversation).
 *
 * @param {string} sandboxName
 * @param {string} profile  "openrind-shell-claude" | "openrind-shell-openclaw" | ""
 * @param {string | null} agentSessionId  Openrind Desktop session id, or null
 */
async function writeOpenrindShellSessionMarker(sandboxName, profile, agentSessionId) {
  try {
    const value = openrindShell.resolveAgentSessionValue(profile, agentSessionId);
    await openrindShell.writeCurrentSessionMarker(sandboxName, value);
  } catch (error) {
    console.warn(
      "[openrindPty] session marker write failed (non-fatal):",
      error?.message || String(error),
    );
  }
}

// Agent sessions are CONCURRENT: a sandbox hosts one live PTY per Openrind Desktop
// session, and switching tasks detaches (agent keeps working) rather than
// killing. The launch handshake, however, shares one marker file per sandbox
// (`openshell sandbox connect` cannot carry env/args into the container), so
// FRESH connects against the same sandbox must be serialized: write marker →
// spawn → (the connecting shell consumes the marker) → only then write the
// next marker. openrindMarkerPending remembers that a spawned connect has
// not been confirmed to consume its marker yet.
const openrindFreshOpenChains = new Map();
const openrindMarkerPending = new Set();

/**
 * Adopt-or-open an Openrind Shell PTY for a (sandbox, session) pair.
 * Live same-session PTY → adopt immediately (no marker write, no queueing).
 * Otherwise queue a fresh open on the sandbox's serial chain.
 *
 * @param {{ sandboxName: string, cols?: number, rows?: number,
 *           extraEnv?: Record<string, string>, agentSessionId: string | null,
 *           profile: string }} opts
 */
function openOpenrindShellPtySession(opts) {
  const { sandboxName, cols, rows, extraEnv, agentSessionId, profile } = opts;
  const live = openrindPty.findSessionBySandboxAndAgent(
    sandboxName,
    agentSessionId,
  );
  if (live && !live.exitInfo) {
    // openSession adopts the live PTY — nothing launches, so the shared
    // marker must not be touched (it may belong to another in-flight open).
    return openrindPty.openSession({
      sandboxName,
      cols,
      rows,
      extraEnv,
      agentSessionId,
    });
  }
  const prev = openrindFreshOpenChains.get(sandboxName) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      if (openrindMarkerPending.has(sandboxName)) {
        // Bounded wait — the previous connect's shell deletes the marker on
        // read. On timeout (connect died pre-shell) we proceed and overwrite.
        await openrindShell.waitCurrentSessionMarkerConsumed(sandboxName);
        openrindMarkerPending.delete(sandboxName);
      }
      await writeOpenrindShellSessionMarker(sandboxName, profile, agentSessionId);
      if (agentSessionId) openrindMarkerPending.add(sandboxName);
      return openrindPty.openSession({
        sandboxName,
        cols,
        rows,
        extraEnv,
        agentSessionId,
      });
    });
  openrindFreshOpenChains.set(sandboxName, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (openrindFreshOpenChains.get(sandboxName) === next) {
        openrindFreshOpenChains.delete(sandboxName);
      }
    });
  return next;
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function forwardedDeepLinks(argv) {
  // Only accept the app's own custom schemes from OS-forwarded argv. The app is
  // registered only for openrind-desktop:// (see setAsDefaultProtocolClient), so a
  // forwarded http(s) argument is never a genuine OS deep link — accepting it
  // would let a crafted launch argument inject an arbitrary web URL into the
  // renderer's deep-link parsers (connect-remote / den-auth / bundle). Web
  // deep-linking is unaffected: the web build drives links from window.location
  // via startDeepLinkBridge, not through this desktop argv path.
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith("openrind-desktop://") || entry.startsWith("openrind-desktop-dev://"),
    );
}

function queueDeepLinks(urls) {
  const nextUrls = urls.filter(Boolean);
  if (nextUrls.length === 0) return;
  pendingDeepLinks.push(...nextUrls);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, nextUrls);
  }
}

function flushPendingDeepLinks() {
  if (!mainWindow?.webContents || pendingDeepLinks.length === 0) return;
  const urls = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, urls);
}

function desktopBootstrapPath() {
  if (process.env.OPENRIND_DESKTOP_DESKTOP_BOOTSTRAP_PATH?.trim()) {
    return process.env.OPENRIND_DESKTOP_DESKTOP_BOOTSTRAP_PATH.trim();
  }
  return path.join(
    os.homedir(),
    ".config",
    "openrind-desktop",
    "desktop-bootstrap.json",
  );
}

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "openrind-desktop-workspaces.json");
}

// Earlier Electron alpha builds copied Tauri's openrind-desktop-workspaces.json into an
// Electron-only workspace-state.json. Keep importing that file when the shared
// canonical file is missing, but write openrind-desktop-workspaces.json going forward so
// Tauri rollback and Electron both read the same desktop workspace state.
function legacyElectronWorkspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

async function migrateLegacyElectronWorkspaceStateIfNeeded() {
  const current = workspaceStatePath();
  const legacy = legacyElectronWorkspaceStatePath();
  try {
    if (existsSync(current)) return false;
    if (!existsSync(legacy)) return false;
    await mkdir(path.dirname(current), { recursive: true });
    const raw = await readFile(legacy, "utf8");
    await writeFile(current, raw, "utf8");
    console.info(
      "[migration] copied workspace-state.json → openrind-desktop-workspaces.json",
    );
    return true;
  } catch (error) {
    console.warn(
      "[migration] legacy Electron workspace-state copy failed",
      error,
    );
    return false;
  }
}

function configHomePath() {
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return process.env.XDG_CONFIG_HOME.trim();
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    return process.env.APPDATA.trim();
  }
  return path.join(os.homedir(), ".config");
}

function globalOpencodeRoot() {
  return path.join(configHomePath(), "opencode");
}

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
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

function normalizeDesktopBootstrapConfig(input) {
  const baseUrl =
    typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }

  const apiBaseUrl =
    typeof input?.apiBaseUrl === "string" && input.apiBaseUrl.trim().length > 0
      ? input.apiBaseUrl.trim()
      : null;

  return {
    baseUrl,
    apiBaseUrl,
    requireSignin: input?.requireSignin === true,
  };
}

async function getDesktopBootstrapConfig() {
  try {
    const raw = await readFile(desktopBootstrapPath(), "utf8");
    return normalizeDesktopBootstrapConfig(JSON.parse(raw));
  } catch {
    return {
      baseUrl: DEFAULT_DEN_BASE_URL,
      apiBaseUrl: null,
      requireSignin: false,
    };
  }
}

async function setDesktopBootstrapConfig(config) {
  const normalized = normalizeDesktopBootstrapConfig(config);
  const outputPath = desktopBootstrapPath();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function sanitizeCommandName(raw) {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (!trimmed) return null;
  const safe = Array.from(trimmed)
    .filter((char) => /[A-Za-z0-9_-]/.test(char))
    .join("");
  return safe || null;
}

function escapeYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function serializeCommandFrontmatter(command) {
  const template = String(command?.template ?? "").trim();
  if (!template) {
    throw new Error("command.template is required");
  }

  let output = "---\n";
  if (typeof command?.description === "string" && command.description.trim()) {
    output += `description: ${escapeYamlScalar(command.description.trim())}\n`;
  }
  if (typeof command?.agent === "string" && command.agent.trim()) {
    output += `agent: ${escapeYamlScalar(command.agent.trim())}\n`;
  }
  if (typeof command?.model === "string" && command.model.trim()) {
    output += `model: ${escapeYamlScalar(command.model.trim())}\n`;
  }
  if (command?.subtask === true) {
    output += "subtask: true\n";
  }
  output += `---\n\n${template}\n`;
  return output;
}

function validateSkillName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

function defaultWorkspaceOpenrindDesktopConfig(workspacePath, preset = null) {
  return {
    version: 1,
    workspace: workspacePath
      ? {
          name: path.basename(workspacePath) || "Workspace",
          createdAt: Date.now(),
          preset: preset || null,
        }
      : null,
    authorizedRoots: workspacePath ? [workspacePath] : [],
    reload: null,
  };
}

async function normalizeLocalWorkspacePath(rawPath) {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return "";
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  const resolved = path.resolve(expanded);
  return realpath(resolved).catch(() => resolved);
}

function normalizeWorkspacePathKey(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? path.resolve(trimmed).replace(/\\/g, "/").toLowerCase() : "";
}

function stableWorkspaceId(value) {
  return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

function localWorkspaceId(workspacePath) {
  return stableWorkspaceId(workspacePath);
}

function remoteWorkspaceId(baseUrl, directory) {
  const key = String(directory ?? "").trim()
    ? `remote::${baseUrl}::${String(directory).trim()}`
    : `remote::${baseUrl}`;
  return stableWorkspaceId(key);
}

function openrindDesktopRemoteWorkspaceId(hostUrl, workspaceId) {
  const key = String(workspaceId ?? "").trim()
    ? `openrind-desktop::${hostUrl}::${String(workspaceId).trim()}`
    : `openrind-desktop::${hostUrl}`;
  return stableWorkspaceId(key);
}

async function readWorkspaceOpenrindDesktopConfig(workspacePath) {
  const openrindDesktopPath = path.join(workspacePath, ".opencode", "openrind-desktop.json");
  if (!(await pathExists(openrindDesktopPath))) {
    return defaultWorkspaceOpenrindDesktopConfig(workspacePath);
  }
  const raw = await readFile(openrindDesktopPath, "utf8");
  return JSON.parse(raw);
}

async function writeWorkspaceOpenrindDesktopConfig(workspacePath, config) {
  const openrindDesktopPath = path.join(workspacePath, ".opencode", "openrind-desktop.json");
  await mkdir(path.dirname(openrindDesktopPath), { recursive: true });
  await writeFile(openrindDesktopPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return execResult(true, `Wrote ${openrindDesktopPath}`);
}

async function readWorkspaceState() {
  const state = await readJsonFile(workspaceStatePath(), EMPTY_WORKSPACE_LIST);
  return {
    selectedId:
      typeof state?.selectedId === "string"
        ? state.selectedId
        : typeof state?.selectedWorkspaceId === "string"
          ? state.selectedWorkspaceId
          : typeof state?.activeId === "string"
            ? state.activeId
            : "",
    watchedId:
      typeof state?.watchedId === "string"
        ? state.watchedId
        : typeof state?.watchedWorkspaceId === "string"
          ? state.watchedWorkspaceId
          : null,
    activeId: typeof state?.activeId === "string" ? state.activeId : null,
    workspaces: Array.isArray(state?.workspaces) ? state.workspaces : [],
  };
}

async function writeWorkspaceState(nextState) {
  const outputPath = workspaceStatePath();
  const selectedId = String(nextState?.selectedId ?? nextState?.activeId ?? "");
  const watchedId =
    typeof nextState?.watchedId === "string" ? nextState.watchedId : "";
  const output = {
    ...nextState,
    // Tauri's Rust state uses selectedWorkspaceId/watchedWorkspaceId on disk
    // (with activeId as a legacy alias). Keep Electron's selectedId/watchedId
    // too so older Electron builds can still read the same file.
    selectedId,
    selectedWorkspaceId: selectedId,
    watchedId: watchedId || null,
    watchedWorkspaceId: watchedId,
    activeId: selectedId || null,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: async () =>
    (await readWorkspaceState()).workspaces
      .filter((entry) => entry?.workspaceType !== "remote")
      .map((entry) => String(entry?.path ?? "").trim())
      .filter(Boolean),
});

let runtimeDisposedForQuit = false;
let runtimeBootstrapPromise = null;

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit) return;
  runtimeDisposedForQuit = true;
  await runtimeManager.dispose().catch(() => undefined);
}

function assertOpenrindDesktopServerReady(info) {
  if (!info?.running) {
    throw new Error("Openrind Desktop server did not stay running after startup.");
  }
  if (!info.baseUrl) {
    throw new Error("Openrind Desktop server did not report a base URL after startup.");
  }
  if (!info.ownerToken && !info.clientToken) {
    throw new Error(
      "Openrind Desktop server did not report an access token after startup.",
    );
  }
  return info;
}

async function bootRuntimeForSelectedWorkspace() {
  const list = await readWorkspaceState();
  const selectedId =
    list.selectedId || list.activeId || list.workspaces[0]?.id || "";
  const workspace = selectedId
    ? list.workspaces.find((entry) => entry?.id === selectedId)
    : list.workspaces[0];
  const workspaceRoot = String(workspace?.path ?? "").trim();
  if (!workspaceRoot || workspace?.workspaceType === "remote") {
    return { ok: true, skipped: true, reason: "no-local-workspace" };
  }

  const workspacePaths = [];
  for (const entry of list.workspaces) {
    if (entry?.workspaceType === "remote") continue;
    const workspacePath = String(entry?.path ?? "").trim();
    if (workspacePath && !workspacePaths.includes(workspacePath))
      workspacePaths.push(workspacePath);
  }
  if (!workspacePaths.includes(workspaceRoot))
    workspacePaths.unshift(workspaceRoot);

  let bootWorkspace = workspace;
  let bootWorkspaceRoot = workspaceRoot;
  let engine;
  try {
    engine = await runtimeManager.engineStart(workspaceRoot, {
      runtime: "direct",
      workspacePaths,
    });
  } catch (error) {
    const fallback = list.workspaces.find((entry) => {
      const candidatePath = String(entry?.path ?? "").trim();
      return (
        entry?.workspaceType !== "remote" &&
        candidatePath &&
        candidatePath !== workspaceRoot
      );
    });
    const fallbackRoot = String(fallback?.path ?? "").trim();
    if (!fallback || !fallbackRoot) throw error;
    console.warn(
      "[runtime] selected workspace failed during boot; trying fallback workspace",
      {
        selectedWorkspaceId: workspace?.id ?? null,
        fallbackWorkspaceId: fallback.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    const fallbackWorkspacePaths = [
      fallbackRoot,
      ...workspacePaths.filter(
        (entry) => entry !== fallbackRoot && entry !== workspaceRoot,
      ),
    ];
    engine = await runtimeManager.engineStart(fallbackRoot, {
      runtime: "direct",
      workspacePaths: fallbackWorkspacePaths,
    });
    bootWorkspace = fallback;
    bootWorkspaceRoot = fallbackRoot;
    await writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
  await runtimeManager
    .orchestratorWorkspaceActivate({
      workspacePath: bootWorkspaceRoot,
      name: bootWorkspace.name ?? bootWorkspace.displayName ?? null,
    })
    .catch(() => undefined);
  const openrindDesktopServer = assertOpenrindDesktopServerReady(
    await runtimeManager.openrindDesktopServerInfo(),
  );
  return {
    ok: true,
    skipped: false,
    engine,
    openrindDesktopServer,
    workspaceId: bootWorkspace.id ?? null,
  };
}

function ensureRuntimeBootstrap() {
  if (!runtimeBootstrapPromise) {
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch(
      (error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return runtimeBootstrapPromise;
}

function normalizeWorkspaceEntry(input) {
  return {
    id: String(input.id),
    name: String(input.name ?? "Workspace"),
    path: String(input.path ?? ""),
    preset: String(input.preset ?? "starter"),
    workspaceType: input.workspaceType === "remote" ? "remote" : "local",
    remoteType: input.remoteType ?? null,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    openrindDesktopHostUrl: input.openrindDesktopHostUrl ?? null,
    openrindDesktopToken: input.openrindDesktopToken ?? null,
    openrindDesktopClientToken: input.openrindDesktopClientToken ?? null,
    openrindDesktopHostToken: input.openrindDesktopHostToken ?? null,
    openrindDesktopWorkspaceId: input.openrindDesktopWorkspaceId ?? null,
    openrindDesktopWorkspaceName: input.openrindDesktopWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
    sandboxProfile: input.sandboxProfile ?? null,
    sandboxRunId: input.sandboxRunId ?? null,
    sandboxContainerName: input.sandboxContainerName ?? null,
  };
}

async function mutateWorkspaceState(mutator) {
  const current = await readWorkspaceState();
  const next = await mutator({
    ...current,
    workspaces: [...current.workspaces],
  });
  return writeWorkspaceState(next);
}

function resolveOpencodeConfigPath(scope, projectDir) {
  let root;
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    root = projectDir;
  } else if (scope === "global") {
    root = globalOpencodeRoot();
  } else {
    throw new Error("scope must be 'project' or 'global'");
  }

  const jsoncPath = path.join(root, "opencode.jsonc");
  const jsonPath = path.join(root, "opencode.json");
  return { jsoncPath, jsonPath };
}

async function readOpencodeConfig(scope, projectDir) {
  const { jsoncPath, jsonPath } = resolveOpencodeConfigPath(scope, projectDir);
  const chosenPath = (await pathExists(jsoncPath))
    ? jsoncPath
    : (await pathExists(jsonPath))
      ? jsonPath
      : jsoncPath;
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const { jsoncPath, jsonPath } = resolveOpencodeConfigPath(scope, projectDir);
  const targetPath = (await pathExists(jsoncPath))
    ? jsoncPath
    : (await pathExists(jsonPath))
      ? jsonPath
      : jsoncPath;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return execResult(true, `Wrote ${targetPath}`);
}

function resolveCommandsDir(scope, projectDir) {
  if (scope === "workspace") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return path.join(projectDir, ".opencode", "commands");
  }
  if (scope === "global") {
    return path.join(globalOpencodeRoot(), "commands");
  }
  throw new Error("scope must be 'workspace' or 'global'");
}

async function listCommandNames(scope, projectDir) {
  const commandsDir = resolveCommandsDir(scope, projectDir);
  if (!(await isDirectory(commandsDir))) {
    return [];
  }
  const entries = await readdir(commandsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

async function writeCommandFile(scope, projectDir, command) {
  const safeName = sanitizeCommandName(command?.name);
  if (!safeName) {
    throw new Error("command.name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  await mkdir(commandsDir, { recursive: true });
  const filePath = path.join(commandsDir, `${safeName}.md`);
  await writeFile(
    filePath,
    serializeCommandFrontmatter({ ...command, name: safeName }),
    "utf8",
  );
  return execResult(true, `Wrote ${filePath}`);
}

async function deleteCommandFile(scope, projectDir, name) {
  const safeName = sanitizeCommandName(name);
  if (!safeName) {
    throw new Error("name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  const filePath = path.join(commandsDir, `${safeName}.md`);
  if (await pathExists(filePath)) {
    await rm(filePath, { force: true });
  }
  return execResult(true, `Deleted ${filePath}`);
}

async function collectProjectSkillRoots(projectDir) {
  const roots = [];
  let current = path.resolve(projectDir);

  while (true) {
    const opencodeSkills = path.join(current, ".opencode", "skills");
    const legacySkills = path.join(current, ".opencode", "skill");
    const claudeSkills = path.join(current, ".claude", "skills");

    if (await isDirectory(opencodeSkills)) roots.push(opencodeSkills);
    if (await isDirectory(legacySkills)) roots.push(legacySkills);
    if (await isDirectory(claudeSkills)) roots.push(claudeSkills);

    if (await pathExists(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

async function collectGlobalSkillRoots() {
  const roots = [];
  const candidates = [
    path.join(globalOpencodeRoot(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }

  return roots;
}

async function collectSkillRoots(projectDir) {
  const roots = [
    ...(await collectProjectSkillRoots(projectDir)),
    ...(await collectGlobalSkillRoots()),
  ];
  return roots.filter((value, index) => roots.indexOf(value) === index);
}

async function findSkillDirsInRoot(root) {
  const found = [];
  if (!(await isDirectory(root))) return found;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    if (await pathExists(path.join(direct, "SKILL.md"))) {
      found.push(direct);
      continue;
    }

    const nestedEntries = await readdir(direct, { withFileTypes: true }).catch(
      () => [],
    );
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (await pathExists(path.join(nestedDir, "SKILL.md"))) {
        found.push(nestedDir);
      }
    }
  }

  return found;
}

function extractFrontmatterValue(raw, keys) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!keys.includes(key)) continue;
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  return null;
}

function extractTrigger(raw) {
  return extractFrontmatterValue(raw, ["trigger", "when"]);
}

function extractDescription(raw) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    return cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned;
  }
  return null;
}

async function listLocalSkills(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }

  const seen = new Set();
  const out = [];
  for (const root of await collectSkillRoots(projectDir)) {
    for (const skillDir of await findSkillDirsInRoot(root)) {
      const name = path.basename(skillDir);
      if (seen.has(name)) continue;
      seen.add(name);
      let raw = "";
      try {
        raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        raw = "";
      }
      out.push({
        name,
        path: skillDir,
        description: extractDescription(raw) ?? undefined,
        trigger: extractTrigger(raw) ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillFile(projectDir, name) {
  const safeName = validateSkillName(name);
  for (const root of await collectSkillRoots(projectDir)) {
    const direct = path.join(root, safeName, "SKILL.md");
    if (await pathExists(direct)) return direct;

    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, safeName, "SKILL.md");
      if (await pathExists(nested)) return nested;
    }
  }
  return null;
}

async function ensureProjectSkillRoot(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }
  const opencodeRoot = path.join(projectDir, ".opencode");
  const legacy = path.join(opencodeRoot, "skill");
  const modern = path.join(opencodeRoot, "skills");
  if ((await isDirectory(legacy)) && !(await pathExists(modern))) {
    await rename(legacy, modern);
  }
  await mkdir(modern, { recursive: true });
  return modern;
}

function engineDoctor(options = {}) {
  return runtimeManager.engineDoctor(options);
}

function activeWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

async function handleDesktopInvoke(event, command, ...args) {
  switch (command) {
    case "workspaceBootstrap":
      return readWorkspaceState();
    case "workspaceSetSelected":
      return mutateWorkspaceState((state) => {
        const workspaceId = typeof args[0] === "string" ? args[0] : "";
        state.selectedId = workspaceId;
        state.activeId = workspaceId || null;
        return state;
      });
    case "workspaceSetRuntimeActive":
      return mutateWorkspaceState((state) => {
        state.watchedId =
          typeof args[0] === "string" && args[0].trim() ? args[0] : null;
        return state;
      });
    case "workspaceCreate": {
      const input = args[0] ?? {};
      const rawFolderPath = String(input.folderPath ?? "").trim();
      if (!rawFolderPath) throw new Error("folderPath is required");
      const folderPath = await normalizeLocalWorkspacePath(rawFolderPath);
      await mkdir(folderPath, { recursive: true });
      const preset = String(input.preset ?? "starter");
      const workspace = normalizeWorkspaceEntry({
        id: localWorkspaceId(folderPath),
        name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
        displayName: String(
          input.name ?? (path.basename(folderPath) || "Workspace"),
        ),
        path: folderPath,
        preset,
        workspaceType: "local",
        sandboxBackend: input.sandboxBackend ?? null,
        sandboxProfile: input.sandboxProfile ?? null,
      });
      await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
      await writeWorkspaceOpenrindDesktopConfig(
        folderPath,
        defaultWorkspaceOpenrindDesktopConfig(folderPath, preset),
      );
      return mutateWorkspaceState((state) => {
        const workspacePathKey = normalizeWorkspacePathKey(workspace.path);
        state.workspaces = state.workspaces.filter(
          (entry) =>
            entry.id !== workspace.id &&
            normalizeWorkspacePathKey(entry.path) !== workspacePathKey,
        );
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        state.watchedId = workspace.id;
        return state;
      });
    }
    case "workspaceCreateRemote": {
      const input = args[0] ?? {};
      const baseUrl = String(input.baseUrl ?? "").trim();
      if (!baseUrl) throw new Error("baseUrl is required");
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        throw new Error("baseUrl must start with http:// or https://");
      }
      const remoteType =
        input.remoteType === "opencode" ? "opencode" : "openrind-desktop";
      const directory =
        typeof input.directory === "string" && input.directory.trim()
          ? input.directory.trim()
          : null;
      const openrindDesktopHostUrl =
        typeof input.openrindDesktopHostUrl === "string" &&
        input.openrindDesktopHostUrl.trim()
          ? input.openrindDesktopHostUrl.trim()
          : null;
      const openrindDesktopWorkspaceId =
        typeof input.openrindDesktopWorkspaceId === "string" &&
        input.openrindDesktopWorkspaceId.trim()
          ? input.openrindDesktopWorkspaceId.trim()
          : null;
      const id =
        remoteType === "openrind-desktop"
          ? openrindDesktopRemoteWorkspaceId(
              openrindDesktopHostUrl ?? baseUrl,
              openrindDesktopWorkspaceId,
            )
          : remoteWorkspaceId(baseUrl, directory);
      const workspace = normalizeWorkspaceEntry({
        id,
        name: String(
          input.displayName ??
            input.openrindDesktopWorkspaceName ??
            "Remote workspace",
        ),
        displayName: input.displayName ?? null,
        path: directory ?? "",
        preset: "remote",
        workspaceType: "remote",
        remoteType,
        baseUrl,
        directory,
        openrindDesktopHostUrl,
        openrindDesktopToken: input.openrindDesktopToken ?? null,
        openrindDesktopClientToken: input.openrindDesktopClientToken ?? null,
        openrindDesktopHostToken: input.openrindDesktopHostToken ?? null,
        openrindDesktopWorkspaceId,
        openrindDesktopWorkspaceName: input.openrindDesktopWorkspaceName ?? null,
        sandboxBackend: input.sandboxBackend ?? null,
        sandboxProfile: input.sandboxProfile ?? null,
        sandboxRunId: input.sandboxRunId ?? null,
        sandboxContainerName: input.sandboxContainerName ?? null,
      });
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.filter(
          (entry) => entry.id !== workspace.id,
        );
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        return state;
      });
    }
    case "workspaceUpdateRemote": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.map((entry) =>
          entry.id === workspaceId ? { ...entry, ...input } : entry,
        );
        return state;
      });
    }
    case "workspaceUpdateDisplayName": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.map((entry) =>
          entry.id === workspaceId
            ? { ...entry, displayName: input.displayName ?? null }
            : entry,
        );
        return state;
      });
    }
    case "workspaceForget": {
      const workspaceId = String(args[0] ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.filter(
          (entry) => entry.id !== workspaceId,
        );
        if (state.selectedId === workspaceId) state.selectedId = "";
        if (state.activeId === workspaceId) state.activeId = null;
        if (state.watchedId === workspaceId) state.watchedId = null;
        return state;
      });
    }
    case "workspaceAddAuthorizedRoot": {
      const input = args[0] ?? {};
      const workspacePath = String(input.workspacePath ?? "").trim();
      const authorizedRoot = String(
        input.folderPath ?? input.authorizedRoot ?? "",
      ).trim();
      if (!workspacePath || !authorizedRoot) {
        throw new Error("workspacePath and folderPath are required");
      }
      const config = await readWorkspaceOpenrindDesktopConfig(workspacePath);
      if (!Array.isArray(config.authorizedRoots)) {
        config.authorizedRoots = [];
      }
      if (!config.authorizedRoots.includes(authorizedRoot)) {
        config.authorizedRoots.push(authorizedRoot);
      }
      return writeWorkspaceOpenrindDesktopConfig(workspacePath, config);
    }
    case "workspaceOpenrindDesktopRead":
      return readWorkspaceOpenrindDesktopConfig(
        String(args[0]?.workspacePath ?? "").trim(),
      );
    case "workspaceOpenrindDesktopWrite":
      return writeWorkspaceOpenrindDesktopConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? defaultWorkspaceOpenrindDesktopConfig(""),
      );
    case "workspaceExportConfig": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const outputPath = String(input.outputPath ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (!outputPath) throw new Error("outputPath is required");
      const state = await readWorkspaceState();
      const workspace = state.workspaces.find(
        (entry) => entry.id === workspaceId,
      );
      if (!workspace) throw new Error("Unknown workspaceId");
      return exportWorkspaceConfig({ workspace, outputPath });
    }
    case "workspaceImportConfig": {
      const input = args[0] ?? {};
      const archivePath = String(input.archivePath ?? "").trim();
      const targetDirRaw = String(input.targetDir ?? "").trim();
      if (!archivePath) throw new Error("archivePath is required");
      if (!targetDirRaw) throw new Error("targetDir is required");
      const targetDir = await normalizeLocalWorkspacePath(targetDirRaw);
      const imported = await importWorkspaceConfig({
        archivePath,
        targetDir,
        name: input.name ?? null,
      });
      const workspace = normalizeWorkspaceEntry({
        id: localWorkspaceId(targetDir),
        name: imported.workspaceName,
        displayName: null,
        path: targetDir,
        preset: imported.preset,
        workspaceType: "local",
      });
      return mutateWorkspaceState((state) => {
        const workspacePathKey = normalizeWorkspacePathKey(workspace.path);
        state.workspaces = state.workspaces.filter(
          (entry) =>
            entry.id !== workspace.id &&
            normalizeWorkspacePathKey(entry.path) !== workspacePathKey,
        );
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        state.watchedId = workspace.id;
        return state;
      });
    }
    case "opencodeCommandList":
      return listCommandNames(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
      );
    case "opencodeCommandWrite":
      return writeCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        args[0]?.command ?? {},
      );
    case "opencodeCommandDelete":
      return deleteCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        String(args[0]?.name ?? "").trim(),
      );
    case "engineStart": {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      return runtimeManager.engineStart(projectDir, options);
    }
    case "prepareFreshRuntime":
      return runtimeManager.prepareFreshRuntime();
    case "runtimeBootstrap":
      return ensureRuntimeBootstrap();
    case "runtimeStatus":
      return runtimeManager.runtimeStatus();
    case "engineStop":
      return runtimeManager.engineStop();
    case "engineRestart":
      return runtimeManager.engineRestart(args[0] ?? {});
    case "engineInfo":
      return runtimeManager.engineInfo();
    case "engineDoctor":
      return engineDoctor(args[0]);
    case "engineInstall":
      return runtimeManager.engineInstall();
    case "orchestratorStatus": {
      return runtimeManager.orchestratorStatus();
    }
    case "orchestratorWorkspaceActivate": {
      return runtimeManager.orchestratorWorkspaceActivate(args[0] ?? {});
    }
    case "orchestratorInstanceDispose":
      return runtimeManager.orchestratorInstanceDispose(
        String(args[0] ?? "").trim(),
      );
    case "appBuildInfo":
      return {
        version: app.getVersion(),
        gitSha: process.env.OPENRIND_DESKTOP_GIT_SHA ?? null,
        buildEpoch: process.env.OPENRIND_DESKTOP_BUILD_EPOCH ?? null,
        openrindDesktopDevMode: process.env.OPENRIND_DESKTOP_DEV_MODE === "1",
      };
    case "getDesktopBootstrapConfig":
      return getDesktopBootstrapConfig();
    case "setDesktopBootstrapConfig":
      return setDesktopBootstrapConfig(args[0] ?? {});
    case "nukeOpenrindDesktopAndOpencodeConfigAndExit": {
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.exit(0);
      return undefined;
    }
    case "orchestratorStartDetached": {
      return runtimeManager.orchestratorStartDetached(args[0] ?? {});
    }
    case "sandboxDoctor":
      return runtimeManager.sandboxDoctor();
    case "sandboxStop":
      return runtimeManager.sandboxStop(String(args[0] ?? "").trim());
    case "sandboxCleanupOpenrindDesktopContainers":
      return runtimeManager.sandboxCleanupOpenrindDesktopContainers();
    case "sandboxDebugProbe":
      return runtimeManager.sandboxDebugProbe();
    case "openrindDesktopServerInfo":
      return runtimeManager.openrindDesktopServerInfo();
    case "openrindDesktopServerRestart":
      return runtimeManager.openrindDesktopServerRestart(args[0] ?? {});
    case "pickDirectory": {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple
        ? result.filePaths
        : (result.filePaths[0] ?? null);
    }
    case "pickFile": {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openFile", "multiSelections"]
        : ["openFile"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple
        ? result.filePaths
        : (result.filePaths[0] ?? null);
    }
    case "saveFile": {
      const options = args[0] ?? {};
      const result = await dialog.showSaveDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
    }
    case "importSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const sourceDir = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      if (!projectDir || !sourceDir) {
        throw new Error("projectDir and sourceDir are required");
      }
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const name = validateSkillName(path.basename(sourceDir));
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(
            false,
            "",
            `Skill already exists at ${destination}`,
          );
        }
        await rm(destination, { recursive: true, force: true });
      }
      await cp(sourceDir, destination, { recursive: true });
      return execResult(true, `Imported skill to ${destination}`);
    }
    case "installSkillTemplate": {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const content = String(args[2] ?? "");
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(
            false,
            "",
            `Skill already exists at ${destination}`,
          );
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), content, "utf8");
      return execResult(true, `Installed skill to ${destination}`);
    }
    case "listLocalSkills":
      return listLocalSkills(String(args[0] ?? "").trim());
    case "readLocalSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
    }
    case "writeLocalSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(
        true,
        `Saved skill ${path.basename(path.dirname(skillPath))}`,
      );
    }
    case "uninstallSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(
          false,
          "",
          "Skill not found in .opencode/skills or .claude/skills",
        );
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
    }
    case "updaterEnvironment": {
      const executablePath = app.isPackaged
        ? app.getPath("exe")
        : process.execPath;
      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath:
          process.platform === "darwin"
            ? path.resolve(executablePath, "../../..")
            : path.dirname(executablePath),
      };
    }
    case "readOpencodeConfig":
      return readOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
      );
    case "writeOpencodeConfig":
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
    case "resetOpenrindDesktopState": {
      await rm(workspaceStatePath(), { force: true });
      await rm(desktopBootstrapPath(), { force: true });
      return undefined;
    }
    case "resetOpencodeCache":
      return { removed: [], missing: [], errors: [] };
    case "opencodeMcpAuth":
      return runtimeManager.opencodeMcpAuth(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
      );
    case "setWindowDecorations":
      return undefined;
    case "__openPath": {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      return shell.openPath(target);
    }
    case "__revealItemInDir": {
      const target = String(args[0] ?? "").trim();
      if (!target) return undefined;
      shell.showItemInFolder(target);
      return undefined;
    }
    case "__fetch": {
      const url = String(args[0] ?? "").trim();
      const init = args[1] ?? {};
      if (!url) throw new Error("URL is required.");
      // SSRF-safe fetch: node:https with a pinned, validating DNS lookup so the
      // address that passes validation is the exact address connected to (no
      // DNS-rebinding TOCTOU), and redirects are followed manually so every hop
      // is re-validated. Loopback traffic never reaches here — desktopFetch
      // short-circuits localhost to a direct renderer fetch.
      return await mainProcessFetch(url, init);
    }
    case "__homeDir":
      return os.homedir();
    case "__joinPath":
      return path.join(...args.map((value) => String(value ?? "")));
    case "__setZoomFactor": {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
    }
    case "openshellDoctor":
      return openshellDoctor();
    case "openshellListSandboxes":
      return openshellClient.listSandboxes();
    case "openshellGatewayStatus":
      return openshellClient.getGatewayStatus();
    case "openshellGatewayRestart": {
      // The gateway lifecycle has rotated across releases — see
      // installer.mjs:bringUpGateway for the full story. Order of attempts:
      //   1. Legacy `openshell gateway start [--recreate|--detach]`.
      //   2. systemd user service restart (0.0.37+, the current shape).
      //   3. Direct `docker restart` of an openshell-cluster* container
      //      (recovery path for hand-rolled deployments).
      // Each attempt is logged with its exit code so the final error
      // message tells the user exactly what was tried and what each
      // path reported.
      const cliInfo = await openshellCli.getCliInfo();
      const attempts = [];
      const tryWsl = async (label, args, opts = {}) => {
        const r = await wslRun(
          [
            "-d",
            OPENSHELL_DISTRO_NAME,
            ...(opts.user ? ["--user", opts.user] : []),
            "--",
            ...args,
          ],
          { timeout: opts.timeout ?? 60_000 },
        );
        attempts.push({ label, r });
        return r.exitCode === 0;
      };

      // Path 1 — legacy gateway start verb (will silently no-op on 0.0.37+).
      if (await openshellCli.hasSubcommand("gateway", "start")) {
        if (
          await tryWsl("openshell gateway start --recreate", [
            "openshell",
            "gateway",
            "start",
            "--recreate",
          ])
        )
          return { ok: true, recoveredVia: "gateway start --recreate" };
        if (
          await tryWsl("openshell gateway start --detach", [
            "openshell",
            "gateway",
            "start",
            "--detach",
          ])
        )
          return { ok: true, recoveredVia: "gateway start --detach" };
        if (
          await tryWsl("openshell gateway start", [
            "openshell",
            "gateway",
            "start",
          ])
        )
          return { ok: true, recoveredVia: "gateway start" };
      }

      // Path 2 — systemd user service (the current shape per install.sh).
      if (
        await tryWsl(
          "systemctl --user restart openshell-gateway",
          ["systemctl", "--user", "restart", "openshell-gateway"],
          { user: "banker", timeout: 60_000 },
        )
      ) {
        return {
          ok: true,
          recoveredVia: "systemctl --user restart openshell-gateway",
        };
      }

      // Path 3 — docker fallback for hand-rolled cluster containers.
      const list = await wslRun(
        [
          "-d",
          OPENSHELL_DISTRO_NAME,
          "--",
          "bash",
          "-c",
          "docker ps -a --filter 'name=openshell' --format '{{.Names}}'",
        ],
        { timeout: 15_000 },
      ).catch((err) => ({
        exitCode: -1,
        stdout: "",
        stderr: err?.message ?? String(err),
      }));

      const names = list.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 1) {
        if (
          await tryWsl(`docker restart ${names[0]}`, [
            "docker",
            "restart",
            names[0],
          ])
        ) {
          return { ok: true, recoveredVia: `docker restart ${names[0]}` };
        }
      }

      const detail = attempts
        .map(
          ({ label, r }) =>
            `${label} → exit ${r.exitCode}: ${(r.stderr || r.stdout || "").trim().slice(0, 200) || "(no output)"}`,
        )
        .join(" | ");
      throw new Error(
        `Could not restart the OpenShell gateway. CLI ${cliInfo.version ?? "(unknown)"}. ` +
          `Tried: ${detail || "(no attempts)"}. ` +
          `If this persists, open Settings → Sandbox → Reset distro.`,
      );
    }
    case "openshellListPolicies": {
      // Lists the bundled policy YAML files. Returns just filenames for
      // now; the UI doesn't need richer metadata yet, and the YAML
      // schema validation happens inside the openshell binary at
      // sandbox-create time.
      const dir = resolveOpenShellPoliciesDir();
      try {
        const entries = await readdir(dir);
        return entries
          .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
          .sort();
      } catch {
        return [];
      }
    }
    case "openshellOpenPoliciesFolder": {
      const dir = resolveOpenShellPoliciesDir();
      try {
        const err = await shell.openPath(dir);
        if (err) throw new Error(err);
        return { ok: true, path: dir };
      } catch (err) {
        throw new Error(
          `Could not open policy folder at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    case "openshellInstallStart": {
      if (openshellInstaller.promise) {
        return { status: "running", lastEvent: openshellInstaller.lastEvent };
      }
      // UAC heads-up: only meaningful on Windows and only when WSL is not
      // already installed (= first run). Phase 6's installer detects that
      // case itself and elevates inline; this dialog gives the banker a
      // clear "you'll see a UAC prompt" warning before it fires.
      if (process.platform === "win32") {
        await dialog.showMessageBox(activeWindowFromEvent(event), {
          type: "info",
          title: "OpenShell setup",
          message:
            "OpenShell installs WSL2, Ubuntu, Docker, and the OpenShell CLI.",
          detail:
            "Windows will ask for admin permission once. Your laptop may also ask for a " +
            "BitLocker recovery key after the first reboot — get this from IT before " +
            "continuing if you do not have it.",
          buttons: ["Continue", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
      }
      const ac = new AbortController();
      openshellInstaller.abortController = ac;
      openshellInstaller.status = "running";
      openshellInstaller.lastEvent = { phase: "preflight", status: "starting" };
      openshellInstaller.promise = installOpenShellStack({
        rootfsPath: resolveOpenShellRootfsPath(),
        signal: ac.signal,
        onPhase: (phase, status, err) =>
          emitOpenShellInstallProgress({
            phase,
            status,
            message: err?.message ?? null,
          }),
        onProgress: (evt) => emitOpenShellInstallProgress(evt),
      })
        .then((result) => {
          openshellInstaller.status = result.status;
          emitOpenShellInstallProgress({
            phase: "done",
            status: result.status,
          });
          return result;
        })
        .catch((err) => {
          openshellInstaller.status = "failed";
          emitOpenShellInstallProgress({
            phase: "error",
            status: "failed",
            error: err?.message ?? String(err),
          });
        })
        .finally(() => {
          openshellInstaller.promise = null;
          openshellInstaller.abortController = null;
        });
      return { status: "running" };
    }
    case "openshellInstallStatus": {
      const persisted = await loadOpenShellInstallerState();
      return {
        status: openshellInstaller.status,
        lastEvent: openshellInstaller.lastEvent,
        state: persisted,
      };
    }
    case "openshellInstallCancel": {
      if (!openshellInstaller.promise) {
        return { status: openshellInstaller.status };
      }
      openshellInstaller.abortController?.abort();
      return { status: "cancelling" };
    }
    case "openrindGatewayCheckout": {
      const apiKey = await openrindCredentials.getCredential("openrindGatewayApiKey");
      if (!apiKey) throw new Error("Gateway API Key not set.");
      const gatewayUrl = process.env.OPENRIND_GATEWAY_URL || "https://app.openrind.com";
      // To create a checkout session, we need the user's web session on the gateway,
      // but wait! Since they are logged in on the web, if we just open the gateway billing setup page,
      // or can we trigger checkout using the API key?
      // Yes! Our NextJS API endpoint `POST /api/individual/billing/checkout` requires `getUser()` which is a web session.
      // If we call it via API Key from the desktop app, how will NextJS know who the user is?
      // Ah! We can authenticate the request with the API key instead of NextAuth getUser()!
      // Yes! In `stringcost/web/app/api/individual/billing/checkout/route.ts`, we can support Auth headers!
      // If the Authorization header has a Bearer API Key, we resolve the individual organization via that API key!
      // That is incredibly robust.
      const response = await fetch(`${gatewayUrl}/api/individual/billing/checkout`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `Failed to create checkout session: ${response.status}`);
      }
      const data = await response.json();
      if (data.url) {
        await openExternalSafe(data.url);
      }
      return data;
    }
    case "openrindGatewayGetStats": {
      const apiKey = await openrindCredentials.getCredential("openrindGatewayApiKey");
      if (!apiKey) throw new Error("Gateway API Key not set.");
      const gatewayUrl = process.env.OPENRIND_GATEWAY_URL || "https://app.openrind.com";
      const response = await fetch(`${gatewayUrl}/api/individual/billing/stats`, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errorMessage = errBody?.error || errBody?.message || `Failed to fetch stats: ${response.status} ${response.statusText}`;
        throw new Error(`[HTTP ${response.status}] ${errorMessage}`);
      }
      return await response.json();
    }
    case "openrindGatewayExchangeToken": {
      const { token } = args[0] ?? {};
      if (!token) throw new Error("Token is required.");

      const gatewayUrl = process.env.OPENRIND_GATEWAY_URL || "https://app.openrind.com";
      const response = await fetch(`${gatewayUrl}/api/auth/key-exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errorMessage = errBody?.error || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(`[HTTP ${response.status}] ${errorMessage}`);
      }

      const data = await response.json();
      
      // Compare with the currently set API key to see if we should overwrite/replace it
      const currentKey = await openrindCredentials.getCredential("openrindGatewayApiKey");
      
      const isNewAccount = !currentKey || (data.apiKey && data.apiKey !== currentKey);
      
      if (isNewAccount && data.apiKey) {
        // Save the new API key to the keystore
        await openrindCredentials.setCredential("openrindGatewayApiKey", data.apiKey);
      }

      return {
        success: true,
        apiKey: data.apiKey,
        organizationId: data.organizationId,
        status: data.status,
        isNewAccount,
      };
    }
    case "openrindCredentialStatus":
      return openrindCredentials.getCredentialStatus();
    case "openrindSetCredential": {
      const input = args[0] ?? {};
      const key = String(input.key ?? "").trim();
      const value = String(input.value ?? "");
      await openrindCredentials.setCredential(key, value);
      return openrindCredentials.getCredentialStatus();
    }
    case "openrindClearCredential": {
      const key = String(args[0] ?? "").trim();
      await openrindCredentials.clearCredential(key);
      return openrindCredentials.getCredentialStatus();
    }
    case "voiceTranscribe": {
      // Cloud speech-to-text for the composer/terminal mic when the voice
      // engine is set to ElevenLabs. The renderer captures audio and posts the
      // raw bytes here; the API key stays in the main process (never shipped to
      // the renderer) and this also sidesteps browser CORS to ElevenLabs.
      const input = args[0] ?? {};
      const audio = input.audio;
      const mimeType =
        typeof input.mimeType === "string" && input.mimeType
          ? input.mimeType
          : "audio/webm";
      if (!audio) throw new Error("No audio was provided for transcription.");
      const apiKey =
        await openrindCredentials.getCredential("elevenLabsApiKey");
      if (!apiKey) {
        throw new Error(
          "ElevenLabs API key not configured. Add it in Settings → Sandbox.",
        );
      }
      const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
      const form = new FormData();
      form.append("model_id", "scribe_v1");
      form.append("file", new Blob([bytes], { type: mimeType }), "audio.webm");
      const response = await fetch(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          // Do NOT set Content-Type — fetch derives the multipart boundary from
          // the FormData body automatically.
          headers: { "xi-api-key": apiKey },
          body: form,
        },
      );
      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          // ignore
        }
        throw new Error(
          `ElevenLabs transcription failed (${response.status} ${response.statusText}). ${detail}`.trim(),
        );
      }
      const result = await response.json();
      return { text: typeof result?.text === "string" ? result.text : "" };
    }
    case "openrindTestDatabase": {
      // Runs psql via a transient postgres:16-alpine container inside
      // the openrind-desktop-openshell distro. Lazy-pulls the image on first
      // run (~6 MB). Returns reachable=true on a successful SELECT 1,
      // throws with the stderr otherwise so the UI can surface why.
      await assertOpenShellReady();
      return openrindShell.probeDatabaseUrl();
    }
    case "openrindStartSession": {
      // Per spec O3+O4 contract:
      //   1. Derive sandbox name from workspaceId (stable across machines).
      //   2. createOpenrindShellSandbox: create or short-circuit if it exists,
      //      streams pull + create progress via openrind-shell:session-progress.
      //   3. Launch the OS terminal pointed at `openshell sandbox connect <name>`.
      //   4. Return {sandboxName, profile, existed, terminal} to the renderer.
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const profile = String(input.profile ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (profile !== "openrind-shell-claude" && profile !== "openrind-shell-openclaw") {
        throw new Error(`Unsupported Openrind Shell profile: ${profile}`);
      }
      await assertOpenShellReady();
      const sandboxName = deriveOpenrindShellSandboxName(workspaceId);
      emitOpenrindShellSessionProgress({
        sandboxName,
        phase: "starting",
        message: "Preparing Openrind Shell sandbox...",
      });
      const result = await openrindShell.createOpenrindShellSandbox({
        name: sandboxName,
        profile,
        onProgress: (evt) =>
          emitOpenrindShellSessionProgress({
            sandboxName,
            phase: evt.phase,
            message: evt.message,
          }),
      });
      emitOpenrindShellSessionProgress({
        sandboxName,
        phase: "launching-terminal",
        message: "Opening session in external terminal...",
      });
      let terminal;
      try {
        terminal = await launchExternalTerminalToSandbox(sandboxName);
      } catch (err) {
        // Sandbox is up but we couldn't open a terminal. Don't fail the
        // whole session — surface the issue so the user can launch
        // their own terminal with the documented command.
        emitOpenrindShellSessionProgress({
          sandboxName,
          phase: "terminal-error",
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          ...result,
          sandboxName,
          terminal: null,
          terminalError: err instanceof Error ? err.message : String(err),
        };
      }
      emitOpenrindShellSessionProgress({
        sandboxName,
        phase: "ready",
        message: `Session running in ${terminal.launched}.`,
      });
      return { ...result, sandboxName, terminal };
    }
    case "openrindListSessions":
    case "openrindListSandboxes": {
      // Returns the subset of `openshell sandbox list` whose names start with
      // the openrind-shell- prefix — the sandboxes Openrind Desktop created. Uses the text
      // parser in openrind-shell.mjs because CLI 0.0.45 rejects `sandbox list --json`,
      // which left openshellClient.listSandboxes() (and this handler) empty.
      // Failures PROPAGATE to the renderer so a cold gateway at boot reads as
      // "still loading, retry" rather than "no sandboxes exist".
      const list = await openrindShell.listSandboxes();
      return Array.isArray(list)
        ? list.filter(
            (s) =>
              typeof s?.name === "string" && s.name.startsWith("openrind-shell-"),
          )
        : [];
    }
    case "openrindEndSession": {
      // Per spec: Openrind Shell sandboxes persist across sessions for the
      // Postgres-backed restore story. "End session" is a no-op marker;
      // closing the external terminal is what ends user interaction.
      // We still emit a status event so the UI can update.
      const name = String(args[0] ?? "").trim();
      emitOpenrindShellSessionProgress({
        sandboxName: name,
        phase: "closed",
        message: "Session closed.",
      });
      return { status: "closed", sandboxName: name };
    }
    case "openrindDeleteSandbox": {
      // Explicit destructive teardown. Gated by a renderer-side
      // confirmation in Phase O8 docs; here we just execute.
      const name = String(args[0] ?? "").trim();
      if (!name) throw new Error("sandboxName is required");
      // Sessions are concurrent — several PTYs may target this sandbox
      // (the renderer only closes its own). Kill them all up front so no
      // orphaned wsl child lingers on a tunnel to a deleted container, and
      // drop any queued fresh-open bookkeeping for the name.
      openrindPty.closeSessionsForSandbox(name);
      openrindFreshOpenChains.delete(name);
      openrindMarkerPending.delete(name);
      const r = await openrindShell.deleteOpenrindShellSandbox(name);
      if (r.exitCode !== 0) {
        throw new Error(
          `openshell sandbox delete failed: ${(r.stderr || r.stdout).trim()}`,
        );
      }
      emitOpenrindShellSessionProgress({
        sandboxName: name,
        phase: "deleted",
        message: "Sandbox deleted.",
      });
      return { status: "deleted", sandboxName: name };
    }
    case "openrindDeriveSandboxName": {
      const workspaceId = String(args[0] ?? "").trim();
      return deriveOpenrindShellSandboxName(workspaceId);
    }
    case "openrindHostBuild": {
      // LEGACY: previously fed xterm.js's `windowsPty` (ConPTY) option. The PTY
      // transport no longer uses ConPTY (see openrind-shell-pty.mjs), so the
      // renderer no longer calls this. Kept as a harmless no-op probe.
      if (process.platform !== "win32") return 0;
      return Number(os.release().split(".")[2]) || 0;
    }
    case "openrindPtyOpen": {
      // Renderer xterm.js requests a PTY to an existing sandbox. We spawn
      // `wsl -d openrind-desktop-openshell -- bash -c 'exec openshell sandbox
      // connect <name>'` over PLAIN PIPES (no ConPTY); the container-side
      // openrind-pty-bridge.py owns the real PTY the agent renders to, and we
      // forward its raw bytes via the openrind-shell:pty-data event channel.
      const input = args[0] ?? {};
      const sandboxName = String(input.sandboxName ?? "").trim();
      if (!sandboxName) throw new Error("sandboxName is required");
      const cols = Number.isFinite(input.cols) ? input.cols : undefined;
      const rows = Number.isFinite(input.rows) ? input.rows : undefined;
      // Openrind Desktop session this PTY should run the agent conversation for.
      // Optional: absent ⇒ the agent's default conversation (legacy behavior).
      const agentSessionId = String(input.sessionId ?? "").trim() || null;
      const profile = String(input.profile ?? "").trim();

      // Read credentials from safeStorage and forward them into the sandbox
      // via WSLENV. This is essential so the `openrind-shell` entrypoint can
      // auto-configure Claude Code's Anthropic provider on first run without
      // showing an interactive "enter API key" prompt that the user can't
      // see or respond to (especially when the terminal is still sizing up).
      const extraEnv = await buildOpenrindShellPtyEnv(cols, rows);

      // Adopt-or-open via the per-sandbox serial chain: fresh connects bind
      // the agent to the selected session through the shared marker file,
      // and concurrent sessions in one sandbox must consume it one at a time.
      const result = await openOpenrindShellPtySession({
        sandboxName,
        cols,
        rows,
        extraEnv,
        agentSessionId,
        profile,
      });
      openrindPty.attachHandlers(result.id, {
        onData: (data) => emitOpenrindShellPtyData(result.id, data),
        onExit: (exitCode, signal) =>
          emitOpenrindShellPtyExit(result.id, exitCode, signal),
      });
      return result;
    }
    case "openrindPtyAttachOrOpen": {
      // Lossless re-attach. If a PTY for this sandbox is still alive in the
      // main process (renderer navigated away earlier but we kept it via
      // openrindPtyDetach), re-wire its output to the current window and
      // return the buffered scrollback so the renderer can replay it into a
      // fresh xterm — no re-bootstrap, no Claude Code relaunch. Otherwise
      // fall back to spawning a new PTY exactly like openrindPtyOpen.
      const input = args[0] ?? {};
      const sandboxName = String(input.sandboxName ?? "").trim();
      if (!sandboxName) throw new Error("sandboxName is required");
      const cols = Number.isFinite(input.cols) ? input.cols : undefined;
      const rows = Number.isFinite(input.rows) ? input.rows : undefined;
      const agentSessionId = String(input.sessionId ?? "").trim() || null;
      const profile = String(input.profile ?? "").trim();

      // Sessions are concurrent — look up by (sandbox, session) so another
      // session's live PTY is never grabbed (or disturbed). A different
      // session's work keeps running in the background; this session gets
      // its own PTY via the fresh-open path below when it has none.
      const existing = openrindPty.findSessionBySandboxAndAgent(
        sandboxName,
        agentSessionId,
      );
      if (existing) {
        // Do NOT call attachHandlers here — the renderer hasn't set
        // sessionIdRef yet, so any pty-data events emitted now would be
        // dropped. The renderer will call openrindPtyAttach (phase 2) after
        // setting sessionIdRef and replaying buffered scrollback.
        //
        // Do NOT resize here either: the buffered bytes are the agent's raw
        // PTY output recorded at the CURRENT pty size, positioned via absolute
        // moves + hard wraps at that width. The renderer must replay them into
        // an xterm of exactly this geometry (cols/rows below) — replaying a
        // 120-col recording into, say, 118 cols mis-wraps every full-width row
        // and strands mangled fragments. After phase 2 the renderer fits to
        // the real pane size; that resize frame is what makes the agent
        // repaint a full clean frame at the new geometry.
        return {
          id: existing.id,
          buffered: openrindPty.getBuffer(existing.id),
          cols: existing.size.cols,
          rows: existing.size.rows,
          reused: true,
          exited: Boolean(existing.exitInfo),
        };
      }

      const extraEnv = await buildOpenrindShellPtyEnv(cols, rows);
      const result = await openOpenrindShellPtySession({
        sandboxName,
        cols,
        rows,
        extraEnv,
        agentSessionId,
        profile,
      });
      openrindPty.attachHandlers(result.id, {
        onData: (data) => emitOpenrindShellPtyData(result.id, data),
        onExit: (exitCode, signal) =>
          emitOpenrindShellPtyExit(result.id, exitCode, signal),
      });
      return { id: result.id, buffered: "", reused: false, exited: false };
    }
    case "openrindPtyAttach": {
      // Phase 2 of lossless re-attach: the renderer has already set
      // sessionIdRef.current and replayed buffered scrollback; now wire the
      // live PTY output stream so no events are dropped.
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.attachHandlers(id, {
        onData: (data) => emitOpenrindShellPtyData(id, data),
        onExit: (exitCode, signal) => emitOpenrindShellPtyExit(id, exitCode, signal),
      });
    }
    case "openrindPtyDetach": {
      // Renderer is unmounting on navigation — keep the wsl child + output
      // buffer alive so returning to the workspace is instant and lossless.
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.detachSession(id);
    }
    case "openrindShellUpload": {
      const sandboxName = String(args[0] ?? "").trim();
      const base64Data = String(args[1] ?? "");
      const filename = String(args[2] ?? "").trim();
      if (!sandboxName || typeof base64Data !== "string" || !filename) {
        throw new Error("sandboxName, base64Data, and filename are required");
      }
      if (/[/\\]/.test(filename) || filename.includes("..")) {
        throw new Error("Invalid filename");
      }

      // We upload to /home/agent/inbox so that the sync daemon picks it up and
      // it persists in the workspace.
      const destDir = `/home/agent/inbox`;
      const destPath = `${destDir}/${filename}`;

      // We use a multi-step bash command to safely construct the file.
      // 1. Write the raw base64 data to a text file using `cat`
      // 2. Decode the text file into the binary file
      // 3. Ensure destination dir exists in the sandbox
      // 4. Run openshell sandbox upload
      // 5. Cleanup
      const tmpTxt = `/tmp/openrind_upload_${Date.now()}_tmp.txt`;
      const tmpBin = `/tmp/openrind_upload_${Date.now()}_${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

      const bashCmd = [
        `trap 'rm -f ${openrindShell.shellQuote(tmpTxt)} ${openrindShell.shellQuote(tmpBin)}' EXIT`,
        "mkdir -p /tmp",
        `cat > ${openrindShell.shellQuote(tmpTxt)}`,
        `base64 -d < ${openrindShell.shellQuote(tmpTxt)} > ${openrindShell.shellQuote(tmpBin)}`,
        `openshell sandbox exec --name ${openrindShell.shellQuote(sandboxName)} -- bash -c "mkdir -p ${openrindShell.shellQuote(destDir)}"`,
        `openshell sandbox upload ${openrindShell.shellQuote(sandboxName)} ${openrindShell.shellQuote(tmpBin)} ${openrindShell.shellQuote(destPath)}`
      ].join(" && ");

      const result = await wslRun([
        "-d", OPENSHELL_DISTRO_NAME,
        "--",
        "bash", "-c", bashCmd
      ], {
        stdin: base64Data
      });
      if (result.exitCode !== 0) {
        throw new Error(`openshell sandbox upload failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
      }
      return true;
    }
    case "openrindShellDeleteFile": {
      const sandboxName = String(args[0] ?? "").trim();
      const filename = String(args[1] ?? "").trim();
      if (!sandboxName || !filename) {
        throw new Error("sandboxName and filename are required");
      }
      if (/[/\\]/.test(filename) || filename.includes("..")) {
        throw new Error("Invalid filename");
      }
      const destPath = `/home/agent/inbox/${filename}`;
      const bashCmd = `rm -f ${openrindShell.shellQuote(destPath)}`;

      const result = await wslRun([
        "-d", OPENSHELL_DISTRO_NAME,
        "--",
        "openshell", "sandbox", "exec", "--name", sandboxName,
        "--", "bash", "-c", bashCmd
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`openshell exec failed with exit code ${result.exitCode}`);
      }
      return true;
    }
    case "openrindPtyWrite": {
      const input = args[0] ?? {};
      const id = String(input.sessionId ?? "").trim();
      const data = String(input.data ?? "");
      if (!id) throw new Error("sessionId is required");
      return openrindPty.writeSession(id, data);
    }
    case "openrindPtyResize": {
      const input = args[0] ?? {};
      const id = String(input.sessionId ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.resizeSession(
        id,
        Number(input.cols),
        Number(input.rows),
      );
    }
    case "openrindPtyPause": {
      // Renderer-driven backpressure: xterm's parse queue is above its high
      // water mark, so stop draining the bridge's stdout until it drains.
      // Without this a flooding TUI (an agent streaming a long diff, a `find /`)
      // outruns the parser and the unparsed queue grows without bound.
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.pauseSession(id);
    }
    case "openrindPtyResume": {
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.resumeSession(id);
    }
    case "openrindPtyDumpBuffer": {
      // Diagnostic: write the raw PTY byte stream to disk so a rendering bug
      // can be reproduced (or ruled out) outside xterm.js. See
      // dumpOpenrindShellPtyBuffer.
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      const result = await dumpOpenrindShellPtyBuffer(id);
      try {
        shell.showItemInFolder(result.rawPath);
      } catch {
        // Headless / no file manager — the returned paths are still valid.
      }
      return result;
    }
    case "openrindPtyClose": {
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openrindPty.closeSession(id);
    }
    case "openrindPtyList":
      return openrindPty.listSessions();

    case "openrindEnsureSandbox": {
      // Same as openrindStartSession but WITHOUT launching an external
      // terminal — the renderer's xterm.js component connects via the
      // PTY IPC handlers instead. Returns {sandboxName, existed, profile}.
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const profile = String(input.profile ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (profile !== "openrind-shell-claude" && profile !== "openrind-shell-openclaw") {
        throw new Error(`Unsupported Openrind Shell profile: ${profile}`);
      }
      await assertOpenShellReady();
      const sandboxName = deriveOpenrindShellSandboxName(workspaceId);
      emitOpenrindShellSessionProgress({
        sandboxName,
        phase: "ensuring",
        message: "Ensuring Openrind Shell sandbox is up...",
      });
      const result = await openrindShell.createOpenrindShellSandbox({
        name: sandboxName,
        profile,
        onProgress: (evt) =>
          emitOpenrindShellSessionProgress({
            sandboxName,
            phase: evt.phase,
            message: evt.message,
          }),
      });
      emitOpenrindShellSessionProgress({
        sandboxName,
        phase: "ready",
        message: result.existed
          ? `Reconnecting to ${sandboxName}.`
          : `Sandbox ${sandboxName} ready.`,
      });
      return { ...result, sandboxName };
    }
    case "openrindPopOutTerminal": {
      // Renderer's "Pop out to external terminal" button. Opens a
      // second connection to the same sandbox in a new OS terminal
      // window — additive to the in-app xterm.js, not a replacement.
      const sandboxName = String(args[0] ?? "").trim();
      if (!sandboxName) throw new Error("sandboxName is required");
      try {
        const terminal = await launchExternalTerminalToSandbox(sandboxName);
        return terminal;
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    }
    case "openshellResetDistro": {
      // Per spec §5 row "Distro corrupts (rare but happens)". Tear the
      // distro down completely so the installer can re-import from the
      // bundled rootfs on next launch. Destructive — gate behind an
      // explicit confirmation dialog.
      const choice = await dialog.showMessageBox(activeWindowFromEvent(event), {
        type: "warning",
        title: "Reset OpenShell distro?",
        message:
          "This wipes the openrind-desktop-openshell WSL distro and clears installer state.",
        detail:
          "Any data inside the distro (Docker images, OpenShell sandboxes, downloaded packages) " +
          "is lost. Your Openrind Desktop workspaces on the Windows side are untouched. " +
          "The next launch will re-run the setup wizard from scratch.",
        buttons: ["Reset distro", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response !== 0) {
        return { status: "cancelled" };
      }
      // Terminate then unregister. --terminate is required first because
      // --unregister refuses to act on a running distro.
      try {
        await wslRun(["-t", OPENSHELL_DISTRO_NAME], { timeout: 15_000 });
      } catch {
        // Distro may already be stopped.
      }
      try {
        await wslRun(["--unregister", OPENSHELL_DISTRO_NAME], {
          timeout: 30_000,
        });
      } catch (err) {
        throw new Error(
          `Could not unregister distro: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Wipe installer state so the next run re-executes every phase.
      const stateFile = path.join(
        os.homedir(),
        ".openrind-desktop",
        "openshell-install.json",
      );
      try {
        await rm(stateFile, { force: true });
      } catch {
        // Best-effort.
      }
      return { status: "reset", path: stateFile };
    }
    default:
      throw new Error(
        `Electron desktop bridge method is not implemented yet: ${command}`,
      );
  }
}

// Route an application-menu action to the renderer. The renderer's AppRoot
// listens on the "openrind-desktop:menu" channel and maps actions to react-router
// navigation (see app-root.tsx). Guard against a torn-down window.
function sendMenuActionToRenderer(action) {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) return;
  win.webContents.send("openrind-desktop:menu", { action });
}

// Build and install the application menu.
//
// Without this the app fell back to Electron's built-in default menu, whose
// File submenu on Windows/Linux contains only "Quit" (shown as "Exit") — the
// reported bug. We replace it with a real menu: app-specific navigation under
// File, plus the standard Edit/View/Window/Help roles the renderer previously
// lacked (copy/paste, reload, zoom, devtools, etc.).
function buildApplicationMenu() {
  const isMac = process.platform === "darwin";

  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [];

  if (isMac) {
    template.push({ role: "appMenu" });
  }

  template.push({
    label: "File",
    submenu: [
      {
        label: "New Session",
        accelerator: "CmdOrCtrl+N",
        click: () => sendMenuActionToRenderer("new-session"),
      },
      {
        label: "New Workspace…",
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => sendMenuActionToRenderer("new-workspace"),
      },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: () => sendMenuActionToRenderer("open-settings"),
      },
      {
        label: "Sandboxes",
        click: () => sendMenuActionToRenderer("open-sandboxes"),
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit", label: "Exit" },
    ],
  });

  template.push({ role: "editMenu" });

  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({ role: "windowMenu" });

  template.push({
    role: "help",
    submenu: [
      {
        label: "Openrind Desktop Documentation",
        click: () => {
          void openExternalSafe("https://github.com/openrind/openrind-shell");
        },
      },
      ...(isMac
        ? []
        : [
            { type: "separator" },
            {
              label: "About Openrind Desktop",
              click: () => sendMenuActionToRenderer("about"),
            },
          ]),
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow() {
  if (mainWindow) return mainWindow;

  const preloadPath = path.join(__dirname, "preload.mjs");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: "Openrind Desktop",
    show: false,
    ...(APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty()
      ? { icon: APP_ICON_IMAGE }
      : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Microphone capture for on-device voice dictation. Grant narrowly:
  //  - only the `media`/`audioCapture` permissions (everything else denied),
  //  - only from the app's own content (the file:// bundle or the trusted dev
  //    server), never arbitrary remote frames, and
  //  - only audio — any request that includes video (camera) is denied.
  const trustedStartOrigin = (() => {
    const raw =
      process.env.OPENRIND_DESKTOP_ELECTRON_START_URL?.trim() ||
      process.env.ELECTRON_START_URL?.trim();
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  })();
  const isTrustedVoiceOrigin = (url) => {
    if (typeof url !== "string" || url.length === 0) return false;
    // Packaged build serves the renderer over file://.
    if (url.startsWith("file://")) return true;
    // Local dev server (Vite binds IPv4 loopback; localhost covers both).
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost")
    ) {
      return true;
    }
    if (trustedStartOrigin) {
      try {
        return new URL(url).origin === trustedStartOrigin;
      } catch {
        return false;
      }
    }
    return false;
  };
  const isAudioOnlyMediaPermission = (permission, details) => {
    if (permission !== "media" && permission !== "audioCapture") return false;
    // Request handler exposes mediaTypes[]; the check handler exposes mediaType.
    if (
      Array.isArray(details?.mediaTypes) &&
      details.mediaTypes.includes("video")
    ) {
      return false;
    }
    if (details?.mediaType === "video") return false;
    return true;
  };
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const url = details?.requestingUrl || details?.securityOrigin || "";
      callback(
        isAudioOnlyMediaPermission(permission, details) &&
          isTrustedVoiceOrigin(url),
      );
    },
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      const url =
        details?.requestingUrl ||
        requestingOrigin ||
        details?.securityOrigin ||
        "";
      return (
        isAudioOnlyMediaPermission(permission, details) &&
        isTrustedVoiceOrigin(url)
      );
    },
  );

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const local =
      url.startsWith("file://") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost");
    if (!local) {
      void openExternalSafe(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Navigation guard: setWindowOpenHandler only covers NEW windows. Without a
  // will-navigate/will-redirect guard, a renderer (or injected content / link /
  // HTTP redirect) could navigate the MAIN frame to a remote origin while
  // keeping the preload contextBridge + all IPC channels exposed — a full IPC
  // takeover. Only allow the app's own origins (file://, loopback dev server,
  // configured start origin); anything else is cancelled and opened externally.
  const blockOffAppNavigation = (event, url) => {
    if (isTrustedVoiceOrigin(url)) return; // reuses the trusted-app-origin test
    event.preventDefault();
    void openExternalSafe(url);
  };
  mainWindow.webContents.on("will-navigate", blockOffAppNavigation);
  mainWindow.webContents.on("will-redirect", blockOffAppNavigation);

  const startUrl =
    process.env.OPENRIND_DESKTOP_ELECTRON_START_URL?.trim() ||
    process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    const packagedIndexPath = path.join(
      process.resourcesPath,
      "app-dist",
      "index.html",
    );
    const devIndexPath = path.resolve(__dirname, "../../app/dist/index.html");
    await mainWindow.loadFile(
      app.isPackaged ? packagedIndexPath : devIndexPath,
    );
  }

  return mainWindow;
}

ipcMain.handle("openrind-desktop:desktop", handleDesktopInvoke);
ipcMain.handle("openrind-desktop:shell:openExternal", async (_event, url) => {
  await openExternalSafe(url);
});
ipcMain.handle("openrind-desktop:shell:relaunch", async () => {
  app.relaunch();
  app.exit(0);
});

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({
  app,
  ipcMain,
  getMainWindow: () => mainWindow,
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    void disposeRuntimeBeforeQuit().finally(() => app.quit());
  });

  app.on("second-instance", async (_event, argv) => {
    const win = await createMainWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    queueDeepLinks(forwardedDeepLinks(argv));
  });

  app.on("open-url", async (event, url) => {
    event.preventDefault();
    await createMainWindow();
    queueDeepLinks([url]);
  });

  app.whenReady().then(async () => {
    buildApplicationMenu();
    await installReactDevToolsForDev();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await migrateLegacyElectronWorkspaceStateIfNeeded();
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch(
      (error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    queueDeepLinks(forwardedDeepLinks(process.argv));
    const win = await createMainWindow();
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });

    // Kick the packaged-only updater after the window is up so the user
    // sees a working app first. This is a no-op in dev.
    void ensureAutoUpdater().then((updater) => {
      if (!updater) return;
      void updater.checkForUpdates().catch(() => undefined);
    });
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      return;
    }
    const win = await createMainWindow();
    win.show();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
