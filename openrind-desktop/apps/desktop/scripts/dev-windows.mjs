// Windows-specific wrapper around electron-dev.mjs. Does three things the
// generic dev-loop can't:
//   1. Sources VS Build Tools env for native sidecar development.
//   2. Adds LLVM to PATH so clang-based rebuilds find a compiler.
//   3. Reaps stale sidecar processes from the Electron resources/sidecars
//      directory before a new dev run (an unclean Electron quit on Windows
//      can leave orphan openrind-desktop-orchestrator.exe holding ports).
//
// Targets x64 by default; pass `x64` arg explicitly for parity with the
// previous Tauri-era cross-build flow. ARM64-on-ARM64 hosts also work.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronDevScript = resolve(scriptDir, "electron-dev.mjs");

function loadDotenv(filePath) {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {}
}

loadDotenv(resolve(desktopRoot, "..", "..", ".env"));
loadDotenv(resolve(desktopRoot, ".env"));

const requestedTarget = process.argv[2] === "x64" ? "x64" : null;
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const targetArch = requestedTarget ?? hostArch;
const llvmBin = process.env.LLVM_BIN || "C:\\Program Files\\LLVM\\bin";

const stopStaleSidecars = () => {
  if (process.platform !== "win32") return;
  const targetDir = electronSidecarDir.replace(/\\/g, "\\\\");
  const command = [
    `$targetDir = \"${targetDir}\"`,
    "$names = @('opencode.exe','openrind-desktop-server.exe','openrind-desktop-orchestrator.exe','chrome-devtools-mcp.exe')",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($targetDir, [System.StringComparison]::OrdinalIgnoreCase) -and $names.Contains([System.IO.Path]::GetFileName($_.ExecutablePath))",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "ignore",
  });
  spawnSync("wsl.exe", ["-d", "openrind-desktop-openshell", "--", "sh", "-c", "docker ps -q --filter name=openrind-browser- | xargs -r docker rm -f"], {
    stdio: "ignore",
  });
};

const loadWindowsBuildEnv = () => {
  if (process.platform !== "win32") return {};
  const vsDevCmd =
    process.env.VSDEVCMD_PATH ||
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat";
  if (!existsSync(vsDevCmd)) return {};

  const command = `\"${vsDevCmd}\" -arch=${targetArch} -host_arch=${hostArch} >nul && set`;
  const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return {};

  return Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
};

const windowsBuildEnv = loadWindowsBuildEnv();
stopStaleSidecars();

const browserPackagingDir = resolve(desktopRoot, "..", "..", "packaging", "browser-client");
const runtimeManifest = resolve(browserPackagingDir, "browser-runtime", "runtime-manifest.json");
if (!existsSync(runtimeManifest)) {
  try {
    spawnSync(process.execPath, [resolve(browserPackagingDir, "build.mjs")], { cwd: browserPackagingDir, stdio: "ignore" });
    spawnSync(process.execPath, [resolve(browserPackagingDir, "stage-runtime.mjs"), process.execPath], { cwd: browserPackagingDir, stdio: "ignore" });
  } catch {}
}

const mergedPath = [
  existsSync(llvmBin) ? llvmBin : null,
  windowsBuildEnv.Path || windowsBuildEnv.PATH || process.env.Path || process.env.PATH || null,
]
  .filter(Boolean)
  .join(";");

const env = {
  ...process.env,
  ...windowsBuildEnv,
  OPENRIND_DESKTOP_DEV_MODE: process.env.OPENRIND_DESKTOP_DEV_MODE || "1",
  OPENRIND_DESKTOP_DATA_DIR:
    process.env.OPENRIND_DESKTOP_DATA_DIR ||
    `${homedir()}\\.openrind-desktop\\openrind-desktop-orchestrator-dev`,
  OPENRIND_DESKTOP_USE_COREPACK_PNPM: "1",
  CC: process.env.CC || "clang",
  CXX: process.env.CXX || "clang++",
  CLANG_PATH: process.env.CLANG_PATH || (existsSync(llvmBin) ? `${llvmBin}\\clang.exe` : "clang"),
};

if (mergedPath) {
  env.PATH = mergedPath;
  env.Path = mergedPath;
}

const result = spawnSync(process.execPath, [electronDevScript], {
  stdio: "inherit",
  cwd: desktopRoot,
  env,
});

process.exit(result.status ?? 1);
