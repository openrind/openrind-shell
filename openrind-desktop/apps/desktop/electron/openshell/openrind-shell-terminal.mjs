// External-terminal launcher for Openrind Shell sessions. Until the xterm.js
// renderer view lands (deferred pending founder review of the session
// UX shape), the only way to interact with a freshly-created Openrind Shell
// sandbox is to spawn an OS terminal window that runs
// `wsl -d openrind-desktop-openshell -- openshell sandbox connect <name>`.
//
// Platforms:
//   - Windows: Windows Terminal (wt.exe) if available, else cmd.exe.
//     Windows Terminal handles TTY resize properly; cmd.exe is the
//     fallback so the feature works on stock Windows 11 install.
//   - macOS:   osascript drives Terminal.app to open a new window.
//   - Linux:   probes a list of known terminal emulators and uses the
//              first one found. Dev-only — banker laptops are Windows.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { ensureManagedFuseGateway } from "./fuse-gateway.mjs";

import { buildFuseCliCommand, buildFuseWslEnv } from "./fuse-runtime.mjs";
import { DISTRO_NAME } from "./wsl.mjs";

const LINUX_TERMINAL_CANDIDATES = [
  // Each entry is { command, argsForCommand(cmd, args) → string[] }
  // where the inner closure builds the argv that launches `cmd args[...]`
  // inside the terminal emulator and exits when it does.
  { exe: "alacritty", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "kitty", build: (cmd, args) => [cmd, ...args] },
  { exe: "wezterm", build: (cmd, args) => ["start", "--", cmd, ...args] },
  { exe: "gnome-terminal", build: (cmd, args) => ["--", cmd, ...args] },
  { exe: "konsole", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "xfce4-terminal", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "tilix", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "xterm", build: (cmd, args) => ["-e", cmd, ...args] },
];

function detectLinuxTerminal() {
  // No pre-probe: launchLinuxTerminal tries each candidate in order and a
  // missing binary surfaces as a spawn error there, so probing with `which`
  // here only leaked short-lived processes.
  return LINUX_TERMINAL_CANDIDATES;
}

/**
 * Spawn an OS terminal window running `wsl -d <distro> -- openshell
 * sandbox connect <name>`. Returns once the terminal launch has been
 * dispatched — does NOT wait for the user to close it.
 *
 * Throws if no terminal could be launched.
 *
 * @param {string} sandboxName
 * @param {{ windowTitle?: string }} [options]
 */
export async function launchExternalTerminalToSandbox(sandboxName, options = {}) {
  if (!sandboxName) throw new Error("launchExternalTerminalToSandbox: sandboxName is required");
  await ensureManagedFuseGateway();
  // Self-defending validation: the name is interpolated into a `bash -c`
  // command line and (via the default window title) into a cmd.exe `start`
  // argv below. deriveOpenrindShellSandboxName only ever emits this alphabet.
  if (!/^[a-z0-9_.-]+$/.test(sandboxName)) {
    throw new Error(
      `launchExternalTerminalToSandbox: invalid sandbox name ${JSON.stringify(sandboxName)} (expected only [a-z0-9_.-])`,
    );
  }
  const windowTitle = options.windowTitle ?? `Openrind Desktop — ${sandboxName}`;
  // `"` would break argv quoting and `%`/control chars are expanded or
  // mangled by cmd.exe even inside quotes — reject rather than repair.
  if (/["%\u0000-\u001f]/.test(windowTitle)) {
    throw new Error(
      `launchExternalTerminalToSandbox: invalid window title ${JSON.stringify(windowTitle)}`,
    );
  }

  if (process.platform === "win32") {
    return launchWindowsTerminal(sandboxName, windowTitle);
  }
  if (process.platform === "darwin") {
    return launchMacOSTerminal(sandboxName, windowTitle);
  }
  return launchLinuxTerminal(sandboxName, windowTitle);
}

function launchWindowsTerminal(sandboxName, windowTitle) {
  // Try Windows Terminal first. The `wt.exe` shim accepts `--title`
  // and runs `wsl.exe -d ... -- bash -c '...'` as the command. If wt
  // isn't installed (older Win11 installs), fall back to cmd.exe /K so
  // the window stays open after the connect command exits.
  //
  // We wrap with `bash -c` for two reasons:
  //   1. PATH: when wsl.exe runs a command directly (without bash) it
  //      uses a minimal PATH that may not include the location where
  //      openshell was installed (e.g. ~/.local/bin). A bash -c wrapper
  //      runs through bash's own PATH lookup which sources the distro's
  //      profile entries and reliably finds openshell.
  //   2. Terminal setup: we need to read the current terminal dimensions
  //      (stty size) and set raw mode (-icanon -echo) on the outer WSL
  //      PTY before `openshell sandbox connect` starts, so `connect`
  //      inherits the correct cols/rows and keystrokes pass through
  //      immediately without line-buffering or echo artifacts.
  const escapedName = sandboxName.replace(/'/g, "'\\''");
  // Use `openshell sandbox connect` — the correct interactive command.
  // `sandbox exec` only relays stdout/stderr and discards stdin; `connect`
  // relays all three directions so Claude Code's TUI is fully interactive.
  //
  // Step 1: read the actual terminal size from the ConPTY-backed WSL PTY
  //   so `connect` inherits correct cols/rows for the container PTY.
  //   (Without this, the container PTY may start at 0×0 / cols=1, causing
  //   Claude Code's output to render as vertical single-character lines.)
  //   Uses awk to split "ROWS COLS" from `stty size`.
  //
  // Step 2: set the outer WSL PTY to raw mode (-icanon -echo) so keystrokes
  //   flow through immediately without line-buffering or echo artifacts.
  //
  // IMPORTANT: use && not ; between commands — Windows Terminal (wt.exe)
  //   uses semicolons as its own pane/tab separator. A semicolon in the
  //   bash -c argument is seen by wt.exe even inside double quotes and
  //   causes it to try to run `exec openshell ...` as a Windows binary
  //   → error 0x80070002 "file not found". && is not a wt.exe separator.
  const wslArgs = [
    "-d",
    DISTRO_NAME,
    "--",
    "bash",
    "-c",
    `COLS=$(stty size 2>/dev/null | awk '{print $2}') && ROWS=$(stty size 2>/dev/null | awk '{print $1}') && stty cols \${COLS:-80} rows \${ROWS:-24} -icanon -echo min 1 time 0 2>/dev/null && exec ${buildFuseCliCommand(["sandbox", "connect", sandboxName])}`,
  ];

  const wtChild = spawn(
    "wt.exe",
    ["--title", windowTitle, "wsl.exe", ...wslArgs],
    { detached: true, stdio: "ignore", windowsHide: false, env: buildFuseWslEnv() },
  );
  return new Promise((resolve, reject) => {
    wtChild.once("error", () => {
      // wt.exe missing — fall back to cmd.exe. No shell:true: cmd would
      // re-interpret the bash payload's `&&`/`|`/`>` operators (and the
      // title) before wsl.exe ever saw them, so hand cmd.exe a plain argv.
      // `start` treats its first *quoted* argument as the window title and
      // node only quotes argv entries that contain spaces, so pad a
      // space-less title to guarantee it can't be taken as the command.
      const startTitle = windowTitle.includes(" ") ? windowTitle : `${windowTitle} `;
      const cmdChild = spawn(
        "cmd.exe",
        ["/C", "start", startTitle, "wsl.exe", ...wslArgs],
        { detached: true, stdio: "ignore", windowsHide: false, env: buildFuseWslEnv() },
      );
      cmdChild.once("error", reject);
      cmdChild.once("spawn", () => {
        cmdChild.unref();
        resolve({ launched: "cmd.exe" });
      });
    });
    // Resolve on the real spawn signal — a fixed timer would race the
    // error → cmd.exe fallback path.
    wtChild.once("spawn", () => {
      wtChild.unref();
      resolve({ launched: "wt.exe" });
    });
  });
}

function launchMacOSTerminal(sandboxName, windowTitle) {
  // osascript opens Terminal.app and runs a command. We can't directly
  // run wsl on macOS (it doesn't exist) but the sandbox-connect target
  // is wsl-resident, so this path is dev-only and runs against a
  // remote dev distro via SSH (which a banker laptop wouldn't have).
  // Surfacing a clear "macOS unsupported for Openrind Shell" error is more
  // honest than spawning a terminal that immediately fails.
  return Promise.reject(
    new Error(
      "Openrind Shell sessions are not supported on macOS — the openrind-desktop-openshell WSL distro " +
        "only exists on Windows. macOS / Linux remain testing-only host platforms for " +
        "Openrind Desktop itself; the sandboxes always run on the banker's Windows machine.",
    ),
  );
}

async function launchLinuxTerminal(sandboxName, windowTitle) {
  // Linux is dev convenience only — banker laptops are Windows. Probe a
  // list of common terminal emulators in priority order.
  // Wrap with bash -c for PATH reliability and to set raw mode on the
  // outer WSL PTY (same rationale as launchWindowsTerminal above).
  const escapedName = sandboxName.replace(/'/g, "'\\''");
  const wslArgs = [
    "-d",
    DISTRO_NAME,
    "--",
    "bash",
    "-c",
    `COLS=$(stty size 2>/dev/null | awk '{print $2}') && ROWS=$(stty size 2>/dev/null | awk '{print $1}') && stty cols \${COLS:-80} rows \${ROWS:-24} -icanon -echo min 1 time 0 2>/dev/null && exec ${buildFuseCliCommand(["sandbox", "connect", sandboxName])}`,
  ];
  const candidates = detectLinuxTerminal();
  for (const cand of candidates) {
    const args = cand.build("wsl.exe", wslArgs);
    try {
      const child = spawn(cand.exe, args, {
        detached: true,
        stdio: "ignore",
        env: buildFuseWslEnv(),
      });
      // Sync error from missing binary fires within a tick.
      const launched = await new Promise((resolve) => {
        let settled = false;
        child.once("error", () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve(true);
          }
        }, 80);
      });
      if (launched) {
        return { launched: cand.exe };
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not find a terminal emulator to launch the Openrind Shell session in. " +
      "Install one of: alacritty, kitty, wezterm, gnome-terminal, konsole, xfce4-terminal, tilix, xterm. " +
      "(Linux is a dev-only host for Openrind Shell; banker laptops run Windows.)",
  );
}

/**
 * Derive a compact, stable OpenShell sandbox identity. The gateway caps
 * routable names at 19 characters, so the earlier descriptive
 * `openrind-shell-<workspace>` form could never be created for normal IDs.
 * Keep a recognizable slug plus a hash suffix to preserve cross-machine
 * portability without risking collisions from truncation.
 */
export function deriveOpenrindShellSandboxName(workspaceId) {
  if (/^or-(?:[a-z0-9-]{1,7}-[a-f0-9]{8}|[a-z0-9-]{1,8}-[a-f0-9]{7})$/.test(workspaceId)) {
    return workspaceId;
  }
  if (/^openrind-shell-[a-z0-9_-]+$/.test(workspaceId)) {
    return workspaceId;
  }
  const normalized = String(workspaceId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[_.]/g, "-");
  if (!normalized) {
    throw new Error("Cannot derive Openrind Shell sandbox name from empty workspace id.");
  }
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  const slug = normalized.slice(0, 7).replace(/^-+|-+$/g, "") || "sbx";
  return `or-${slug}-${hash}`.replace(/-+/g, "-");
}
