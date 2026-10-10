// Real Linux OpenShell + Chromium + unchanged agent-browser acceptance fixture.
// --ctf-fuse adds the primary FUSE owner and delete/recreate persistence check.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { browserPodBinding } from '../../../../apps/desktop/electron/openshell/browser-binding.mjs';
import { startWidgetFixture } from './argide/widget-host.mjs';
import { createTask, publicTask } from '../../../ctf-runtime/src/tasks.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const binaryDir = resolve(process.env.OPENSHELL_BINARY_DIR || join(root, 'vendor/openshell/target/debug'));
const binary = join(binaryDir, 'openshell');
const testHyperbrowser = process.argv.includes('--hyperbrowser');
const testArgide = process.argv.includes('--argide');
const testWidget = process.argv.includes('--argide-widget');
const testCtfFuse = process.argv.includes('--ctf-fuse');
const testCtf = process.argv.includes('--ctf') || testCtfFuse;
const ownerImage = testCtfFuse
  ? (process.env.CTF_FUSE_OWNER_IMAGE || 'openrind-shell-fuse-browser-ctf:test')
  : (process.env.BROWSER_OWNER_IMAGE || 'openrind-browser-owner:e2e');
const podImage = process.env.BROWSER_POD_IMAGE || 'openrind-browser-pod:e2e';
const ctfImage = process.env.CTF_CHALLENGE_IMAGE || 'openrind-ctf-challenge:e2e';
const ctfModel = process.env.OPENRIND_CTF_MODEL || 'openai/gpt-4o-mini';
const state = await mkdtemp(join(tmpdir(), 'openrind-browser-live-'));
const tag = randomBytes(4).toString('hex');
const ownerName = `bowner-${tag}`;
const replacementOwnerName = `bowner-r-${tag}`;
const fuseWorkspaceId = `browser-ctf-${tag}`;
const browserSocketDir = `/tmp/openrind-agent-browser-${tag}`;
const fuseDatabaseUrlPath = join(state, 'fuse-database-url');
const namespace = `browser-e2e-${tag}`;
const network = `browser-e2e-${tag}`;
const token = randomBytes(32).toString('base64url');
const env = { ...process.env, XDG_CONFIG_HOME: join(state, 'xdg'), OPENSHELL_TELEMETRY_DISABLED: '1' };
delete env.OPENROUTER_API_KEY;
delete env.DATABASE_URL;
const evidence = { state, tests: [], fixture: testCtfFuse ? 'browser-ctf-fuse-persistence' : testCtf ? 'browser-ctf' : 'native-browser-only', startedAt: new Date().toISOString() };
let gateway; let broker; let endpoint; let binding; let networkCreated = false; let gatewayReady = false;
let widgetFixture; let widgetLog;
const ctfChallenges = [];

async function run(file, args, options = {}) {
  try {
    const task = exec(file, args, { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, ...options });
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
const inSandbox = (name, args, options) => os(['sandbox', 'exec', '-n', name, '--no-tty', '--', ...args], options);
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

function ownerCreateArgs(name, policyPath) {
  const args = ['sandbox', 'create', '--name', name, '--from', ownerImage];
  if (testCtfFuse) {
    args.push('--fuse', '--env', `OPENRIND_SHELL_WORKSPACE_ID=${fuseWorkspaceId}`,
      '--upload', `${fuseDatabaseUrlPath}:/sandbox/db-url`);
  } else {
    args.push('--policy', policyPath);
  }
  args.push('--no-auto-providers', '--no-tty', '--', ...(testCtfFuse ? ['openrind-shell-init'] : ['/bin/true']));
  return args;
}

async function addCtfOwnerPolicy(name, bridge) {
  const args = ['policy', 'update', name,
    '--add-endpoint', 'openrouter.ai:443',
    '--binary', '/usr/bin/curl'];
  for (const challenge of ctfChallenges) {
    const host = 'host.openshell.internal';
    args.push('--add-endpoint', `${host}:${challenge.port}::rest:enforce:allowed-ip=${bridge}/32`,
      '--add-allow', `${host}:${challenge.port}:POST:/v1/submit`,
      '--add-allow', `${host}:${challenge.port}:GET:/v1/events`);
  }
  args.push('--wait');
  await os(args);
}

async function addBrowserHelperPolicy(name, bridge, binding) {
  const endpoint = binding.networkPolicy.endpoints[0];
  const binary = binding.networkPolicy.binaries[0].path;
  const args = ['policy', 'update', name,
    '--add-endpoint', `${endpoint.host}:${endpoint.port}::${endpoint.protocol}:enforce:allowed-ip=${bridge}/32`,
    '--binary', binary];
  for (const rule of endpoint.rules) {
    args.push('--add-allow', `${endpoint.host}:${endpoint.port}:${rule.allow.method}:${rule.allow.path}`);
  }
  args.push('--wait');
  await os(args);
}

async function captureHashes(name, challenges) {
  const paths = challenges.flatMap(challenge => challenge.capturePaths);
  const script = 'const fs=require("node:fs"),crypto=require("node:crypto");' +
    'console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(path=>' +
    '[path,crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")]))));';
  return JSON.parse(await inSandbox(name, ['/usr/bin/node', '-e', script, ...paths], { timeout: 30_000 }));
}

async function verifyCtfFusePersistence(challenges) {
  await inside(['openrind-shell-fused', 'flush-all'], { timeout: 120_000 });
  const before = await captureHashes(ownerName, challenges);
  assert.equal(Object.keys(before).length, challenges.length * 3);
  pass('real CTF trajectory and event files are flushed and hashed on FUSE', { files: Object.keys(before).length });

  await stopChild(broker);
  await os(['sandbox', 'delete', ownerName]);
  await os(ownerCreateArgs(replacementOwnerName));
  const health = await until(async () => {
    const value = JSON.parse(await inSandbox(replacementOwnerName, ['openrind-shell-fused', 'health'], { timeout: 10_000 }));
    assert.equal(value.state, 'writable');
    return value;
  }, 90_000);
  assert.equal(health.state, 'writable');

  const after = await captureHashes(replacementOwnerName, challenges);
  assert.deepEqual(after, before, 'FUSE files changed after owner recreation');
  for (const challenge of challenges) {
    for (const path of challenge.capturePaths) {
      const destination = join(state, `recreated-${challenge.id}-${path.split('/').at(-1)}`);
      await os(['sandbox', 'download', replacementOwnerName, path, destination]);
      const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
      assert.equal(digest, before[path], `read-back hash differs for ${path}`);
    }
  }
  evidence.ctfPersistence = { workspaceId: fuseWorkspaceId, hashesBefore: before, hashesAfter: after };
  pass('trajectory, agent events, and exported challenge events read back with matching hashes after FUSE owner recreation',
    { files: Object.keys(after).length, workspaceId: fuseWorkspaceId });
}

async function startCtfChallenge({ id, index, bridge, image }) {
  const task = createTask(id);
  const name = `ctf-${index}-${tag}`;
  const port = 19410 + index;
  const token = randomBytes(32).toString('base64url');
  const policyPath = join(state, `${id}-policy.json`);
  const policy = { version: 1, filesystem_policy: { include_workdir: true,
    read_only: ['/usr', '/lib', '/etc', '/opt', '/proc', '/dev/urandom'], read_write: ['/sandbox', '/tmp', '/dev/null'] },
    landlock: { compatibility: 'best_effort' }, process: { run_as_user: 'sandbox', run_as_group: 'sandbox' } };
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  await os(['sandbox', 'create', '--name', name, '--from', image, '--policy', policyPath,
    '--no-auto-providers', '--no-tty', '--', '/bin/true']);
  await os(['sandbox', 'exec', '-n', name, '--no-tty', '--', '/bin/sh', '-c',
    `mkdir -p /sandbox/ctf && setsid /usr/bin/node /opt/openrind-ctf/bin/challenge.mjs --task ${id} --judge-token ${token} --port 19401 --events /sandbox/ctf/events.jsonl </dev/null >/tmp/openrind-ctf.log 2>&1 &`]);
  const forward = await service(binary, ['--gateway-endpoint', endpoint, 'forward', 'service', name,
    '--target-host', '127.0.0.1', '--target-port', '19401', '--local', `${bridge}:${port}`], `${id}-forward`);
  await until(async () => {
    assert.equal(forward.exitCode, null, `${id} ForwardTcp exited before readiness`);
    const response = await fetch(`http://${bridge}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
  });
  const challenge = { id, task: publicTask(task), name, port, token, forward,
    endpoint: `http://host.openshell.internal:${port}`, bridgeAddress: bridge };
  ctfChallenges.push(challenge);
  return challenge;
}

async function runCtfAgent(challenge) {
  const clientDir = `/tmp/openrind-ctf-${tag}-${challenge.id}`;
  const socketDir = `${clientDir}/agent-browser-sockets`;
  const keyPath = join(state, `${challenge.id}-openrouter.key`);
  const configPath = join(state, `${challenge.id}-agent.json`);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  assert.ok(apiKey, '--ctf requires OPENROUTER_API_KEY');
  const runId = `${challenge.id}-${tag}`;
  const config = { endpoint: challenge.endpoint, judgeToken: challenge.token, runId, model: ctfModel,
    modelMode: 'openrouter-fixture',
    ...(process.env.OPENRIND_CTF_REASONING_EFFORT ? { reasoningEffort: process.env.OPENRIND_CTF_REASONING_EFFORT } : {}),
    keyPath: `${clientDir}/openrouter.key`, eventsPath: `/sandbox/work/ctf/${challenge.id}-agent-events.jsonl`,
    trajectoryPath: `/sandbox/work/ctf/${challenge.id}-trajectory.json`,
    challengeEventsPath: `/sandbox/work/ctf/${challenge.id}-challenge-events.jsonl`, task: challenge.task };
  challenge.config = config;
  challenge.capturePaths = [config.trajectoryPath, config.eventsPath, config.challengeEventsPath];
  await writeFile(keyPath, `${apiKey}\n`, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    await inside(['/bin/mkdir', '-p', `${clientDir}/src`, `${clientDir}/bin`, socketDir, '/sandbox/work/ctf']);
    await os(['sandbox', 'upload', ownerName, keyPath, `${clientDir}/openrouter.key`]);
    await os(['sandbox', 'upload', ownerName, configPath, `${clientDir}/agent.json`]);
    await os(['sandbox', 'upload', '--no-git-ignore', ownerName,
      join(root, 'openrind-desktop/packages/ctf-runtime/src/agent.mjs'), `${clientDir}/src/agent.mjs`]);
    await os(['sandbox', 'upload', '--no-git-ignore', ownerName,
      join(root, 'openrind-desktop/packages/ctf-runtime/bin/agent.mjs'), `${clientDir}/bin/agent.mjs`]);
    await inside(['env', `AGENT_BROWSER_SOCKET_DIR=${socketDir}`, '/usr/bin/node',
      `${clientDir}/bin/agent.mjs`, `${clientDir}/agent.json`], { timeout: 12 * 60_000 });
    const trajectory = JSON.parse(await inside(['/usr/bin/node', '-e',
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(config.trajectoryPath)}, "utf8"))`], { timeout: 10_000 }));
    assert.equal(trajectory.format, 'openrind-ctf-trajectory/v1');
    assert.equal(trajectory.task.id, challenge.id);
    assert.equal(trajectory.judge?.accepted, true);
    assert.equal(trajectory.challengeEventExport?.complete, true);
    assert.ok(trajectory.steps.length > 0 && trajectory.steps.every(step => typeof step.thought === 'string'));
    assert.ok(trajectory.steps.every(step => !Object.hasOwn(step, 'reasoning')));
    await os(['sandbox', 'download', ownerName, config.eventsPath, join(state, `${challenge.id}-agent-events.jsonl`)]);
    const agentEvents = (await readFile(join(state, `${challenge.id}-agent-events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(agentEvents.filter(event => event.kind === 'model_call').length, trajectory.steps.length);
    assert.ok(agentEvents.some(event => event.kind === 'agent_complete'));
    await os(['sandbox', 'download', ownerName, config.challengeEventsPath, join(state, `${challenge.id}-exported-challenge-events.jsonl`)]);
    const exportedEvents = (await readFile(join(state, `${challenge.id}-exported-challenge-events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(exportedEvents.some(event => event.kind === 'judge' && event.correct === true));
    const events = await os(['sandbox', 'download', challenge.name, '/sandbox/ctf/events.jsonl', join(state, `${challenge.id}-challenge-events.jsonl`)]);
    void events;
    const challengeEvents = (await readFile(join(state, `${challenge.id}-challenge-events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(challengeEvents.some(event => event.kind === 'site' && event.actor === runId), 'browser did not reach the task service');
    assert.ok(challengeEvents.some(event => event.kind === 'judge' && event.actor === runId && event.correct === true), 'judge did not accept the agent flag');
    await writeFile(join(state, `${challenge.id}-trajectory.json`), JSON.stringify(trajectory, null, 2), { mode: 0o600 });
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
  if (testCtfFuse) {
    assert.ok(!testHyperbrowser && !testArgide && !testWidget,
      '--ctf-fuse cannot be combined with Hyperbrowser or Argide modes');
    assert.ok(process.env.DATABASE_URL?.trim(), '--ctf-fuse requires DATABASE_URL for the local TLS PostgreSQL fixture');
    await writeFile(fuseDatabaseUrlPath, `${process.env.DATABASE_URL.trim()}\n`, { mode: 0o600 });
  }
  if (testCtf) {
    assert.ok(process.env.OPENROUTER_API_KEY?.trim(), '--ctf requires OPENROUTER_API_KEY');
    await run('docker', ['image', 'inspect', ctfImage]);
  }
  await run('docker', ['image', 'inspect', ownerImage]);
  const podDigest = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', podImage]);
  evidence.podImage = podDigest;
  await run('docker', ['network', 'create', network]); networkCreated = true;
  const bridge = await run('docker', ['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', network]);
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
enable_fuse = ${testCtfFuse ? 'true' : 'false'}
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
    for (const [index, id] of ['flag-command', 'glacier-exchange'].entries()) {
      await startCtfChallenge({ id, index, bridge, image: ctfImage });
    }
    pass('two Openrind-native CTF challenge services are ready in separate sandboxes');
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
      ...(!testCtfFuse && testCtf ? { model: { name: 'openrouter-model', endpoints: [{ host: 'openrouter.ai', port: 443, tls: 'skip' }],
        binaries: [{ path: '/usr/bin/curl' }] },
      ctf_judge: { name: 'ctf-judge', endpoints: ctfChallenges.map(challenge => ({ host: 'host.openshell.internal',
        port: challenge.port, protocol: 'rest', tls: 'none', allowed_ips: [`${bridge}/32`], enforcement: 'enforce',
        rules: [{ allow: { method: 'POST', path: '/v1/submit' } },
          { allow: { method: 'GET', path: '/v1/events' } }] })), binaries: [{ path: '/usr/bin/curl' }] } } : {}) } };
  const ownerPolicyPath = join(state, 'owner-policy.json');
  if (!testCtfFuse) await writeFile(ownerPolicyPath, JSON.stringify(policy), { mode: 0o600 });
  await os(ownerCreateArgs(ownerName, ownerPolicyPath));
  await os(['sandbox', 'provider', 'attach', ownerName, binding.name]);
  if (testCtfFuse) {
    await addBrowserHelperPolicy(ownerName, bridge, binding);
    await addCtfOwnerPolicy(ownerName, bridge);
  }
  const owner = JSON.parse(await os(['sandbox', 'get', ownerName, '-o', 'json']));
  const config = { listen: { host: bridge, port: 19301 }, runtime: { binary, gateway: endpoint,
    image: podDigest, stateDir: join(state, 'broker'), websiteHosts: ['example.com'],
    ...(testCtf ? { challengeEndpoints: ctfChallenges.map(({ port, bridgeAddress }) =>
      ({ host: 'host.openshell.internal', port, bridgeAddress })) } : {}), acceptNoSandbox: true },
    owners: [{ serviceToken: token, owner: { id: owner.id, generation: 'openshell-e2e', workspaceId: testCtfFuse ? fuseWorkspaceId : tag,
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
  if (testCtfFuse) {
    await inside(['node', '/opt/openrind-browser-pods/bin/helper-probe.mjs']);
    const socketProbe = await inside(['node', '--input-type=module', '-e', `
      import net from 'node:net';
      const path = '/tmp/openrind-unix-probe-${tag}.sock';
      const server = net.createServer((socket) => socket.end('ok'));
      await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve));
      const response = await new Promise((resolve, reject) => {
        const client = net.createConnection(path);
        client.once('data', (data) => resolve(data.toString()));
        client.once('error', reject);
      });
      await new Promise((resolve) => server.close(resolve));
      if (response !== 'ok') process.exit(1);
      console.log('AF_UNIX bind/connect passed');
    `]);
    assert.match(socketProbe, /AF_UNIX bind\/connect passed/);
    pass('FUSE owner permits the local AF_UNIX daemon transport');
  }
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
  await inside(['/bin/mkdir', '-p', browserSocketDir]);
  const client = args => inside(['env', `AGENT_BROWSER_SOCKET_DIR=${browserSocketDir}`,
    'agent-browser', '--session', tag, '--json', ...args], { timeout: 90_000 });
  const start = performance.now();
  let opened;
  try {
    opened = JSON.parse(await client(['open', 'https://example.com']));
  } catch (error) {
    if (testCtfFuse) {
      try {
        const debug = await inside(['env', `AGENT_BROWSER_SOCKET_DIR=${browserSocketDir}`,
          'agent-browser', '--debug', '--session', tag, '--json', 'open', 'https://example.com'], { timeout: 30_000 });
        await writeFile(join(state, 'agent-browser-debug.log'), debug, { mode: 0o600 });
      } catch (debugError) {
        await writeFile(join(state, 'agent-browser-debug.log'), debugError.message, { mode: 0o600 });
      }
      try {
        const daemonLog = await inside(['sh', '-c', 'printf "HOME=%s\\n" "$HOME"; for f in "$HOME/.agent-browser/default.log" "$HOME/.agent-browser/daemon.log"; do if [ -f "$f" ]; then printf "\\n--- %s ---\\n" "$f"; cat "$f"; fi; done'], { timeout: 5000 });
        await writeFile(join(state, 'agent-browser-daemon.log'), daemonLog, { mode: 0o600 });
      } catch (diagnosticError) {
        await writeFile(join(state, 'agent-browser-daemon.log'), diagnosticError.message, { mode: 0o600 });
      }
    }
    throw error;
  }
  assert.equal(opened.success, true);
  pass('unchanged agent-browser Kernel create and real Chromium navigation', { durationMs: Math.round(performance.now() - start) });
  const first = await pods();
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
    const receipt = JSON.parse(await inside(['env', `AGENT_BROWSER_SOCKET_DIR=${browserSocketDir}`,
      'node', '--input-type=module', '-', tag, direction], {
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
  if (testCtf) {
    for (const challenge of ctfChallenges) {
      try {
        await runCtfAgent(challenge);
      } finally {
        await inside(['env', `AGENT_BROWSER_SOCKET_DIR=/tmp/openrind-ctf-${tag}-${challenge.id}/agent-browser-sockets`,
          'agent-browser', '--session', `${challenge.id}-${tag}`, '--json', 'close'], { timeout: 90_000 }).catch(() => {});
        await until(async () => { assert.equal((await pods()).length, 0); }, 60_000);
      }
    }
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
  const db = new DatabaseSync(join(state, 'broker', 'sessions.sqlite'), { readOnly: true });
  try {
    const sessions = db.prepare('SELECT data FROM sessions').all().map(row => JSON.parse(row.data));
    assert.ok(sessions.length > 0);
    assert.ok(sessions.every(s => s.resourceDeletedAt !== null && s.browserStoppedAt !== null));
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE code='STOP_REQUEST'").get().count > 0);
  } finally { db.close(); }
  pass('durable registry confirms client DELETE, browser stop, and quota release');
  if (testCtfFuse) await verifyCtfFusePersistence(ctfChallenges);
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
        [challenge.config.eventsPath, `${challenge.id}-failed-agent-events.jsonl`],
        [challenge.config.challengeEventsPath, `${challenge.id}-failed-challenge-events.jsonl`]]) {
        try { await os(['sandbox', 'download', ownerName, remote, join(state, local)]); } catch {}
      }
    }
    try {
      const diagnostics = await inside(['sh', '-c', 'test ! -f /tmp/openrind-browser-pods/helper.log || cat /tmp/openrind-browser-pods/helper.log'], { timeout: 5000 });
      await writeFile(join(state, 'helper.log'), diagnostics.replaceAll(token, '[redacted]'), { mode: 0o600 });
      const profile = await inside(['node', '--input-type=module', '-e', 'import {validateClientProfile} from "/opt/openrind-browser-pods/src/client-profile.mjs"; const keys=["HOME","XDG_RUNTIME_DIR","AGENT_BROWSER_SOCKET_DIR","AGENT_BROWSER_PROVIDER","KERNEL_ENDPOINT","KERNEL_HEADLESS","KERNEL_STEALTH","AGENT_BROWSER_ACTION_POLICY"]; console.log(Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))); console.log("kernel_key_present",Boolean(process.env.KERNEL_API_KEY)); try{await validateClientProfile();console.log("profile_ok")}catch(e){console.log(e.code??e.message)}'], { timeout: 5000 });
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
  await rm(fuseDatabaseUrlPath, { force: true });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(state, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (evidence.cleanupError) { console.error('Cleanup needs review in evidence.json'); process.exitCode = 1; }
  console.log(`Result: ${evidence.result}. Evidence: ${join(state, 'evidence.json')}`);
}
