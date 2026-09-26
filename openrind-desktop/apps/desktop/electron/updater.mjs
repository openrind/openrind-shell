import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ELECTRON_UPDATER_CHANNEL_FILENAME = "electron-updater-channel.v1.json";

// In dev mode, app.getVersion() returns the Electron framework version
// (e.g. "35.7.5") instead of the Openrind Desktop app version. Read from
// package.json so the UI always shows the correct version.
const __updater_dirname = path.dirname(fileURLToPath(import.meta.url));
let _cachedAppVersion = null;
function resolveAppVersion(app) {
  if (_cachedAppVersion) return _cachedAppVersion;
  const electronVersion = app.getVersion();
  // If packaged, app.getVersion() is correct (set by electron-builder).
  if (app.isPackaged) {
    _cachedAppVersion = electronVersion;
    return electronVersion;
  }
  // In dev, read from package.json.
  try {
    const pkgPath = path.resolve(__updater_dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    _cachedAppVersion = pkg.version || electronVersion;
  } catch {
    _cachedAppVersion = electronVersion;
  }
  return _cachedAppVersion;
}
// Strict semver-style comparison so an equal or older feed version (a
// downgrade) is never reported as an available update. Build metadata
// (+sha) is ignored; a prerelease sorts below its release; prerelease
// identifiers compare per semver precedence so alpha builds
// (X.Y.Z-alpha.<run>) still update to newer alphas. Missing or
// unparseable versions compare as not-greater.
function parseVersionParts(value) {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function isVersionGreater(a, b) {
  const va = parseVersionParts(a);
  const vb = parseVersionParts(b);
  if (!va || !vb) return false;
  for (let i = 0; i < 3; i += 1) {
    if (va.core[i] !== vb.core[i]) return va.core[i] > vb.core[i];
  }
  // Equal numeric core: a release outranks any prerelease.
  if (va.prerelease.length === 0) return vb.prerelease.length > 0;
  if (vb.prerelease.length === 0) return false;
  const len = Math.min(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ia = va.prerelease[i];
    const ib = vb.prerelease[i];
    if (ia === ib) continue;
    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;
    if (na !== null && nb !== null) return na > nb;
    // Numeric identifiers sort below alphanumeric ones (semver §11).
    if (na !== null) return false;
    if (nb !== null) return true;
    return ia > ib;
  }
  return va.prerelease.length > vb.prerelease.length;
}

const ELECTRON_UPDATER_FEEDS = Object.freeze({
  stable: "https://github.com/openrind/openrind-shell/releases/latest/download",
  alpha:
    "https://github.com/openrind/openrind-shell/releases/download/alpha-macos-latest",
});

function normalizeElectronUpdaterChannel(value) {
  if (value === "alpha" && process.platform === "darwin") return "alpha";
  return "stable";
}

function electronUpdaterChannelPath(app) {
  return path.join(app.getPath("userData"), ELECTRON_UPDATER_CHANNEL_FILENAME);
}

async function readElectronUpdaterChannel(app) {
  try {
    const raw = await readFile(electronUpdaterChannelPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeElectronUpdaterChannel(parsed?.channel);
  } catch {
    return "stable";
  }
}

async function writeElectronUpdaterChannel(app, channel) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  const outputPath = electronUpdaterChannelPath(app);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ channel: normalized, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function electronUpdaterFeedUrl(channel) {
  return ELECTRON_UPDATER_FEEDS[normalizeElectronUpdaterChannel(channel)];
}

function updaterChannelState(app, channel) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  return {
    channel: normalized,
    feedUrl: electronUpdaterFeedUrl(normalized),
    currentVersion: resolveAppVersion(app),
  };
}

async function applyElectronUpdaterFeed(app, updater) {
  const channel = await readElectronUpdaterChannel(app);
  const state = updaterChannelState(app, channel);
  if (updater?.setFeedURL) {
    // SECURITY: updates ship over a "generic" provider pointed at GitHub
    // release assets. Integrity relies on HTTPS plus electron-updater's
    // sha512 check against latest*.yml; there is no publisher
    // verification yet. Maintainers: Windows builds must be code-signed
    // and `win.publisherName` set in electron-builder.yml so
    // electron-updater verifies the installer's Authenticode signature.
    // Switching to the `github` provider would tie updates to the repo,
    // but would break the fixed-tag alpha feed (alpha-macos-latest), so
    // the generic provider is intentionally kept.
    updater.setFeedURL({ provider: "generic", url: state.feedUrl });
  }
  return state;
}

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
export function registerUpdaterIpc({ app, ipcMain, getMainWindow }) {
  let autoUpdaterInstance = null;
  let autoUpdaterLoaded = false;

  function sendToRenderer(channel, data) {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win?.webContents && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closed; swallow send failures.
    }
  }

  async function ensureAutoUpdater() {
    if (!app.isPackaged) return null;
    if (autoUpdaterLoaded) return autoUpdaterInstance;
    try {
      const mod = await import("electron-updater");
      // Latch only after a successful import so a transient failure
      // doesn't permanently disable the updater for the session.
      autoUpdaterLoaded = true;
      autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
      if (autoUpdaterInstance) {
        autoUpdaterInstance.autoDownload = false;
        autoUpdaterInstance.autoInstallOnAppQuit = true;
        autoUpdaterInstance.on("error", (err) => {
          // Never swallow updater errors: signature/checksum
          // verification failures surface here and must fail the update
          // loudly instead of proceeding.
          console.error("[updater] error", err);
          sendToRenderer("openrind-desktop:updater:error", {
            message: String(err?.message ?? err),
          });
        });
        // Forward download progress to the renderer so the UI can show
        // incremental bytes instead of staying stuck at 0.
        autoUpdaterInstance.on("download-progress", (info) => {
          sendToRenderer("openrind-desktop:updater:download-progress", {
            bytesPerSecond: info.bytesPerSecond ?? 0,
            percent: info.percent ?? 0,
            transferred: info.transferred ?? 0,
            total: info.total ?? 0,
            delta: info.delta ?? 0,
          });
        });
        await applyElectronUpdaterFeed(app, autoUpdaterInstance);
      }
    } catch (error) {
      console.warn("[updater] electron-updater not available", error);
      autoUpdaterInstance = null;
    }
    return autoUpdaterInstance;
  }

  ipcMain.handle("openrind-desktop:updater:getChannel", async () => {
    const channel = await readElectronUpdaterChannel(app);
    return updaterChannelState(app, channel);
  });

  ipcMain.handle("openrind-desktop:updater:setChannel", async (_event, rawChannel) => {
    const channel = await writeElectronUpdaterChannel(app, rawChannel);
    const updater = await ensureAutoUpdater();
    if (updater) {
      return applyElectronUpdaterFeed(app, updater);
    }
    return updaterChannelState(app, channel);
  });

  ipcMain.handle("openrind-desktop:updater:check", async () => {
    const updater = await ensureAutoUpdater();
    const channelState = updater
      ? await applyElectronUpdaterFeed(app, updater)
      : updaterChannelState(app, await readElectronUpdaterChannel(app));
    if (!updater)
      return { available: false, reason: "unavailable", ...channelState };
    try {
      const result = await updater.checkForUpdates();
      const info = result?.updateInfo ?? null;
      return {
        available: Boolean(
          info &&
          info.version &&
          isVersionGreater(info.version, resolveAppVersion(app)),
        ),
        currentVersion: resolveAppVersion(app),
        latestVersion: info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: info?.releaseNotes ?? null,
        ...channelState,
      };
    } catch (error) {
      return {
        available: false,
        reason: String(error?.message ?? error),
        ...channelState,
      };
    }
  });

  ipcMain.handle("openrind-desktop:updater:download", async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      await updater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  ipcMain.handle("openrind-desktop:updater:installAndRestart", async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  return { ensureAutoUpdater };
}
