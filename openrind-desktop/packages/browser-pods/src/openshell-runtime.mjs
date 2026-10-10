import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { MAX_ARTIFACT, MAX_MULTIPART, PodError, requireThat } from './contracts.mjs';
import { readJsonResponse, relayHttp, requestStream } from './http-stream.mjs';

export const CHROMIUM_BINARY = '/usr/lib/chromium/chromium';

export function browserPolicy(hosts, challengeEndpoints = []) {
  requireThat(Array.isArray(hosts) && hosts.length > 0 && hosts.length <= 64, 'WEBSITE_ALLOWLIST_REQUIRED');
  for (const host of hosts) {
    requireThat(typeof host === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) &&
      !/(?:^|\.)(?:localhost|internal|local)$/.test(host), 'INVALID_WEBSITE_HOST');
  }
  const endpoints = Array.isArray(challengeEndpoints) ? challengeEndpoints : [challengeEndpoints];
  requireThat(endpoints.length <= 16, 'TOO_MANY_CHALLENGE_ENDPOINTS');
  for (const challengeEndpoint of endpoints) {
    requireThat(challengeEndpoint?.host === 'host.openshell.internal' &&
      Number.isInteger(challengeEndpoint.port) && challengeEndpoint.port >= 1024 && challengeEndpoint.port <= 65535 &&
      isIP(challengeEndpoint.bridgeAddress) === 4 &&
      /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(challengeEndpoint.bridgeAddress) &&
      Array.isArray(challengeEndpoint.rules) && challengeEndpoint.rules.length > 0 && challengeEndpoint.rules.length <= 64,
    'INVALID_CHALLENGE_ENDPOINT');
    for (const rule of challengeEndpoint.rules) {
      requireThat(['GET', 'HEAD', 'POST'].includes(rule?.method) && typeof rule.path === 'string' &&
        rule.path.length <= 256 && (rule.path === '/' || /^\/[A-Za-z0-9_.\/-]+(?:\/\*\*)?$/.test(rule.path)) &&
        !rule.path.includes('..') && (!rule.path.includes('*') || rule.path.endsWith('/**')),
      'INVALID_CHALLENGE_ROUTE');
    }
  }
  const policy = { version: 1, filesystem_policy: { include_workdir: false,
    read_only: ['/usr', '/lib', '/etc', '/opt', '/proc', '/dev/urandom', '/sandbox'],
    read_write: ['/tmp', '/dev/null', '/dev/shm'] },
    landlock: { compatibility: 'best_effort' }, process: { run_as_user: 'sandbox', run_as_group: 'sandbox' },
    network_policies: { browser_web: { name: 'browser-web',
      endpoints: hosts.flatMap(host => [{ host, port: 80, tls: 'skip' }, { host, port: 443, tls: 'skip' }]),
      binaries: [{ path: CHROMIUM_BINARY }] } } };
  if (endpoints.length > 0) {
    policy.network_policies.challenge = { name: 'ctf-challenge-website',
      endpoints: endpoints.map(challengeEndpoint => ({ host: challengeEndpoint.host, port: challengeEndpoint.port,
        protocol: 'rest', tls: 'none', allowed_ips: [`${challengeEndpoint.bridgeAddress}/32`],
        enforcement: 'enforce', rules: challengeEndpoint.rules.map(({ method, path }) =>
          ({ allow: { method, path } })) })),
      binaries: [{ path: CHROMIUM_BINARY }] };
  }
  return policy;
}

export function runProcess(binary, args, { stdin = '', timeoutMs = 15_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = ''; let bytes = 0; let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); }
      else stdout += chunk;
    });
    // Drain diagnostics but do not expose command lines, provider data or URLs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new PodError('NATIVE_COMMAND_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !exceeded) resolve(stdout);
      else reject(new PodError(exceeded ? 'NATIVE_COMMAND_TIMEOUT' : 'NATIVE_COMMAND_FAILED'));
    });
    child.stdin.end(stdin);
  });
}

export function parseForwardLine(line, name, targetPort) {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/Forwarding 127\.0\.0\.1:(\d+) -> 127\.0\.0\.1:(\d+) in sandbox ([a-z0-9-]+) via gRPC/);
  if (!match || Number(match[2]) !== targetPort || match[3] !== name) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export class OpenShellRuntime {
  constructor({ binary, gateway, image, stateDir, websiteHosts, challengeEndpoints, challengeEndpoint, acceptNoSandbox, run = runProcess,
    clock = () => performance.now(), leaseFailureMs = 8000 }) {
    requireThat(isAbsolute(binary) && isAbsolute(stateDir), 'ABSOLUTE_RUNTIME_PATH_REQUIRED');
    requireThat(/(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(image), 'PINNED_BROWSER_IMAGE_REQUIRED');
    requireThat(acceptNoSandbox === true, 'CHROMIUM_NO_SANDBOX_ACCEPTANCE_REQUIRED');
    const endpoint = new URL(gateway);
    requireThat(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password,
      'INVALID_GATEWAY');
    this.binary = binary; this.prefix = ['--gateway-endpoint', gateway]; this.image = image;
    this.stateDir = stateDir; this.policy = browserPolicy(websiteHosts, challengeEndpoints ?? challengeEndpoint); this.run = run;
    this.clock = clock; this.leaseFailureMs = leaseFailureMs;
    this.live = new Map();
  }
  command(args, options) { return this.run(this.binary, [...this.prefix, ...args], options); }
  async preflight() {
    await this.run('docker', ['image', 'inspect', this.image]);
    await this.command(['gateway', 'info']);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    this.policyPath = join(this.stateDir, 'pod-policy.json');
    await writeFile(this.policyPath, JSON.stringify(this.policy), { mode: 0o600 });
  }
  async inventory(session) {
    const list = JSON.parse(await this.command(['sandbox', 'list', '--selector',
      `openrind.browser.session=${session.id}`, '--limit', '100', '-o', 'json']));
    requireThat(Array.isArray(list) && list.length < 100, 'INVALID_RUNTIME_INVENTORY');
    const matches = list.filter(item => item.name === session.name && item.labels?.['openrind.browser.session'] === session.id);
    requireThat(matches.length <= 1, 'RUNTIME_IDENTITY_CONFLICT');
    const found = matches[0];
    if (found && session.handle?.id) requireThat(found.id === session.handle.id, 'RUNTIME_IDENTITY_CONFLICT');
    return found;
  }
  async forward(name, targetPort) {
    const args = [...this.prefix, 'forward', 'service', name, '--target-host', '127.0.0.1',
      '--target-port', String(targetPort), '--local', '127.0.0.1:0'];
    const child = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = ''; let closed = false;
    child.on('error', () => {});
    child.on('close', () => { closed = true; });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new PodError('FORWARD_TIMEOUT')); }, 5000);
      child.on('error', () => { clearTimeout(timer); reject(new PodError('FORWARD_FAILED')); });
      child.on('close', () => { clearTimeout(timer); reject(new PodError('FORWARD_LOST')); });
      child.stderr.on('data', chunk => {
        output = (output + chunk).slice(-16_384);
        const assigned = parseForwardLine(output, name, targetPort);
        if (assigned) { clearTimeout(timer); resolve(assigned); }
      });
    });
    return { port, get closed() { return closed; }, close: () => child.kill('SIGTERM') };
  }
  async control(live, method, path) {
    requireThat(!live.control.closed, 'CONTROL_FORWARD_LOST');
    const response = await fetch(`http://127.0.0.1:${live.control.port}${path}`, {
      method, headers: { authorization: `Bearer ${live.secret}` }, signal: AbortSignal.timeout(1500),
    });
    requireThat(response.ok, 'POD_CONTROL_FAILED');
    const value = await response.json();
    requireThat(value.sessionId === live.sessionId && (!live.instance || value.instance === live.instance), 'BROWSER_GENERATION_LOST');
    return value;
  }
  async provision(session, signal, onAllocated = () => {}) {
    requireThat(this.policyPath, 'RUNTIME_NOT_READY');
    const mounts = { docker: { mounts: [
      { type: 'tmpfs', target: '/dev/shm', size_bytes: 268435456, mode: 1023 },
      { type: 'tmpfs', target: '/tmp', size_bytes: 1073741824, mode: 1023 },
    ] } };
    await this.command(['sandbox', 'create', '--name', session.name, '--from', this.image,
      '--policy', this.policyPath, '--cpu', '2', '--memory', '2Gi', '--driver-config-json', JSON.stringify(mounts),
      '--label', `openrind.browser.session=${session.id}`, '--no-auto-providers', '--no-tty', '--', '/bin/true'],
      // An HTTP disconnect cancels admission, not the native create. Observe its
      // bounded result so a late sandbox has a handle and can be removed.
      { timeoutMs: 60_000 });
    const found = await this.inventory(session);
    requireThat(found?.id && found.phase === 'Ready', 'POD_NOT_READY');
    onAllocated({ id: found.id, instance: null });
    signal?.throwIfAborted();
    const secret = randomBytes(32).toString('base64url');
    const config = { sessionId: session.id, screen: session.options.effective.screen,
      saveDownloads: session.options.effective.saveDownloads, secret,
      diagnostics: process.env.BROWSER_POD_DIAGNOSTICS === '1' };
    await this.command(['sandbox', 'exec', '-n', session.name, '--no-tty', '--',
      '/usr/bin/node', '/opt/openrind-browser-pod/launch.mjs'], { stdin: JSON.stringify(config), signal });
    let cdp; let control;
    try {
      control = await this.forward(session.name, 9230);
      cdp = await this.forward(session.name, 9222);
      const live = { sessionId: session.id, secret, control, cdp, instance: null };
      let health;
      for (let i = 0; i < 30; i++) {
        signal?.throwIfAborted();
        try { health = await this.control(live, 'POST', '/lease'); if (health.state === 'ready') break; } catch {}
        await sleep(200, undefined, { signal });
      }
      requireThat(health?.state === 'ready' && /^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(health.cdpPath), 'BROWSER_NOT_READY');
      live.instance = health.instance; live.cdpPath = health.cdpPath; live.lastLeaseAt = this.clock();
      this.live.set(session.id, live);
      return { id: found.id, instance: health.instance };
    } catch (error) { control?.close(); cdp?.close(); throw error; }
  }
  cdpEndpoint(session) {
    const live = this.live.get(session.id);
    requireThat(live && !live.cdp.closed && session.handle.instance === live.instance, 'BROWSER_GENERATION_LOST');
    return `ws://127.0.0.1:${live.cdp.port}${live.cdpPath}`;
  }
  artifactTarget(session, path) {
    const live = this.live.get(session.id);
    requireThat(live && !live.control.closed && live.instance === session.handle.instance, 'BROWSER_GENERATION_LOST');
    return { url: `http://127.0.0.1:${live.control.port}${path}`,
      headers: { authorization: `Bearer ${live.secret}`, 'x-browser-instance': live.instance } };
  }
  async upload(session, req, signal) {
    const target = this.artifactTarget(session, '/uploads');
    const headers = { ...target.headers, 'content-type': req.headers['content-type'] ?? '' };
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    return readJsonResponse(await requestStream(target.url, { method: 'POST', headers, body: req, maxBytes: MAX_MULTIPART, signal }));
  }
  async downloads(session, signal) {
    const target = this.artifactTarget(session, '/downloads-url');
    return readJsonResponse(await requestStream(target.url, { method: 'GET', headers: target.headers, signal }));
  }
  async streamArtifact(session, id, req, res, signal) {
    const target = this.artifactTarget(session, `/artifacts/${id}`);
    return relayHttp(req, res, { ...target, maxResponse: MAX_ARTIFACT, signal });
  }
  async stop(session) {
    const live = this.live.get(session.id);
    if (live) {
      try { const status = await this.control(live, 'POST', '/stop'); if (status.state === 'stopped') return { stopped: true }; } catch {}
    }
    // A dead control process does not prove a dead browser. Fall back to confirmed
    // container removal, not to a fabricated stop acknowledgement.
    const result = await this.remove(session);
    return { stopped: result.deleted === true, deleted: result.deleted === true };
  }
  async remove(session) {
    const live = this.live.get(session.id);
    const found = await this.inventory(session);
    if (!found) {
      // With no observed handle, a timed-out create can still arrive later.
      requireThat(session.handle?.id, 'CREATE_OUTCOME_UNKNOWN');
    } else {
      if (process.env.BROWSER_POD_DIAGNOSTICS === '1') {
        try {
          const log = await this.command(['sandbox', 'exec', '-n', session.name, '--no-tty', '--',
            '/usr/bin/node', '-e', 'process.stdout.write(require("fs").readFileSync("/tmp/openrind-browser/netlog.json"))']);
          await writeFile(join(this.stateDir, `${session.id}-netlog.json`), log, { mode: 0o600 });
        } catch {}
      }
      await this.command(['sandbox', 'delete', session.name]);
      requireThat(!(await this.inventory({ ...session, handle: { id: found.id } })), 'CLEANUP_PENDING');
    }
    live?.control.close(); live?.cdp.close(); this.live.delete(session.id);
    return { deleted: true };
  }
  async heartbeat(core) {
    await Promise.all([...this.live].map(async ([id, live]) => {
      if (core.registry.get(id)?.accessRevokedAt !== null) return;
      live.lastLeaseAt ??= this.clock();
      try {
        requireThat(!live.cdp?.closed && !live.control?.closed, 'FORWARD_LOST');
        requireThat((await this.control(live, 'POST', '/lease')).state === 'ready', 'BROWSER_LOST');
        live.lastLeaseAt = this.clock();
      } catch (error) {
        const definite = ['FORWARD_LOST', 'CONTROL_FORWARD_LOST', 'BROWSER_GENERATION_LOST', 'BROWSER_LOST'].includes(error.code);
        if (definite || this.clock() - live.lastLeaseAt >= this.leaseFailureMs) core.revoke(id, 'RUNTIME_LOST');
      }
    }));
    // The caller schedules cleanup separately. A slow deletion must not cause
    // healthy pods to miss their control lease.
  }
  close() { for (const live of this.live.values()) { live.control.close(); live.cdp.close(); } this.live.clear(); }
}
