import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve, relative } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.OPENRIND_DESKTOP_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.OPENRIND_DESKTOP_SIDECAR_DIR?.trim() || readArg("--outdir");
// Default to the Electron layout (resources/sidecars). electron-builder.yml's
// win/mac/linux.extraResources rules read from this path. Pass --outdir or
// OPENRIND_DESKTOP_SIDECAR_DIR for one-off targets.
const sidecarDir = sidecarOverride
  ? resolve(sidecarOverride)
  : join(__dirname, "..", "resources", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const opencodeGithubRepo = (() => {
  const raw =
    process.env.OPENCODE_GITHUB_REPO?.trim() ||
    process.env.OPENRIND_DESKTOP_OPENCODE_GITHUB_REPO?.trim() ||
    "anomalyco/opencode";
  const normalized = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "anomalyco/opencode";
  }
  return normalized;
})();
const opencodeVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion.trim() || null : null;
  } catch {
    return null;
  }
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

const opencodeAssetOverride = process.env.OPENCODE_ASSET?.trim() || null;
const chromeDevtoolsMcpVersion =
  process.env.CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  process.env.OPENRIND_DESKTOP_CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  "0.17.0";

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
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
})();
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    // Windows baseline artifacts intermittently fail to extract in CI
    // with Bun 1.3.6. Use the stable x64 target here for now.
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    case "aarch64-pc-windows-msvc":
      return "bun-windows-arm64";
    default:
      return null;
  }
})();

function resolveBunCommand() {
  if (process.platform !== "win32") return "bun";
  const paths = (process.env.PATH || process.env.Path || "").split(";");
  for (const p of paths) {
    for (const ext of ["bun.exe", "bun.cmd", "bun.bat", "bun"]) {
      const candidate = join(p, ext);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "bun";
}

function spawnBun(bunCmd, args, options = {}) {
  const isCmdOrBat =
    process.platform === "win32" &&
    (bunCmd.toLowerCase().endsWith(".cmd") || bunCmd.toLowerCase().endsWith(".bat"));
  if (isCmdOrBat) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawnSync(comspec, ["/d", "/s", "/c", bunCmd, ...args], {
      ...options,
      shell: false,
    });
  }
  return spawnSync(bunCmd, args, {
    ...options,
    shell: false,
  });
}

const spawnShell = false;
const opencodeBaseName = isWindowsTarget ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;
let existingOpencodeVersion = null;

// openrind-desktop-server paths
const openrindDesktopServerBaseName = "openrind-desktop-server";
const openrindDesktopServerName = isWindowsTarget ? `${openrindDesktopServerBaseName}.exe` : openrindDesktopServerBaseName;
const openrindDesktopServerPath = join(sidecarDir, openrindDesktopServerName);
const openrindDesktopServerBuildName = bunTarget
  ? `${openrindDesktopServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : openrindDesktopServerName;
const openrindDesktopServerBuildPath = join(sidecarDir, openrindDesktopServerBuildName);
const openrindDesktopServerTargetTriple = resolvedTargetTriple;
const openrindDesktopServerTargetName = openrindDesktopServerTargetTriple
  ? `${openrindDesktopServerBaseName}-${openrindDesktopServerTargetTriple}${openrindDesktopServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const openrindDesktopServerTargetPath = openrindDesktopServerTargetName ? join(sidecarDir, openrindDesktopServerTargetName) : null;

const openrindDesktopServerDir = resolve(__dirname, "..", "..", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

function safeCopyFileSync(src, dest) {
  try {
    if (existsSync(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        // ignore
      }
    }
    copyFileSync(src, dest);
  } catch (err) {
    if (err && err.code === "EBUSY" && existsSync(dest)) {
      console.warn(`[prepare-sidecar] Warning: Destination file ${dest} is currently in use (EBUSY); skipping overwrite.`);
      return;
    }
    throw err;
  }
}

// orchestrator paths
const orchestratorBaseName = "openrind-desktop-orchestrator";
const orchestratorName =
  isWindowsTarget ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "orchestrator");

// chrome-devtools-mcp shim sidecar
const chromeDevtoolsBaseName = "chrome-devtools-mcp";
const chromeDevtoolsName = isWindowsTarget ? `${chromeDevtoolsBaseName}.exe` : chromeDevtoolsBaseName;
const chromeDevtoolsPath = join(sidecarDir, chromeDevtoolsName);
const chromeDevtoolsBuildName = bunTarget
  ? `${chromeDevtoolsBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : chromeDevtoolsName;
const chromeDevtoolsBuildPath = join(sidecarDir, chromeDevtoolsBuildName);
const chromeDevtoolsTargetTriple = resolvedTargetTriple;
const chromeDevtoolsTargetName = chromeDevtoolsTargetTriple
  ? `${chromeDevtoolsBaseName}-${chromeDevtoolsTargetTriple}${chromeDevtoolsTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const chromeDevtoolsTargetPath = chromeDevtoolsTargetName ? join(sidecarDir, chromeDevtoolsTargetName) : null;
const chromeDevtoolsShimPath = resolve(__dirname, "chrome-devtools-mcp-shim.ts");
const chromeDevtoolsRsPath = resolve(__dirname, "chrome-devtools-mcp-shim.rs");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const findOpencodeBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeBaseName}`) || file.endsWith(`\\${opencodeBaseName}`)) ??
    candidates.find((file) => file.endsWith("/opencode.exe") || file.endsWith("\\opencode.exe")) ??
    candidates.find((file) => file.endsWith("/opencode") || file.endsWith("\\opencode")) ??
    null
  );
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

const parseChecksum = (content, assetName) => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, name] = trimmed.split(/\s+/);
    if (name === assetName) return hash.toLowerCase();
    if (trimmed.endsWith(` ${assetName}`)) {
      return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  }
  return null;
};

let didBuildOpenrindDesktopServer = false;
const shouldBuildOpenrindDesktopServer =
  forceBuild || !existsSync(openrindDesktopServerBuildPath) || isStubBinary(openrindDesktopServerBuildPath);

if (shouldBuildOpenrindDesktopServer) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(openrindDesktopServerBuildPath)) {
    try {
      unlinkSync(openrindDesktopServerBuildPath);
    } catch {
      // ignore
    }
  }
  const openrindDesktopServerScript = resolveBuildScript(openrindDesktopServerDir);
  if (!existsSync(openrindDesktopServerScript)) {
    console.error(`Openrind Desktop server build script not found at ${openrindDesktopServerScript}`);
    process.exit(1);
  }
  const openrindDesktopServerArgs = [openrindDesktopServerScript, "--outdir", sidecarDir, "--filename", "openrind-desktop-server"];
  if (bunTarget) {
    openrindDesktopServerArgs.push("--target", bunTarget);
  }
  const buildResult = spawnBun(resolveBunCommand(), openrindDesktopServerArgs, {
    cwd: openrindDesktopServerDir,
    stdio: "inherit",
  });

  if (buildResult.status !== 0) {
    console.error(`[prepare-sidecar] openrind-desktop-server build failed: status=${buildResult.status}, error=${buildResult.error}`);
    process.exit(buildResult.status ?? 1);
  }

  didBuildOpenrindDesktopServer = true;
}

if (existsSync(openrindDesktopServerBuildPath)) {
  const shouldCopyCanonical = didBuildOpenrindDesktopServer || !existsSync(openrindDesktopServerPath) || isStubBinary(openrindDesktopServerPath);
  if (shouldCopyCanonical && openrindDesktopServerBuildPath !== openrindDesktopServerPath) {
    safeCopyFileSync(openrindDesktopServerBuildPath, openrindDesktopServerPath);
  }

  if (openrindDesktopServerTargetPath) {
    const shouldCopyTarget =
      didBuildOpenrindDesktopServer || !existsSync(openrindDesktopServerTargetPath) || isStubBinary(openrindDesktopServerTargetPath);
    if (shouldCopyTarget && openrindDesktopServerBuildPath !== openrindDesktopServerTargetPath) {
      safeCopyFileSync(openrindDesktopServerBuildPath, openrindDesktopServerTargetPath);
    }
  }
}

if (!existingOpencodeVersion && opencodeCandidatePath) {
  existingOpencodeVersion =
    existsSync(opencodeCandidatePath) && !isStubBinary(opencodeCandidatePath)
      ? readBinaryVersion(opencodeCandidatePath)
      : null;
}

const normalizedOpencodeVersion = normalizeVersion(opencodeVersion);

if (!normalizedOpencodeVersion) {
  console.error(
    `OpenCode version could not be resolved from ${constantsPath}.`
  );
  process.exit(1);
}

const opencodeAssetByTarget = {
  "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
  "x86_64-apple-darwin": "opencode-darwin-x64-baseline.zip",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64-baseline.tar.gz",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64.tar.gz",
  "x86_64-pc-windows-msvc": "opencode-windows-x64-baseline.zip",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64.zip",
};

const opencodeAsset =
  opencodeAssetOverride ?? (resolvedTargetTriple ? opencodeAssetByTarget[resolvedTargetTriple] : null);

const opencodeUrl = opencodeAsset
  ? `https://github.com/${opencodeGithubRepo}/releases/download/v${normalizedOpencodeVersion}/${opencodeAsset}`
  : null;

const shouldDownloadOpencode =
  !opencodeCandidatePath ||
  !existsSync(opencodeCandidatePath) ||
  isStubBinary(opencodeCandidatePath) ||
  !existingOpencodeVersion ||
  existingOpencodeVersion !== normalizedOpencodeVersion;

if (!shouldDownloadOpencode) {
  console.log(`OpenCode sidecar already present (${existingOpencodeVersion}).`);
}

if (shouldDownloadOpencode) {
  if (!opencodeAsset || !opencodeUrl) {
    console.error(
      `No OpenCode asset configured for target ${resolvedTargetTriple ?? "unknown"}. Set OPENCODE_ASSET to override.`
    );
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archivePath = join(tmpdir(), `opencode-${stamp}-${opencodeAsset}`);
  const extractDir = join(tmpdir(), `opencode-${stamp}`);

  mkdirSync(extractDir, { recursive: true });

  if (process.platform === "win32") {
    const psQuote = (value) => `'${value.replace(/\\/g, "/").replace(/'/g, "''")}'`;
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      `Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(opencodeUrl)} -OutFile ${psQuote(archivePath)}`,
      `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
      `try { [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(archivePath)}, ${psQuote(extractDir)}) } catch { Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} }`,
    ].join("; ");

    const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
      stdio: "inherit",
    });

    if (result.status !== 0) {
      console.error(`[prepare-sidecar] opencode download failed: status=${result.status}, error=${result.error}`);
      process.exit(result.status ?? 1);
    }
  } else {
    const downloadResult = spawnSync("curl", ["-fsSL", "-o", archivePath, opencodeUrl], {
      stdio: "inherit",
    });
    if (downloadResult.status !== 0) {
      process.exit(downloadResult.status ?? 1);
    }

    mkdirSync(extractDir, { recursive: true });

    if (opencodeAsset.endsWith(".zip")) {
      const unzipResult = spawnSync("unzip", ["-q", archivePath, "-d", extractDir], {
        stdio: "inherit",
      });
      if (unzipResult.status !== 0) {
        process.exit(unzipResult.status ?? 1);
      }
    } else if (opencodeAsset.endsWith(".tar.gz")) {
      const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
        stdio: "inherit",
      });
      if (tarResult.status !== 0) {
        process.exit(tarResult.status ?? 1);
      }
    } else {
      console.error(`Unknown OpenCode archive type: ${opencodeAsset}`);
      process.exit(1);
    }
  }

  const extractedBinary = findOpencodeBinary(extractDir);
  if (!extractedBinary) {
    console.error("OpenCode binary not found after extraction.");
    process.exit(1);
  }

  const opencodeTargets = [opencodeTargetPath, opencodePath].filter(Boolean);
  for (const target of opencodeTargets) {
    safeCopyFileSync(extractedBinary, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore chmod errors on Windows
    }
  }

  console.log(`OpenCode sidecar updated to ${normalizedOpencodeVersion}.`);
}

// Build orchestrator sidecar
let didBuildOrchestrator = false;
const shouldBuildOrchestrator =
  forceBuild || !existsSync(orchestratorBuildPath) || isStubBinary(orchestratorBuildPath);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  const orchestratorArgs = [
    orchestratorBuildScript,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnBun(resolveBunCommand(), orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    console.error(`[prepare-sidecar] orchestrator build failed: status=${result.status}, error=${result.error}`);
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical =
    didBuildOrchestrator || !existsSync(orchestratorPath) || isStubBinary(orchestratorPath);
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    safeCopyFileSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget =
      didBuildOrchestrator || !existsSync(orchestratorTargetPath) || isStubBinary(orchestratorTargetPath);
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      safeCopyFileSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

// Build chrome-devtools-mcp shim sidecar
let didBuildChromeDevtools = false;
const shouldBuildChromeDevtools =
  forceBuild || !existsSync(chromeDevtoolsBuildPath) || isStubBinary(chromeDevtoolsBuildPath);
if (shouldBuildChromeDevtools) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(chromeDevtoolsBuildPath)) {
    try {
      unlinkSync(chromeDevtoolsBuildPath);
    } catch {
      // ignore
    }
  }

  let builtWithRustc = false;
  if (existsSync(chromeDevtoolsRsPath)) {
    const rustcCheck = spawnSync("rustc", ["--version"], { stdio: "ignore" });
    if (rustcCheck.status === 0) {
      console.log("[prepare-sidecar] Compiling lightweight chrome-devtools-mcp shim with rustc...");
      const rustcResult = spawnSync(
        "rustc",
        ["-C", "opt-level=z", "-C", "panic=abort", chromeDevtoolsRsPath, "-o", chromeDevtoolsBuildPath],
        { stdio: "inherit" },
      );
      if (rustcResult.status === 0) {
        builtWithRustc = true;
        didBuildChromeDevtools = true;
      }
    }
  }

  if (!builtWithRustc) {
    if (!existsSync(chromeDevtoolsShimPath)) {
      console.error(`Chrome DevTools MCP shim source not found at ${chromeDevtoolsShimPath}`);
      process.exit(1);
    }

    const relativeChromeDevtoolsBuildPath = relative(__dirname, chromeDevtoolsBuildPath);
    const chromeDevtoolsArgs = [
      "build",
      "--compile",
      chromeDevtoolsShimPath,
      "--outfile",
      relativeChromeDevtoolsBuildPath,
    ];
    if (bunTarget) {
      chromeDevtoolsArgs.push("--target", bunTarget);
    }

    const result = spawnBun(resolveBunCommand(), chromeDevtoolsArgs, {
      cwd: __dirname,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        BUN_ENV: "production",
      },
    });
    if (result.status !== 0) {
      console.error(`[prepare-sidecar] chrome-devtools-mcp build failed: status=${result.status}, error=${result.error}`);
      process.exit(result.status ?? 1);
    }

    didBuildChromeDevtools = true;
  }
}

if (existsSync(chromeDevtoolsBuildPath)) {
  const shouldCopyCanonical =
    didBuildChromeDevtools || !existsSync(chromeDevtoolsPath) || isStubBinary(chromeDevtoolsPath);
  if (shouldCopyCanonical && chromeDevtoolsBuildPath !== chromeDevtoolsPath) {
    safeCopyFileSync(chromeDevtoolsBuildPath, chromeDevtoolsPath);
  }

  if (chromeDevtoolsTargetPath) {
    const shouldCopyTarget =
      didBuildChromeDevtools || !existsSync(chromeDevtoolsTargetPath) || isStubBinary(chromeDevtoolsTargetPath);
    if (shouldCopyTarget && chromeDevtoolsBuildPath !== chromeDevtoolsTargetPath) {
      safeCopyFileSync(chromeDevtoolsBuildPath, chromeDevtoolsTargetPath);
    }
  }
}

adHocSignDarwinSidecars([
  opencodePath,
  opencodeTargetPath,
  openrindDesktopServerBuildPath,
  openrindDesktopServerPath,
  openrindDesktopServerTargetPath,
  orchestratorBuildPath,
  orchestratorPath,
  orchestratorTargetPath,
  chromeDevtoolsBuildPath,
  chromeDevtoolsPath,
  chromeDevtoolsTargetPath,
]);

const openrindDesktopServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(openrindDesktopServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: opencodeCandidatePath && existsSync(opencodeCandidatePath) ? sha256File(opencodeCandidatePath) : null,
  },
  "openrind-desktop-server": {
    version: openrindDesktopServerVersion,
    sha256: existsSync(openrindDesktopServerPath) ? sha256File(openrindDesktopServerPath) : null,
  },
  "openrind-desktop-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath) ? sha256File(orchestratorPath) : null,
  },
  "chrome-devtools-mcp": {
    version: chromeDevtoolsMcpVersion,
    sha256: existsSync(chromeDevtoolsPath) ? sha256File(chromeDevtoolsPath) : null,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = isWindowsTarget ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
