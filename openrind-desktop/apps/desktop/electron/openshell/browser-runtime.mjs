import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { browserBinding } from './browser-binding.mjs';
import { DISTRO_NAME, wslRun, wslSpawn } from './wsl.mjs';
import { resolveBrowserResources } from './browser-resources.mjs';

export async function startInstalledBrowserRuntime({ resourcesPath, databasePath, port, image, onDisconnect }) {
  const resources = await resolveBrowserResources(resourcesPath);
  return startBrowserRuntime({ ...resources, databasePath, port, image, onDisconnect });
}

// Main-process API. Paths and port come from installed resource provisioning,
// never a renderer message. Requires a Node runtime with built-in SQLite.
export async function startBrowserRuntime({ resourceRoot, nodeExecutable, databasePath, port, image, onDisconnect = () => {} }) {
  if (![resourceRoot, nodeExecutable, databasePath].every(value => typeof value === 'string' && isAbsolute(value)) ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image)) throw new Error('Invalid browser runtime provisioning');
  const network = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'network', 'inspect', 'openshell-docker',
    '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'], { timeout: 15_000 });
  if (network.exitCode !== 0) throw new Error('Browser bridge network is unavailable');
  const bridgeAddress = network.stdout.trim();
  const bindingId = randomBytes(16).toString('hex');
  const endpoint = `http://host.openshell.internal:${port}/mcp`;
  browserBinding({ endpoint, bridgeAddress, bindingId });
  const mapped = await wslRun(['-d', DISTRO_NAME, '--', 'wslpath', '-a', join(resourceRoot, 'edge.cjs').replaceAll('\\', '/')], { timeout: 10_000 });
  const edgePath = mapped.stdout.trim();
  if (mapped.exitCode !== 0 || !edgePath.startsWith('/') || /[\r\n,]/.test(edgePath)) throw new Error('Browser edge resource is unavailable');
  const serviceToken = randomBytes(32).toString('base64url');
  const container = `openrind-browser-${bindingId}`;
  // Do not inherit Node injection settings, model credentials or database URLs.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  const worker = fork(join(resourceRoot, 'worker.cjs'), [], {
    execPath: nodeExecutable, execArgv: ['--experimental-sqlite'], env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let edge;
  let ready = false;
  let closing;
  let startupReject;
  const pending = new Map();
  const close = () => {
    if (closing) return closing;
    ready = false;
    startupReject?.(new Error('Browser runtime stopped during startup'));
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser runtime disconnected')); }
    pending.clear();
    // IPC loss revokes worker grants; EOF closes the owned bridge, with no restart.
    if (worker.connected) worker.disconnect();
    closing = Promise.resolve().then(async () => {
      try {
        let absent = false;
        for (let attempt = 0; attempt < 3 && !absent; attempt++) {
          await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'rm', '-f', container], { timeout: 15_000 });
          // --rm can race explicit removal. Verify absence instead of treating
          // an already-in-progress Docker removal as a leaked container.
          const remaining = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'ps', '-a',
            '--filter', `name=^/${container}$`, '--format', '{{.ID}}'], { timeout: 10_000 });
          absent = remaining.exitCode === 0 && remaining.stdout.trim() === '';
        }
        if (!absent) throw new Error('Browser edge cleanup is incomplete');
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (edge && edge.exitCode === null && edge.signalCode === null) edge.kill();
      }
    });
    return closing;
  };
  const failed = () => {
    const wasReady = ready;
    void close().catch(() => {});
    if (wasReady) { try { onDisconnect(); } catch { /* Cleanup must continue. */ } }
  };
  worker.once('error', failed); worker.once('exit', failed);
  worker.stdin.on('error', failed);
  // Diagnostics are drained, never relayed as potentially sensitive raw output.
  worker.stderr.resume();
  let startupTimer;
  try {
    const started = new Promise((resolve, reject) => {
      startupReject = reject;
      let workerReady = false, edgeReady = false;
      const finish = () => { if (workerReady && edgeReady) resolve(); };
      startupTimer = setTimeout(() => reject(new Error('Browser runtime startup timed out')), 15_000);
      worker.on('message', message => {
        if (message?.type === 'ready' && message.protocol === 1) { workerReady = true; finish(); return; }
        if (message?.type !== 'result' || typeof message.id !== 'string') return failed();
        const request = pending.get(message.id);
        if (!request) return failed();
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.value);
        else request.reject(new Error('Browser control request failed'));
      });
      edge = wslSpawn(['-d', DISTRO_NAME, '--', 'docker', 'run', '--rm', '-i', '--name', container,
        '--network', 'host', '--entrypoint', '/usr/bin/node',
        '-e', `OPENRIND_BROWSER_BRIDGE_ADDRESS=${bridgeAddress}`, '-e', `OPENRIND_BROWSER_BRIDGE_PORT=${port}`,
        '--mount', `type=bind,src=${edgePath},dst=/opt/openrind-browser-edge.cjs,readonly`, image, '/opt/openrind-browser-edge.cjs']);
      edge.once('error', failed); edge.once('exit', failed); edge.stdin.on('error', failed);
      edge.stdout.pipe(worker.stdin); worker.stdout.pipe(edge.stdin);
      let diagnostics = '';
      edge.stderr.on('data', bytes => {
        diagnostics = (diagnostics + bytes.toString()).slice(-1024);
        if (diagnostics.split(/\r?\n/).includes('openrind-browser: edge ready')) { edgeReady = true; finish(); }
      });
      worker.send({ type: 'initialize', databasePath, serviceToken }, error => { if (error) failed(); });
    });
    await started;
    if (closing) throw new Error('Browser runtime disconnected');
    ready = true;
  } catch {
    await close().catch(() => {});
    throw new Error('Browser runtime startup failed');
  } finally { clearTimeout(startupTimer); startupReject = undefined; }
  const request = (type, fields) => new Promise((resolve, reject) => {
    if (!ready || pending.size >= 32) { reject(new Error('Browser runtime is unavailable')); return; }
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { failed(); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    worker.send({ id, type, ...fields }, error => { if (error) failed(); });
  });
  return Object.freeze({ endpoint, bridgeAddress, bindingId, serviceToken,
    get ready() { return ready; },
    beginLaunch: (scope, policy) => request('begin', { scope, policy }),
    heartbeat: launchId => request('heartbeat', { launchId }),
    stopLaunch: launchId => request('stop', { launchId }), close,
  });
}
