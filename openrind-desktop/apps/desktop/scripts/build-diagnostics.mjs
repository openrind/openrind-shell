import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../../../packages/capture/src/diagnostics.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("../electron/generated/runtime-diagnostics.cjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22.16",
  legalComments: "eof",
});
