import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Contributor-only packaging command. Supply an independently verified official
// Windows Node distribution; this command never downloads a runtime at launch.
const executable = process.argv[2];
if (process.platform !== 'win32' || process.argv.length !== 3 || !isAbsolute(executable ?? '')) {
  throw new Error('Usage on Windows: node stage-runtime.mjs ABSOLUTE_PATH_TO_VERIFIED_NODE_EXE');
}
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
const runtime = JSON.parse(execFileSync(executable, ['--experimental-sqlite', '-e',
  "require('node:sqlite');process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform}))"],
  { env, timeout: 10_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
if (runtime.platform !== 'win32' || !/^(?:22\.(?:1[2-9]|[2-9][0-9])\.\d+|24\.\d+\.\d+)$/.test(runtime.version)) throw new Error('Use Node 22.12+ or Node 24 with built-in SQLite');
const output = new URL('./browser-runtime/', import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(executable, new URL('node.exe', output));
const sha256 = {};
for (const name of ['worker.cjs', 'edge.cjs']) await copyFile(new URL(`./dist/${name}`, import.meta.url), new URL(name, output));
for (const name of ['node.exe', 'worker.cjs', 'edge.cjs']) {
  sha256[name] = createHash('sha256').update(await readFile(new URL(name, output))).digest('hex');
}
await writeFile(new URL('runtime-manifest.json', output), JSON.stringify({ protocol: 1, platform: runtime.platform,
  arch: runtime.arch, nodeVersion: runtime.version, sha256 }, null, 2) + '\n');
