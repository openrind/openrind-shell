import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
function run(args) {
  const result = spawnSync(electron, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["-p", "JSON.stringify({electron:process.versions.electron,node:process.versions.node})"]);
for (const path of [
  "../../../packages/capture/test/capture.test.mjs",
  "../../../packages/capture/test/diagnostics.test.mjs",
  "../__tests__/openshell/runtime-diagnostics.test.mjs",
  "../__tests__/openshell/diagnostic-route.test.mjs",
]) run([fileURLToPath(new URL(path, import.meta.url))]);
