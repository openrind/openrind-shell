import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openrind-desktop:deep-link-native";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

const PRIVILEGED_WORKSPACE_CONFIG_COMMANDS = new Set([
  "workspaceAddAuthorizedRoot",
  "workspaceOpenrindDesktopRead",
  "workspaceOpenrindDesktopWrite",
]);

function invokeDesktop(command, ...args) {
  const normalizedCommand = String(command ?? "");
  if (PRIVILEGED_WORKSPACE_CONFIG_COMMANDS.has(normalizedCommand)) {
    return Promise.reject(
      new Error(
        `Privileged desktop command must use its dedicated bridge method: ${normalizedCommand}`,
      ),
    );
  }
  return ipcRenderer.invoke(
    "openrind-desktop:desktop",
    normalizedCommand,
    ...args,
  );
}

contextBridge.exposeInMainWorld("__OPENRIND_DESKTOP_ELECTRON__", {
  invokeDesktop,
  bridge: {
    workspaceAddAuthorizedRoot(input) {
      return ipcRenderer.invoke(
        "openrind-desktop:workspace-config:add-authorized-root",
        input,
      );
    },
    workspaceOpenrindDesktopRead(input) {
      return ipcRenderer.invoke(
        "openrind-desktop:workspace-config:read",
        input,
      );
    },
    workspaceOpenrindDesktopWrite(input) {
      return ipcRenderer.invoke(
        "openrind-desktop:workspace-config:write",
        input,
      );
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("openrind-desktop:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("openrind-desktop:shell:relaunch");
    },
  },
  /** Subscribe to native application-menu actions (File > New Session, etc.). */
  onMenuAction(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("openrind-desktop:menu", handler);
    return () => {
      ipcRenderer.removeListener("openrind-desktop:menu", handler);
    };
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("openrind-desktop:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("openrind-desktop:migration:ack");
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("openrind-desktop:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("openrind-desktop:updater:setChannel", channel);
    },
    check() {
      return ipcRenderer.invoke("openrind-desktop:updater:check");
    },
    download() {
      return ipcRenderer.invoke("openrind-desktop:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("openrind-desktop:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openrind-desktop:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener(
          "openrind-desktop:updater:download-progress",
          handler,
        );
      };
    },
  },
  openshell: {
    /** Subscribe to installer progress events emitted by installer.mjs (Phase 6). */
    onInstallProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openshell:install-progress", handler);
      return () => {
        ipcRenderer.removeListener("openshell:install-progress", handler);
      };
    },
  },
  openrindShell: {
    /** Subscribe to Openrind Shell session progress (pull, create, terminal launch). */
    onSessionProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openrind-shell:session-progress", handler);
      return () => {
        ipcRenderer.removeListener("openrind-shell:session-progress", handler);
      };
    },
    /** Subscribe to PTY stdout/stderr bytes from a live session. The
     *  callback receives {sessionId, data}; consumers should filter by
     *  the id of the session they own (renderer may have multiple PTYs). */
    onPtyData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openrind-shell:pty-data", handler);
      return () => {
        ipcRenderer.removeListener("openrind-shell:pty-data", handler);
      };
    },
    /** Subscribe to PTY exit events — fires when the wsl child dies. */
    onPtyExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openrind-shell:pty-exit", handler);
      return () => {
        ipcRenderer.removeListener("openrind-shell:pty-exit", handler);
      };
    },
  },
  browser: {
    start(opts) { return ipcRenderer.invoke("openrind-desktop:browser:start", opts); },
    navigate(opts) { return ipcRenderer.invoke("openrind-desktop:browser:navigate", opts); },
    stop(opts) { return ipcRenderer.invoke("openrind-desktop:browser:stop", opts); },
    takeControl(opts) { return ipcRenderer.invoke("openrind-desktop:browser:take-control", opts); },
    resume(opts) { return ipcRenderer.invoke("openrind-desktop:browser:resume", opts); },
    setBounds(opts) { return ipcRenderer.invoke("openrind-desktop:browser:set-bounds", opts); },
    setVisible(opts) { return ipcRenderer.invoke("openrind-desktop:browser:set-visible", opts); },
    status(opts) { return ipcRenderer.invoke("openrind-desktop:browser:status", opts); },
  },
  meta: {
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
  },
});

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }),
  );
});
