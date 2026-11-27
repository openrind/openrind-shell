// Real Linux OpenShell + Chromium + unchanged agent-browser acceptance fixture.
// The owner fixture has no FUSE, Haloop, Claude, or Desktop UI. Test those separately.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { browserPodBinding } from '../../../../apps/desktop/electron/openshell/browser-binding.mjs';
import { startWidgetFixture } from './argide/widget-host.mjs';
import { createTask, publicTask, registerDynamicTask } from '../../../ctf-runtime/src/tasks.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const binaryDir = resolve(process.env.OPENSHELL_BINARY_DIR || join(root, 'vendor/openshell/target/debug'));
const binary = join(binaryDir, 'openshell');
const ownerImage = process.env.BROWSER_OWNER_IMAGE || 'openrind-browser-owner:e2e';
const podImage = process.env.BROWSER_POD_IMAGE || 'openrind-browser-pod:e2e';
const testHyperbrowser = process.argv.includes('--hyperbrowser');
const testArgide = process.argv.includes('--argide');
const testWidget = process.argv.includes('--argide-widget');
const ctfTaskDirArg = process.argv.find(arg => arg.startsWith('--ctf-task-dir='));
const ctfTaskDir = ctfTaskDirArg
  ? resolve(ctfTaskDirArg.slice('--ctf-task-dir='.length))
  : (process.env.OPENRIND_CTF_TASK_DIR ? resolve(process.env.OPENRIND_CTF_TASK_DIR) : null);
// There are no bundled CTF tasks. The --ctf path runs one user-supplied
// challenge directory and skips with a clear message when none is provided.
let testCtf = process.argv.includes('--ctf');
if (testCtf && !ctfTaskDir) {
  console.log('SKIP: --ctf needs a challenge directory. Pass --ctf-task-dir=<path> or set OPENRIND_CTF_TASK_DIR. Running the standard browser fixture instead.');
  testCtf = false;
}
const ctfModel = process.env.OPENRIND_CTF_MODEL || 'openai/gpt-4o-mini';
const state = await mkdtemp(join(tmpdir(), 'openrind-browser-live-'));
const tag = randomBytes(4).toString('hex');
const ownerName = `bowner-${tag}`;
const namespace = `browser-e2e-${tag}`;
const network = `browser-e2e-${tag}`;
const token = randomBytes(32).toString('base64url');
const env = { ...process.env, XDG_CONFIG_HOME: join(state, 'xdg'), OPENSHELL_TELEMETRY_DISABLED: '1' };
const evidence = { state, tests: [], fixture: 'native-browser-only', startedAt: new Date().toISOString() };
let gateway; let broker; let endpoint; let binding; let networkCreated = false; let gatewayReady = false;
let widgetFixture; let widgetLog; let staticPodContainer;
const ctfChallenges = [];

async function run(file, args, options = {}) {
  try {
    const task = exec(file, args, { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, ...options });
    if (options.stream) {
      task.child.stdout?.pipe(process.stdout);
      task.child.stderr?.pipe(process.stderr);
    }
    task.child.stdin.end(options.stdin);
    const result = await task;
    return (result.stdout + (options.includeStderr ? result.stderr : '')).trim();
  } catch (error) {
    const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
    throw new Error(`${file.split('/').pop()} failed: ${detail.replaceAll(token, '[redacted]').slice(-8192)}`);
  }
}
const os = (args, options) => run(binary, ['--gateway-endpoint', endpoint, ...args], options);
const inside = (args, options) => os(['sandbox', 'exec', '-n', ownerName, '--no-tty', '--', ...args], options);
async function service(file, args, name, extraEnv = {}) {
  const log = await open(join(state, `${name}.log`), 'wx', 0o600);
  try {
    const child = spawn(file, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  } finally { await log.close(); }
}
async function until(action, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { return await action(); } catch (error) { last = error; await sleep(500); }
  }
  throw last || new Error('Timed out');
}
function pass(name, details = {}) {
  evidence.tests.push({ name, ...details });
  console.log(`PASS ${name}`);
}
async function pods() {
  return JSON.parse(await os(['sandbox', 'list', '-o', 'json']))
    .filter(s => s.labels?.['openrind.browser.session']);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exit = new Promise(resolve => child.once('exit', resolve));
  await Promise.race([exit, sleep(20_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
}

// Load task metadata from a user-supplied challenge directory. The directory
// conventions match the Desktop service: challenge.json or task.toml for
// metadata, flag.txt (or chall|challenge/flag.txt) for the judge, and a
// chall|challenge subdir (or a root server file) for the app entrypoint.
async function loadCtfTask(dir) {
  if (!existsSync(dir)) throw new Error(`CTF task directory does not exist: ${dir}`);
  const id = basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  let title = basename(dir).split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let description = '';
  let flag = '';
  let backendPort = 8080;
  let entrypoint = '';
  const read = async path => { try { return await readFile(path, 'utf8'); } catch { return ''; } };
  if (existsSync(join(dir, 'challenge.json'))) {
    try {
      const data = JSON.parse(await read(join(dir, 'challenge.json')));
      title = data.name || data.title || title;
      description = data.description || description;
      flag = data.flag || flag;
      backendPort = Number(data.internal_port || data.backendPort || backendPort);
      entrypoint = data.entrypoint || entrypoint;
    } catch {}
  } else if (existsSync(join(dir, 'task.toml'))) {
    const toml = await read(join(dir, 'task.toml'));
    const nameMatch = toml.match(/name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) title = nameMatch[1].split('/').pop();
    const descMatch = toml.match(/description\s*=\s*["']([^"']+)["']/);
    if (descMatch) description = descMatch[1];
    const portMatch = toml.match(/web_service_port\s*=\s*(\d+)/);
    if (portMatch) backendPort = Number(portMatch[1]);
  }
  if (!description) {
    for (const name of ['DESCRIPTION.md', 'instruction.md', 'README.md']) {
      description = (await read(join(dir, name))).trim();
      if (description) break;
    }
  }
  if (!flag) {
    for (const candidate of ['flag.txt', 'flag', 'chall/flag.txt', 'challenge/flag.txt']) {
      flag = (await read(join(dir, candidate))).trim();
      if (flag) break;
    }
  }
  if (!entrypoint) {
    for (const rel of ['chall/server.py', 'challenge/server.py', 'challenge/run.py', 'chall/run.py',
      'chall/app.py', 'challenge/app.py', 'server.py', 'app.py', 'run.py', 'main.py']) {
      if (existsSync(join(dir, rel))) { entrypoint = `/opt/openrind-ctf/task/${rel}`; break; }
    }
  }
  if (!flag) throw new Error(`CTF task directory ${dir} has no flag.txt; the challenge judge needs one.`);
  if (!entrypoint) {
    throw new Error(`CTF task directory ${dir} has no server entrypoint (looked for chall/server.py, challenge/run.py, server.py, app.py, run.py, main.py).`);
  }
  return registerDynamicTask({
    id, title, description, backendPort, entrypoint,
    workingDirectory: entrypoint.slice(0, entrypoint.lastIndexOf('/')),
    flag,
  });
}

// Stage a build context (runtime + generic Dockerfile + the task directory)
// and build the challenge image. The staged task copy always carries a
// challenge.json so the in-image challenge.mjs can resolve the task without
// the removed bundled registry.
async function buildCtfImage(task, dir) {
  const contextDir = join(state, 'ctf-build-context');
  await mkdir(join(contextDir, 'runtime', 'bin'), { recursive: true });
  const runtimeDir = join(root, 'openrind-desktop/packages/ctf-runtime');
  await cp(join(runtimeDir, 'package.json'), join(contextDir, 'runtime/package.json'));
  await cp(join(runtimeDir, 'src'), join(contextDir, 'runtime/src'), { recursive: true });
  await cp(join(runtimeDir, 'bin/challenge.mjs'), join(contextDir, 'runtime/bin/challenge.mjs'));
  await cp(join(root, 'sandboxes/ctf-challenge/Dockerfile'), join(contextDir, 'Dockerfile'));
  await cp(dir, join(contextDir, 'task'), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(await readFile(join(contextDir, 'task/challenge.json'), 'utf8')); } catch {}
  await writeFile(join(contextDir, 'task/challenge.json'), JSON.stringify({
    ...existing,
    id: task.id,
    name: task.title,
    description: task.description,
    backendPort: task.backendPort,
    entrypoint: task.entrypoint,
    workingDirectory: task.workingDirectory,
  }, null, 2));
  if (!existsSync(join(contextDir, 'task/flag.txt'))) {
    await writeFile(join(contextDir, 'task/flag.txt'), `${task.flag}\n`);
  }
  const image = `openrind-ctf-${task.id}:e2e`;
  await run('docker', ['build', '--pull=false', '-f', join(contextDir, 'Dockerfile'),
    '--build-arg', 'RUNTIME_DIR=runtime', '--build-arg', 'TASK_DIR=task',
    '-t', image, contextDir], { timeout: 600_000 });
  return image;
}

async function startCtfChallenge({ id, index, bridge, image }) {
  const task = createTask(id);
  const name = `ctf-${index}-${tag}`;
  const port = 19410 + index;
  const token = randomBytes(32).toString('base64url');
  const policyPath = join(state, `${id}-policy.json`);
  const policy = { version: 1, filesystem_policy: { include_workdir: true,
    read_only: ['/usr', '/lib', '/etc', '/opt', '/flag.txt', '/proc', '/dev/urandom'], read_write: ['/sandbox', '/tmp', '/dev/null', '/dev/shm'] },
    landlock: { compatibility: 'best_effort' }, process: { run_as_user: 'sandbox', run_as_group: 'sandbox' } };
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  await os(['sandbox', 'create', '--name', name, '--from', image, '--policy', policyPath,
    '--no-auto-providers', '--no-tty', '--', '/bin/true']);
  await os(['sandbox', 'exec', '-n', name, '--no-tty', '--', '/bin/sh', '-c',
    `mkdir -p /sandbox/ctf && setsid /usr/bin/node /opt/openrind-ctf/bin/challenge.mjs --task ${id} --judge-token ${token} --port 19401 --events /sandbox/ctf/events.jsonl </dev/null >/tmp/openrind-ctf.log 2>&1 &`]);
  const forward = await service(binary, ['--gateway-endpoint', endpoint, 'forward', 'service', name,
    '--target-host', '127.0.0.1', '--target-port', '19401', '--local', `${bridge}:${port}`], `${id}-forward`);
  try {
    await until(async () => {
      assert.equal(forward.exitCode, null, `${id} ForwardTcp exited before readiness`);
      const response = await fetch(`http://${bridge}:${port}/health`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
    });
  } catch (e) {
    try {
      const ctfLog = await os(['sandbox', 'exec', '-n', name, '--no-tty', '--', 'cat', '/tmp/openrind-ctf.log']);
      console.error('CHALLENGE LOG:\n' + ctfLog);
      const fwdLog = await readFile(join(state, `${id}-forward.log`), 'utf8');
      console.error('FORWARD LOG:\n' + fwdLog);
    } catch {}
    throw e;
  }
  const challenge = { id, task: publicTask(task), name, port, token, forward,
    endpoint: `http://host.openshell.internal:${port}`, bridgeAddress: bridge };
  ctfChallenges.push(challenge);
  return challenge;
}

async function runCtfAgent(challenge) {
  const clientDir = `/tmp/openrind-ctf-${tag}-${challenge.id}`;
  const keyPath = join(state, `${challenge.id}-openrouter.key`);
  const configPath = join(state, `${challenge.id}-agent.json`);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  assert.ok(apiKey, '--ctf requires OPENROUTER_API_KEY');
  const runId = `${challenge.id}-${tag}`;
  const maxSteps = Number(process.env.OPENRIND_CTF_MAX_STEPS || 50);
  const agentTimeoutMs = Number(process.env.OPENRIND_CTF_TIMEOUT_MS || Math.max(20 * 60_000, maxSteps * 40_000));
  const config = { endpoint: challenge.endpoint, judgeToken: challenge.token, runId, model: ctfModel,
    modelMode: 'openrouter-fixture', maxSteps,
    ...(process.env.OPENRIND_CTF_REASONING_EFFORT ? { reasoningEffort: process.env.OPENRIND_CTF_REASONING_EFFORT } : {}),
    keyPath: `${clientDir}/openrouter.key`, eventsPath: `/sandbox/work/ctf/${challenge.id}-agent-events.jsonl`,
    trajectoryPath: `/sandbox/work/ctf/${challenge.id}-trajectory.json`,
    challengeEventsPath: `/sandbox/work/ctf/${challenge.id}-challenge-events.jsonl`, task: challenge.task };
  challenge.config = config;
  challenge.capturePaths = [config.trajectoryPath, config.eventsPath, config.challengeEventsPath];
  await writeFile(keyPath, `${apiKey}\n`, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    await inside(['/bin/mkdir', '-p', `${clientDir}/src`, `${clientDir}/bin`, '/sandbox/work/ctf']);
    await os(['sandbox', 'upload', ownerName, keyPath, `${clientDir}/openrouter.key`]);
    await os(['sandbox', 'upload', ownerName, configPath, `${clientDir}/agent.json`]);
    const srcCode = await readFile(join(root, 'openrind-desktop/packages/ctf-runtime/src/agent.mjs'), 'utf8');
    const binCode = await readFile(join(root, 'openrind-desktop/packages/ctf-runtime/bin/agent.mjs'), 'utf8');
    await inside(['node', '-e', `
      require('fs').writeFileSync(${JSON.stringify(`${clientDir}/src/agent.mjs`)}, ${JSON.stringify(srcCode)});
      require('fs').writeFileSync(${JSON.stringify(`${clientDir}/bin/agent.mjs`)}, ${JSON.stringify(binCode)});
    `]);
    await inside(['/usr/bin/node', `${clientDir}/bin/agent.mjs`, `${clientDir}/agent.json`], { timeout: agentTimeoutMs, stream: true });
    const trajectory = JSON.parse(await inside(['/usr/bin/node', '-e',
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(config.trajectoryPath)}, "utf8"))`], { timeout: 10_000 }));
    assert.equal(trajectory.format, 'openrind-ctf-trajectory/v1');
    assert.equal(trajectory.task.id, challenge.id);
    assert.equal(trajectory.judge?.accepted, true);
    assert.ok(trajectory.steps.length > 0 && trajectory.steps.every(step => typeof step.thought === 'string'));
    assert.ok(trajectory.steps.every(step => !Object.hasOwn(step, 'reasoning')));
    await os(['sandbox', 'download', ownerName, config.eventsPath, join(state, `${challenge.id}-agent-events.jsonl`)]);
    const agentEvents = (await readFile(join(state, `${challenge.id}-agent-events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(agentEvents.filter(event => event.kind === 'model_call').length, trajectory.steps.length);
    assert.ok(agentEvents.some(event => event.kind === 'agent_complete'));
    const events = await os(['sandbox', 'download', challenge.name, '/sandbox/ctf/events.jsonl', join(state, `${challenge.id}-challenge-events.jsonl`)]);
    void events;
    const challengeEvents = (await readFile(join(state, `${challenge.id}-challenge-events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(challengeEvents.some(event => event.kind === 'site' && event.actor === runId), 'browser did not reach the task service');
    assert.ok(challengeEvents.some(event => event.kind === 'judge' && event.actor === runId && event.correct === true), 'judge did not accept the agent flag');
    await writeFile(join(state, `${challenge.id}-trajectory.json`), JSON.stringify(trajectory, null, 2), { mode: 0o600 });
    const tracesDir = join(root, 'ctf-traces');
    await mkdir(tracesDir, { recursive: true });
    await writeFile(join(tracesDir, `${challenge.id}-trajectory.json`), JSON.stringify(trajectory, null, 2), { mode: 0o644 });
    await writeFile(join(tracesDir, `${challenge.id}-agent-events.jsonl`), await readFile(join(state, `${challenge.id}-agent-events.jsonl`), 'utf8'), { mode: 0o644 });
    await writeFile(join(tracesDir, `${challenge.id}-challenge-events.jsonl`), await readFile(join(state, `${challenge.id}-challenge-events.jsonl`), 'utf8'), { mode: 0o644 });
    await rm(join(tracesDir, `${challenge.id}-failed-trajectory.json`), { force: true });
    await rm(join(tracesDir, `${challenge.id}-failed-agent-events.jsonl`), { force: true });
    pass(`custom Openrind agent solves ${challenge.task.title} through its browser pod`, { task: challenge.id, steps: trajectory.steps.length });
  } finally {
    await rm(keyPath, { force: true });
  }
}

console.log(`Evidence directory: ${state}`);
try {
  if (testWidget) {
    assert.ok(testArgide, '--argide-widget requires --argide and its test image');
    assert.ok(process.env.ARGIDE_WIDGET_BUNDLE, 'ARGIDE_WIDGET_BUNDLE is required');
    assert.ok(process.env.ARGIDE_BACKEND_URL, 'ARGIDE_BACKEND_URL is required');
  }
  let ctfTask = null;
  let ctfImage = null;
  if (testCtf) {
    assert.ok(process.env.OPENROUTER_API_KEY?.trim(), '--ctf requires OPENROUTER_API_KEY');
    ctfTask = await loadCtfTask(ctfTaskDir);
    ctfImage = await buildCtfImage(ctfTask, ctfTaskDir);
  }
  await run('docker', ['image', 'inspect', ownerImage]);
  const podDigest = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', podImage]);
  evidence.podImage = podDigest;
  await run('docker', ['network', 'create', network]); networkCreated = true;
  const bridge = await run('docker', ['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', network]);
  staticPodContainer = `openrind-browser-pod-${tag}`;
  await run('docker', ['rm', '-f', staticPodContainer]).catch(() => {});
  try {
    await run('docker', ['run', '-d', '--name', staticPodContainer, '--network', network,
      '-p', `${bridge}:9222:9222`,
      '--network-alias', 'openrind-browser-pod',
      '--add-host', `host.openshell.internal:${bridge}`,
      podImage]);
  } catch {
    await run('docker', ['rm', '-f', staticPodContainer]).catch(() => {});
    await run('docker', ['run', '-d', '--name', staticPodContainer, '--network', network,
      '-p', '9222:9222',
      '--network-alias', 'openrind-browser-pod',
      '--add-host', `host.openshell.internal:${bridge}`,
      podImage]);
  }
  const podIp = await run('docker', ['inspect', '--format',
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, staticPodContainer]);
  endpoint = 'http://127.0.0.1:19770';
  await mkdir(join(state, 'jwt'), { mode: 0o700 });
  await mkdir(join(state, 'broker'), { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await writeFile(join(state, 'jwt/key.pem'), keys.privateKey, { mode: 0o600 });
  await writeFile(join(state, 'jwt/public.pem'), keys.publicKey, { mode: 0o600 });
  await writeFile(join(state, 'jwt/kid'), `browser-${tag}`, { mode: 0o600 });
  const toml = `[openshell]
version = 1
[openshell.gateway]
bind_address = "127.0.0.1:19770"
log_level = "${process.env.BROWSER_E2E_LOG_LEVEL === 'debug' ? 'debug' : 'info'}"
compute_drivers = ["docker"]
disable_tls = true
[openshell.gateway.auth]
allow_unauthenticated_users = true
[openshell.gateway.gateway_jwt]
signing_key_path = "${state}/jwt/key.pem"
public_key_path = "${state}/jwt/public.pem"
kid_path = "${state}/jwt/kid"
gateway_id = "${namespace}"
ttl_secs = 0
[openshell.drivers.docker]
default_image = "${ownerImage}"
image_pull_policy = "Never"
sandbox_namespace = "${namespace}"
network_name = "${network}"
grpc_endpoint = "http://host.openshell.internal:19770"
supervisor_bin = "${binaryDir}/openshell-sandbox"
`;
  await writeFile(join(state, 'gateway.toml'), toml, { mode: 0o600 });
  gateway = await service(join(binaryDir, 'openshell-gateway'), ['--config', join(state, 'gateway.toml'),
    '--db-url', `sqlite:${state}/gateway.db?mode=rwc`], 'gateway');
  await until(async () => {
    assert.equal(gateway.exitCode, null, 'Test gateway exited before readiness');
    assert.match(await readFile(join(state, 'gateway.log'), 'utf8'), /Gateway listener bound address=127\.0\.0\.1:19770/);
    await os(['gateway', 'info'], { timeout: 3000 });
  });
  gatewayReady = true;
  pass('isolated vendored gateway ready');
  if (testCtf) {
    await startCtfChallenge({ id: ctfTask.id, index: 0, bridge, image: ctfImage });
    pass(`challenge service for ${ctfTask.title} ready in a separate sandbox`);
  }
  binding = browserPodBinding({ endpoint: 'http://host.openshell.internal:19301', bridgeAddress: bridge, bindingId: tag });
  await writeFile(join(state, 'profile.json'), JSON.stringify(binding.profile), { mode: 0o600 });
  await os(['provider', 'profile', 'import', '--file', join(state, 'profile.json')]);
  await os(['provider', 'create', '--name', binding.name, '--type', binding.name,
    '--credential', 'OPENRIND_BROWSER_POD_TOKEN'], { env: { ...env, OPENRIND_BROWSER_POD_TOKEN: token } });
  const policy = { version: 1, filesystem_policy: { include_workdir: true,
    read_only: ['/usr', '/lib', '/etc', '/opt', '/proc', '/dev/urandom'], read_write: ['/sandbox', '/tmp', '/dev/null'] },
    landlock: { compatibility: 'best_effort' }, process: { run_as_user: 'sandbox', run_as_group: 'sandbox' },
    network_policies: { browser: binding.networkPolicy,
      browser_pod: {
        name: 'browser-pod',
        endpoints: [
          { host: 'openrind-browser-pod', port: 9222 },
          { host: podIp, port: 9222, allowed_ips: [`${podIp}/32`] },
          { host: 'host.openshell.internal', port: 9222, allowed_ips: [`${bridge}/32`] },
          { host: '127.0.0.1', port: 9222 },
        ],
        binaries: [{ path: '/usr/bin/node' }],
      },
      ...(testCtf ? { model: { name: 'openrouter-model', endpoints: [{ host: 'openrouter.ai', port: 443, tls: 'skip' }],
        binaries: [{ path: '/usr/bin/curl' }] },
      ctf_judge: { name: 'ctf-judge', endpoints: ctfChallenges.map(challenge => ({ host: 'host.openshell.internal',
        port: challenge.port, protocol: 'rest', tls: 'none', allowed_ips: [`${bridge}/32`], enforcement: 'enforce',
        rules: [{ allow: { method: 'POST', path: '/v1/submit' } }, { allow: { method: 'GET', path: '/v1/events*' } }] })), binaries: [{ path: '/usr/bin/curl' }] } } : {}) } };
  await writeFile(join(state, 'owner-policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await os(['sandbox', 'create', '--name', ownerName, '--from', ownerImage,
    '--env', `BROWSER_POD_HOST=${podIp}`,
    '--env', `BROWSER_POD_PORT=9222`,
    '--policy', join(state, 'owner-policy.json'), '--no-auto-providers', '--no-tty', '--', '/bin/true']);
  await inside(['node', '-e', `
    const fs = require('fs');
    const p = '/etc/openrind-browser-pods/helper.json';
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      cfg.podHost = ${JSON.stringify(podIp)};
      fs.writeFileSync(p, JSON.stringify(cfg), { mode: 0o644 });
    } catch {}
  `]);
  await os(['sandbox', 'provider', 'attach', ownerName, binding.name]);
  const owner = JSON.parse(await os(['sandbox', 'get', ownerName, '-o', 'json']));
  const config = { listen: { host: bridge, port: 19301 }, runtime: { binary, gateway: endpoint,
    image: podDigest, stateDir: join(state, 'broker'), websiteHosts: ['example.com'],
    ...(testCtf ? { challengeEndpoints: ctfChallenges.map(({ port, bridgeAddress }) =>
      ({ host: 'host.openshell.internal', port, bridgeAddress })) } : {}), acceptNoSandbox: true },
    owners: [{ serviceToken: token, owner: { id: owner.id, generation: 'openshell-e2e', workspaceId: tag,
      helperOrigin: 'http://127.0.0.1:19300', providers: testHyperbrowser || testArgide ? ['kernel', 'hyperbrowser'] : ['kernel'],
      ...(testHyperbrowser || testArgide ? { compatibilityProfile: 'argide-0.91-browser-pods-v1' } : {}) } }] };
  await writeFile(join(state, 'broker.json'), JSON.stringify(config), { mode: 0o600 });
  broker = await service(process.execPath, [join(root, 'openrind-desktop/packages/browser-pods/bin/broker.mjs'),
    join(state, 'broker.json')], 'broker', { OPENRIND_BROWSER_PODS_EXPERIMENTAL: '1' });
  await until(async () => { assert.match(await readFile(join(state, 'broker.log'), 'utf8'), /Kernel broker ready/); });
  // Provider attachment is asynchronous. Probe a new process after each refresh.
  await until(async () => {
    const placeholderCheck = await inside(['node', '-e', 'console.log(Boolean(process.env.OPENRIND_BROWSER_POD_TOKEN))']);
    assert.equal(placeholderCheck, 'true');
  });
  await inside(['env', 'OPENRIND_BROWSER_PODS_EXPERIMENTAL=1', 'openrind-browser-pod-ensure']);
  pass('runtime provider attach and proxy-authenticated helper registration');
  if (process.env.BROWSER_E2E_DIAGNOSE === '1') {
    const created = JSON.parse(await inside(['node', '-e', 'fetch("http://127.0.0.1:19300/browsers",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))']));
    const pod = (await pods())[0];
    const probe = await os(['sandbox', 'exec', '-n', pod.name, '--no-tty', '--', 'node', '--input-type=module', '-'],
      { timeout: 15_000, stdin: await readFile(new URL('./cdp-probe.mjs', import.meta.url), 'utf8') });
    console.log(`Direct CDP diagnosis (not acceptance): ${probe}`);
    await inside(['node', '-e', `fetch("http://127.0.0.1:19300/browsers/${created.session_id}",{method:"DELETE"}).then(r=>console.log(r.status))`]);
    await until(async () => { assert.equal((await pods()).length, 0); });
  }
  assert.match(await inside(['agent-browser', '--version']), /0\.38\.2/);
  pass('agent-browser version check passed');
  const client = args => inside(['agent-browser', '--session', tag, '--json', ...args], { timeout: 90_000 });
  const start = performance.now();
  const opened = JSON.parse(await client(['open', 'https://example.com']));
  assert.equal(opened.success, true);
  pass('unchanged agent-browser Kernel create and real Chromium navigation', { durationMs: Math.round(performance.now() - start) });
  if (testCtf) {
    for (const challenge of ctfChallenges) {
      try {
        await runCtfAgent(challenge);
      } finally {
        await inside(['agent-browser', '--session', `${challenge.id}-${tag}`, '--json', 'close'], { timeout: 90_000 }).catch(() => {});
      }
    }
  } else {
  assert.equal(first.length, 1);
  assert.match(await client(['snapshot', '-i']), /Example Domain|Learn more/);
  assert.match(await client(['get', 'title']), /Example Domain/);
  const after = await pods();
  assert.equal(after.length, 1); assert.equal(after[0].id, first[0].id);
  pass('separate native exec/client commands reuse one provider browser');
  const screenshot = JSON.parse(await client(['screenshot', '/sandbox/browser-evidence.png']));
  assert.equal(screenshot.success, true);
  const png = Buffer.from(await inside(['node', '-e', 'console.log(require("fs").readFileSync("/sandbox/browser-evidence.png").toString("base64"))']), 'base64');
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  await writeFile(join(state, 'page.png'), png, { mode: 0o600 });
  pass('real screenshot bytes reach the owner', { bytes: png.length });
  await client(['eval', 'document.body.innerHTML = \'<label>Name <input id="name"></label><button id="submit">Submit</button>\'; document.querySelector("#submit").onclick = () => { document.title = "Submitted: " + document.querySelector("#name").value; }; "fixture-ready"']);
  await client(['fill', '#name', 'Openrind browser test']);
  await client(['click', '#submit']);
  assert.match(await client(['get', 'title']), /Submitted: Openrind browser test/);
  pass('real click and fill on a deterministic in-page fixture');
  const commandTimes = [];
  for (let i = 0; i < 10; i++) {
    const began = performance.now();
    assert.match(await client(['get', 'title']), /Submitted: Openrind browser test/);
    commandTimes.push(Math.round(performance.now() - began));
  }
  assert.equal((await pods())[0].id, first[0].id);
  pass('ten successive client liveness probes retain the page', { commandTimesMs: commandTimes });
  const children = (await readFile(`/proc/${broker.pid}/task/${broker.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  const forwards = [];
  for (const pid of children) {
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').then(text => text.split('\0')).catch(() => []);
    if (args[0] === binary && args.includes(first[0].name) && args.includes('forward') &&
      args[args.indexOf('--target-port') + 1] === '9230') forwards.push(Number(pid));
  }
  assert.equal(forwards.length, 1, 'fault injection must identify one test-owned control forward');
  process.kill(forwards[0], 'SIGSTOP');
  try {
    await sleep(3500);
    assert.equal((await pods())[0]?.id, first[0].id);
    assert.match(await client(['get', 'title']), /Submitted: Openrind browser test/);
  } finally { try { process.kill(forwards[0], 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  await sleep(2000);
  assert.equal((await pods())[0]?.id, first[0].id);
  assert.match(await client(['get', 'title']), /Submitted: Openrind browser test/);
  pass('a delayed control lease preserves the real browser and page');
  for (const direction of ['response', 'request']) {
    const receipt = JSON.parse(await inside(['node', '--input-type=module', '-', tag, direction], {
      stdin: await readFile(new URL('./large-messages.mjs', import.meta.url), 'utf8'), timeout: 90_000,
    }));
    assert.equal(receipt.result, 'passed'); assert.equal(receipt.bytes, 17 * 1024 * 1024);
    assert.equal((await pods())[0].id, first[0].id);
    pass(`17 MiB CDP ${direction} crosses the real OpenShell proxy`, { bytes: receipt.bytes });
  }
  await assert.rejects(client(['open', 'https://example.org']), /ERR_TUNNEL_CONNECTION_FAILED/);
  const podContainer = await run('docker', ['ps', '--filter', `name=-${first[0].id}`, '--format', '{{.ID}}']);
  assert.match(podContainer, /^[a-f0-9]+$/);
  const policyLog = await run('docker', ['logs', '--tail', '2000', podContainer], { includeStderr: true });
  assert.match(policyLog, /DENIED \/usr\/lib\/chromium\/chromium\(\d+\) -> example\.org:443 .*reason:endpoint example\.org:443 is not allowed by any policy/);
  await writeFile(join(state, 'pod-policy.log'), policyLog.replaceAll(token, '[redacted]'), { mode: 0o600 });
  pass('native website allowlist rejects a denied destination');
  await assert.rejects(client(['download', 'https://example.com', '/tmp/denied']), /denied|policy|blocked/i);
  pass('managed client rejects native download');
  await assert.rejects(client(['upload', '#name', '/sandbox/not-in-the-browser']), /denied|policy|blocked/i);
  pass('managed client rejects native upload');
  await assert.rejects(client(['wait', '--download', '/sandbox/work/report.pdf']), /denied|policy|blocked/i);
  pass('managed client rejects wait --download');
  await os(['sandbox', 'exec', '-n', first[0].name, '--no-tty', '--', 'node', '-e',
    'const fs=require("fs");let killed=0;for(const p of fs.readdirSync("/proc").filter(x=>/^\\d+$/.test(x))){try{const c=fs.readFileSync(`/proc/${p}/cmdline`,"utf8").split("\\0");if(c[0]==="/usr/lib/chromium/chromium"&&!c.some(a=>a.startsWith("--type="))){process.kill(Number(p),"SIGKILL");killed++}}catch{}}if(killed!==1)process.exit(1);']);
  await until(async () => { assert.equal((await pods()).length, 0); }, 30_000);
  const recovered = JSON.parse(await client(['open', 'https://example.com']));
  assert.equal(recovered.success, true);
  const replacement = await pods();
  assert.equal(replacement.length, 1); assert.notEqual(replacement[0].id, first[0].id);
  assert.match(await client(['get', 'title']), /Example Domain/);
  pass('client replaces a crashed browser with one new pod');
  await client(['close']);
  await until(async () => { assert.equal((await pods()).length, 0); }, 60_000);
  pass('provider DELETE removes its browser pod');
  }
  if (testHyperbrowser) {
    const receipt = JSON.parse(await inside(['node', '/opt/hyperbrowser-fixture/consumer.mjs'], { timeout: 180_000 }));
    assert.equal(receipt.result, 'passed'); assert.equal(receipt.checks.length, 8);
    await writeFile(join(state, 'hyperbrowser.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    for (const name of receipt.checks) pass(name);
    await until(async () => { assert.equal((await pods()).length, 0); }, 60_000);
    pass('Hyperbrowser pod cleanup releases its resource');
  }
  if (testArgide) {
    const output = await inside(['node', '/opt/argide-test/consumer.mjs'], { timeout: 180_000 });
    const line = output.split('\n').find(line => line.startsWith('ARGIDE_RESULT='));
    assert.ok(line, 'The actual Argide consumer did not return a receipt');
    const receipt = JSON.parse(line.slice('ARGIDE_RESULT='.length));
    assert.equal(receipt.result, 'passed'); assert.equal(receipt.checks.length, 5);
    await writeFile(join(state, 'argide.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    for (const name of receipt.checks) pass(name);
    await until(async () => { assert.equal((await pods()).length, 0); }, 60_000);
    pass('Actual Argide consumer releases its browser pod');
  }
  if (testWidget) {
    const bridge = await run('docker', ['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', network]);
    widgetFixture = await startWidgetFixture(bridge, {
      bundle: process.env.ARGIDE_WIDGET_BUNDLE, backend: process.env.ARGIDE_BACKEND_URL,
    });
    // Fixture-only addition to the next pod's initial policy. Hot policy changes
    // can invalidate an existing native relay; they are not part of this test.
    const policyPath = join(state, 'broker', 'pod-policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.network_policies.argide_fixture = widgetFixture.policy;
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    const task = inside(['node', '/opt/argide-test/widget-consumer.mjs'], { timeout: 180_000 });
    task.catch(() => {});
    await until(() => inside(['test', '-f', '/tmp/argide-widget-session-ready'], { timeout: 5000 }), 60_000);
    const pod = await until(async () => { const found = await pods(); assert.equal(found.length, 1); return found[0]; });
    const container = await run('docker', ['ps', '--filter', `name=-${pod.id}`, '--format', '{{.ID}}']);
    assert.ok(container, 'The widget browser pod has no running container');
    widgetLog = await service('docker', ['logs', '--follow', container], 'argide-supervisor');
    await inside(['touch', '/tmp/argide-widget-ready']);
    const output = await task;
    const line = output.split('\n').find(line => line.startsWith('ARGIDE_WIDGET_RESULT='));
    assert.ok(line, 'The actual Argide widget did not return a receipt');
    const receipt = JSON.parse(line.slice('ARGIDE_WIDGET_RESULT='.length));
    assert.equal(receipt.result, 'passed'); assert.equal(receipt.checks.length, 4);
    await writeFile(join(state, 'argide-widget.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    for (const name of receipt.checks) pass(name);
    const png = Buffer.from(await inside(['node', '-e', 'console.log(require("fs").readFileSync("/sandbox/argide-widget.png").toString("base64"))']), 'base64');
    await writeFile(join(state, 'argide-widget.png'), png, { mode: 0o600 });
    await until(async () => { assert.equal((await pods()).length, 0); }, 60_000);
    pass('Actual Argide widget test releases its browser pod');
  }
  await stopChild(broker);
  if (!testCtf) {
    const db = new DatabaseSync(join(state, 'broker', 'sessions.sqlite'), { readOnly: true });
    try {
      const sessions = db.prepare('SELECT data FROM sessions').all().map(row => JSON.parse(row.data));
      assert.ok(sessions.length > 0);
      assert.ok(sessions.every(s => s.resourceDeletedAt !== null && s.browserStoppedAt !== null));
      assert.ok(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE code='STOP_REQUEST'").get().count > 0);
    } finally { db.close(); }
    pass('durable registry confirms client DELETE, browser stop, and quota release');
  }
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = error.message.replaceAll(token, '[redacted]');
  console.error(evidence.error); process.exitCode = 1;
  if (gatewayReady && gateway?.exitCode === null) {
    if (testWidget) {
      for (const file of ['argide-widget-failure.json', 'argide-widget.png']) {
        try {
          const data = await inside(['node', '-e', `console.log(require("fs").readFileSync("/sandbox/${file}").toString("base64"))`], { timeout: 5000 });
          await writeFile(join(state, file), Buffer.from(data, 'base64'), { mode: 0o600 });
        } catch {}
      }
    }
    for (const challenge of ctfChallenges) {
      if (!challenge.config) continue;
      for (const [remote, local] of [[challenge.config.trajectoryPath, `${challenge.id}-failed-trajectory.json`],
        [challenge.config.eventsPath, `${challenge.id}-failed-agent-events.jsonl`]]) {
        try { await os(['sandbox', 'download', ownerName, remote, join(state, local)]); } catch {}
      }
    }
    try {
      const diagnostics = await inside(['sh', '-c', 'test ! -f /tmp/openrind-browser-pods/helper.log || cat /tmp/openrind-browser-pods/helper.log'], { timeout: 5000 });
      await writeFile(join(state, 'helper.log'), diagnostics.replaceAll(token, '[redacted]'), { mode: 0o600 });
      const profile = await inside(['node', '--input-type=module', '-e', 'import {validateClientProfile} from "/opt/openrind-browser-pods/src/client-profile.mjs"; const keys=["AGENT_BROWSER_PROVIDER","KERNEL_ENDPOINT","KERNEL_HEADLESS","KERNEL_STEALTH","AGENT_BROWSER_ACTION_POLICY"]; console.log(Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))); console.log("kernel_key_present",Boolean(process.env.KERNEL_API_KEY)); try{await validateClientProfile();console.log("profile_ok")}catch(e){console.log(e.code??e.message)}'], { timeout: 5000 });
      await writeFile(join(state, 'client-profile.log'), profile, { mode: 0o600 });
      for (const pod of await pods()) {
        const container = await run('docker', ['ps', '-a', '--filter', `name=-${pod.id}`, '--format', '{{.ID}}']);
        if (container) {
          const logs = await run('docker', ['logs', '--tail', '2000', container], { includeStderr: true });
          await writeFile(join(state, `${pod.name}-supervisor.log`), logs.replaceAll(token, '[redacted]'), { mode: 0o600 });
        }
        const logs = await os(['sandbox', 'exec', '-n', pod.name, '--no-tty', '--', 'sh', '-c',
          'cat /tmp/openrind-browser/agent.log /tmp/openrind-browser/chromium.log'], { timeout: 5000 });
        await writeFile(join(state, `${pod.name}.log`), logs.replaceAll(token, '[redacted]'), { mode: 0o600 });
        const probe = await os(['sandbox', 'exec', '-n', pod.name, '--no-tty', '--', 'node', '--input-type=module', '-'],
          { timeout: 15_000, stdin: await readFile(new URL('./cdp-probe.mjs', import.meta.url), 'utf8') });
        await writeFile(join(state, `${pod.name}-cdp.log`), probe, { mode: 0o600 });
      }
    } catch {}
  }
} finally {
  if (staticPodContainer) await run('docker', ['rm', '-f', staticPodContainer]).catch(() => {});
  await stopChild(widgetLog);
  await widgetFixture?.close();
  for (const challenge of ctfChallenges) await stopChild(challenge.forward);
  await stopChild(broker);
  // The namespace and resources below were created by this invocation only.
  if (gatewayReady && gateway?.exitCode === null) {
    try {
      const sandboxes = JSON.parse(await os(['sandbox', 'list', '-o', 'json']));
      for (const sandbox of sandboxes) await os(['sandbox', 'delete', sandbox.name]);
      if (binding) await os(['provider', 'delete', binding.name]).catch(() => {});
    } catch (error) { evidence.cleanupError = error.message; }
  }
  await stopChild(gateway);
  if (networkCreated) await run('docker', ['network', 'rm', network]).catch(error => { evidence.cleanupError = error.message; });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(state, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (evidence.cleanupError) { console.error('Cleanup needs review in evidence.json'); process.exitCode = 1; }
  console.log(`Result: ${evidence.result}. Evidence: ${join(state, 'evidence.json')}`);
}
