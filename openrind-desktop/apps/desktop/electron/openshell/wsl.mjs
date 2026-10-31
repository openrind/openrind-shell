// Thin wrapper around wsl.exe. Every other OpenShell module talks to WSL
// through this file so the orphan-process workaround (microsoft/WSL#12159)
// and the UTF-16/UTF-8 encoding flip are handled in exactly one place.
//
// On Linux/macOS dev boxes wsl.exe doesn't exist; tests set
// OPENRIND_DESKTOP_WSL_EXE to a recording shell script.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const DISTRO_NAME = "openrind-desktop-openshell";

const DEFAULT_TIMEOUT_MS = 30_000;
// Upper bound on buffered stdout+stderr for a single wslRun call (16 MiB).
const MAX_WSLRUN_OUTPUT_BYTES = 16 * 1024 * 1024;

function resolveWslExe() {
  return process.env.OPENRIND_DESKTOP_WSL_EXE || "wsl.exe";
}

// Older wsl.exe emits UTF-16 LE for `--list` etc.; newer versions emit
// UTF-8. Detect the encoding from the buffer rather than trusting the
// version, since users will run a mix in the field.
export function decodeWslOutput(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

function injectUser(args, user) {
  if (!user) return args;
  // Splice --user immediately after -d <distro> if present, else prepend.
  const dIdx = args.indexOf("-d");
  if (dIdx >= 0 && dIdx + 1 < args.length) {
    const out = args.slice();
    out.splice(dIdx + 2, 0, "--user", user);
    return out;
  }
  return ["--user", user, ...args];
}

function killWslProcess(child) {
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => {});
    }
  } catch {}
  try {
    child.kill("SIGKILL");
  } catch {}
}

function wslRunSingle(args, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    user,
    cwd,
    env,
    stdin,
    signal,
    onOutput,
  } = options;
  const exe = resolveWslExe();
  const finalArgs = injectUser(args, user);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, finalArgs, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    // Cap buffered output so a runaway command (or hostile payload echoing
    // unbounded data) can't exhaust main-process memory. wslRun is only used
    // for short control commands; streaming/progress consumers use wslSpawn.
    let bufferedBytes = 0;
    let overflowed = false;
    const collect = (chunks, chunk) => {
      if (overflowed) return;
      bufferedBytes += chunk.length;
      if (bufferedBytes > MAX_WSLRUN_OUTPUT_BYTES) {
        overflowed = true;
        killWslProcess(child);
        return;
      }
      chunks.push(chunk);
    };
    const handleOutput = (stream, chunks, chunk) => {
      collect(chunks, chunk);
      if (typeof onOutput !== "function" || !chunk?.length) return;
      try {
        onOutput({ stream, text: decodeWslOutput(chunk) });
      } catch {
        // A progress listener must never interfere with the control command.
      }
    };
    child.stdout.on("data", (c) => handleOutput("stdout", stdoutChunks, c));
    child.stderr.on("data", (c) => handleOutput("stderr", stderrChunks, c));

    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killWslProcess(child);
          }, timeout)
        : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (overflowed) {
        reject(
          new Error(
            `wsl.exe output exceeded ${MAX_WSLRUN_OUTPUT_BYTES} bytes running: ${finalArgs.join(" ")}`,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new Error(
            `wsl.exe timed out after ${timeout}ms running: ${finalArgs.join(" ")}`,
          ),
        );
        return;
      }
      resolve({
        exitCode: code,
        stdout: decodeWslOutput(Buffer.concat(stdoutChunks)),
        stderr: decodeWslOutput(Buffer.concat(stderrChunks)),
      });
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function wslRun(args, options = {}) {
  const maxAttempts = options.retries ?? 3;
  let lastResult;
  let lastError;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const result = await wslRunSingle(args, options);
      const output = `${result.stderr}\n${result.stdout}`;
      const isTransientFailure =
        result.exitCode !== 0 &&
        (/WSAETIMEDOUT|Wsl\/Service/i.test(output) ||
          result.exitCode === 4294967295 ||
          result.exitCode === -1);

      if (isTransientFailure && attempt < maxAttempts) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      const isTransientTimeout = /timed out|WSAETIMEDOUT|Wsl\/Service/i.test(err?.message || "");
      if (isTransientTimeout && attempt < maxAttempts) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw lastError;
  return lastResult;
}

export function wslSpawn(args, options = {}) {
  const { user, cwd, env } = options;
  const exe = resolveWslExe();
  const finalArgs = injectUser(args, user);

  const child = spawn(exe, finalArgs, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Terminate ONLY this wsl.exe invocation (and its Windows-side child tree),
  // never the whole distro.
  //
  // The previous implementation ran `wsl.exe -t <DISTRO_NAME>` here, which
  // terminates the entire WSL utility VM. Killing one spawned command (e.g. a
  // create-sandbox timeout or a docker-pull abort) therefore tore down EVERY
  // other running sandbox, all live `sandbox connect` PTYs, AND the OpenShell
  // gateway — a cross-session denial of service (audit #4). wsl.exe processes
  // can leave a short-lived Linux-side orphan (microsoft/WSL#12159), but that
  // is far less harmful than nuking the VM; taskkill /T reaps the Windows
  // process subtree, and the Linux process exits on stdio EOF.
  const baseKill = child.kill.bind(child);
  child.kill = (signal) => {
    try {
      if (process.platform === "win32" && typeof child.pid === "number") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => {});
      }
    } catch {
      // Best-effort. Caller's signal below is the real exit path.
    }
    return baseKill(signal);
  };

  return child;
}

export async function distroExists() {
  const r = await wslRun(["--list", "--quiet"], { timeout: 10_000 });
  if (r.exitCode !== 0) return false;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(DISTRO_NAME);
}

// Parses `wsl.exe --list --verbose`. Returns one of:
// "Running" | "Stopped" | "Installing" | "NotFound".
export async function distroState() {
  const r = await wslRun(["--list", "--verbose"], { timeout: 10_000 });
  if (r.exitCode !== 0) return "NotFound";
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.replace(/^\*/, "").trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols[0] === DISTRO_NAME) {
      const state = cols[1];
      if (
        state === "Running" ||
        state === "Stopped" ||
        state === "Installing"
      ) {
        return state;
      }
      return "Stopped";
    }
  }
  return "NotFound";
}

// ── WSL keepalive ─────────────────────────────────────────────────────────
// WSL2 begins tearing the distro down shortly after the last wsl.exe client
// exits. The teardown stops multi-user.target — killing the OpenShell
// gateway — and is often cancelled midway by our next command, leaving the
// gateway restart-looping ("Shutdown signal received" every ~15 s in its
// journal) while sandbox supervisors lose their control channel, flap
// between Ready/Provisioning, and restart the user's agent processes.
// Observed as: frozen terminals, ghost sessions, stuck creation screens.
//
// Holding one long-lived `wsl -d <distro> -- sleep infinity` client pins the
// distro (and therefore the gateway and all sandboxes) for the app's
// lifetime. unref() so the handle never blocks app exit; on app quit the
// keepalive dies with us and WSL may idle the distro normally.
let keepaliveChild = null;
let keepaliveReady = null;

// Resolve only once wsl.exe itself has spawned. This is the point at which WSL
// has registered an active client, which prevents an already-started idle
// teardown from racing the gateway check/create that follows.
export function ensureWslKeepalive() {
  if (keepaliveChild && keepaliveChild.exitCode === null) {
    return keepaliveReady ?? Promise.resolve(true);
  }
  try {
    const exe = resolveWslExe();
    const child = spawn(
      exe,
      ["-d", DISTRO_NAME, "--", "sleep", "infinity"],
      { windowsHide: true, stdio: "ignore" },
    );
    keepaliveChild = child;
    keepaliveReady = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const clear = () => {
        if (keepaliveChild === child) {
          keepaliveChild = null;
          keepaliveReady = null;
        }
      };
      child.once("spawn", () => settle(true));
      child.once("error", () => {
        clear();
        settle(false);
      });
      child.once("exit", () => {
        clear();
        settle(false);
      });
    });
    child.unref();
    return keepaliveReady;
  } catch {
    keepaliveChild = null;
    keepaliveReady = null;
    return Promise.resolve(false);
  }
}

export async function ensureDistroRunning() {
  let state = await distroState();
  if (state === "NotFound") {
    throw new Error(
      `WSL distro "${DISTRO_NAME}" is not registered. Run the OpenShell installer.`,
    );
  }
  if (state === "Running") {
    await ensureWslKeepalive();
    return;
  }
  await wslRun(["-d", DISTRO_NAME, "--exec", "true"], { timeout: 30_000 });
  for (let i = 0; i < 30; i++) {
    state = await distroState();
    if (state === "Running") {
      await ensureWslKeepalive();
      return;
    }
    await delay(500);
  }
  throw new Error(`WSL distro "${DISTRO_NAME}" did not reach Running state.`);
}

// C:\Users\j\workspace → /mnt/c/Users/j/workspace
export function toWslPath(winPath) {
  if (typeof winPath !== "string" || winPath.length === 0) return winPath;
  const p = winPath.replace(/^"+|"+$/g, "");
  const drive = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) {
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  if (p.startsWith("/")) return p;
  return p.replace(/\\/g, "/");
}

// /mnt/c/Users/j/workspace → C:\Users\j\workspace
export function toWindowsPath(wslPath) {
  if (typeof wslPath !== "string" || wslPath.length === 0) return wslPath;
  const m = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) {
    return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  }
  return wslPath;
}
