import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronRoot = resolve(desktopRoot, "electron");

const pnpmCmd = process.platform === "win32" ? "corepack.cmd" : "pnpm";
const pnpmArgs = process.platform === "win32" ? ["pnpm@10.27.0"] : [];
const nodeCmd = process.execPath;

function run(command, args, cwd, env) {
  // Only .cmd/.bat shims (e.g. pnpm.cmd) need a shell on Windows. To avoid
  // Node's DEP0190 DeprecationWarning, pass the formatted command string
  // when shell is true instead of passing an args array with shell: true.
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = useShell
    ? spawnSync(
        [command, ...args.map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" "),
        {
          cwd,
          stdio: "inherit",
          shell: true,
          env: env ? { ...process.env, ...env } : process.env,
        },
      )
    : spawnSync(command, args, {
        cwd,
        stdio: "inherit",
        env: env ? { ...process.env, ...env } : process.env,
      });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(nodeCmd, [resolve(__dirname, "build-diagnostics.mjs")], desktopRoot);
run(nodeCmd, [resolve(__dirname, "prepare-sidecar.mjs"), "--force", "--outdir", electronSidecarDir], desktopRoot);
// OPENRIND_DESKTOP_ELECTRON_BUILD tells Vite to emit relative asset paths so
// index.html resolves /assets/* correctly when loaded via file:// from
// inside the packaged .app bundle.
run(pnpmCmd, [...pnpmArgs, "--filter", "@openrind/app", "build"], repoRoot, {
  OPENRIND_DESKTOP_ELECTRON_BUILD: "1",
});
for (const fileName of readdirSync(electronRoot).filter((name) => name.endsWith(".mjs")).sort()) {
  run(nodeCmd, ["--check", resolve(electronRoot, fileName)], repoRoot);
}
run(nodeCmd, [resolve(__dirname, "check-electron-bridge.mjs")], repoRoot);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      renderer: "apps/app/dist",
      electronMain: "apps/desktop/electron/main.mjs",
      electronPreload: "apps/desktop/electron/preload.mjs",
    },
    null,
    2,
  )}\n`,
);
