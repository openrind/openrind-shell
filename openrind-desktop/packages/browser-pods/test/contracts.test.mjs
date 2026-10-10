import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kernelRequest } from '../src/broker.mjs';
import { brokerAddress, readConfig } from '../src/config.mjs';
import { validateClientProfile } from '../src/client-profile.mjs';
import { PodError, MAX_JSON, parseProbeResult } from '../src/contracts.mjs';
import { browserPolicy, OpenShellRuntime, parseForwardLine } from '../src/openshell-runtime.mjs';
import { cdpCall, clientRequest, jsonBody, OpenShellProxyAgent, relayWebSockets } from '../src/transport.mjs';
import { browserPodBinding } from '../../../apps/desktop/electron/openshell/browser-binding.mjs';

test('Kernel routes expose only owner loopback and confirm stop before 204', async () => {
  const calls = [];
  const id = 'bb906980-4d9a-47b1-9791-1a62b09d1186';
  const core = { create: async (owner, options) => {
    calls.push([owner.id, options.provider]); return { id, attachment: 'x'.repeat(43) };
  }, stop: async (owner, target) => { calls.push([owner.id, target]); } };
  const owner = { id: 'owner' };
  const result = await kernelRequest(core, owner, { method: 'POST', path: '/browsers', body: { headless: true } });
  assert.equal(result.body.session_id, id);
  assert.equal(result.body.cdp_ws_url, `ws://127.0.0.1:19300/cdp/${'x'.repeat(43)}`);
  assert.equal((await kernelRequest(core, owner, { method: 'DELETE', path: `/browsers/${id}` })).status, 204);
  assert.deepEqual(calls, [['owner', 'kernel'], ['owner', id]]);
  core.stop = async () => { throw new PodError('STOP_UNCONFIRMED', 504); };
  await assert.rejects(kernelRequest(core, owner, { method: 'DELETE', path: `/browsers/${id}` }), { code: 'STOP_UNCONFIRMED' });
  for (const path of ['/json/version', '/mcp', '/sessions']) {
    await assert.rejects(kernelRequest(core, owner, { method: 'GET', path }), { code: 'ROUTE_NOT_FOUND' });
  }
});

test('route validation rejects browser Origins, alternate destinations and arbitrary query data', () => {
  const request = (url, headers = {}) => ({ url, headers });
  assert.equal(clientRequest(request('/cdp/id?keepAlive=true')).search, '?keepAlive=true');
  for (const url of ['http://other/control', '//other/control', '/cdp/id?token=secret', '/%63ontrol', '/control#x',
    '/control?x=1', '/cdp/id?keepAlive=true&keepAlive=false']) assert.throws(() => clientRequest(request(url)));
  assert.throws(() => clientRequest(request('/control', { origin: 'https://evil.example' })), { code: 'ORIGIN_DENIED' });
});

test('provider JSON has a size limit; malformed and wrong content types fail', async () => {
  function request(text, type = 'application/json') {
    const req = Readable.from([Buffer.from(text)]); req.headers = { 'content-type': type }; return req;
  }
  assert.deepEqual(await jsonBody(request('{"headless":true}')), { headless: true });
  await assert.rejects(jsonBody(request('{')), { code: 'INVALID_JSON' });
  await assert.rejects(jsonBody(request('{}', 'text/plain')), { code: 'JSON_REQUIRED' });
  await assert.rejects(jsonBody(request(' '.repeat(MAX_JSON + 1))), { code: 'BODY_TOO_LARGE' });
});

test('control replies reject malformed JSON, invalid shapes and untyped results', () => {
  const valid = { type: 'probe-result', requestId: 'bb906980-4d9a-47b1-9791-1a62b09d1186', ok: true };
  for (const ok of [true, false]) {
    const message = { ...valid, ok };
    assert.deepEqual(parseProbeResult(Buffer.from(JSON.stringify(message))), message);
  }
  for (const value of [null, [], 1, 'text', {}, { ...valid, type: 'ready' },
    { ...valid, requestId: 'invalid' }, { ...valid, ok: 'true' }, { ...valid, ok: null }]) {
    assert.throws(() => parseProbeResult(Buffer.from(JSON.stringify(value))), { code: 'INVALID_CONTROL_MESSAGE' });
  }
  assert.throws(() => parseProbeResult(Buffer.from('{')), { code: 'INVALID_CONTROL_MESSAGE' });
});

test('CDP probes fail safely on malformed replies and remove their listeners', async () => {
  for (const value of ['null', '[]', '"text"', 'false', '{']) {
    const ws = new EventEmitter(); ws.send = () => {};
    const result = cdpCall(ws, 'Browser.getVersion');
    const rejected = assert.rejects(result, { code: 'CDP_PROBE_FAILED' });
    assert.doesNotThrow(() => ws.emit('message', Buffer.from(value)));
    await rejected;
    assert.equal(ws.listenerCount('message'), 0);
    assert.equal(ws.listenerCount('close'), 0);
    assert.equal(ws.listenerCount('error'), 0);
  }
});

test('CDP probes fail on disconnect instead of waiting for the probe deadline', async () => {
  for (const event of ['close', 'error']) {
    const ws = new EventEmitter(); ws.send = () => {};
    const result = cdpCall(ws, 'Browser.getVersion', {}, 10);
    const rejected = assert.rejects(result, { code: 'CDP_PROBE_FAILED' });
    ws.emit(event, new Error('connection lost'));
    await rejected;
    assert.equal(ws.listenerCount('message'), 0);
    assert.equal(ws.listenerCount(event), 0);
  }
});

test('CDP probes ignore events and responses for other requests', async () => {
  const ws = new EventEmitter(); let sent;
  ws.send = message => { sent = JSON.parse(message); };
  const result = cdpCall(ws, 'Browser.getVersion');
  ws.emit('message', Buffer.from(JSON.stringify({ method: 'Target.created', params: {} })));
  ws.emit('message', Buffer.from(JSON.stringify({ id: sent.id + 1, result: { ignored: true } })));
  ws.emit('message', Buffer.from(JSON.stringify({ id: sent.id, result: { protocolVersion: '1.3' } })));
  assert.deepEqual(await result, { protocolVersion: '1.3' });
  assert.equal(ws.listenerCount('message'), 0);
});

test('the helper cannot dial a broker directly or use a different CONNECT destination', () => {
  assert.throws(() => new OpenShellProxyAgent('https://proxy:3128', 'http://host.openshell.internal:19301'));
  assert.throws(() => new OpenShellProxyAgent('http://proxy:3128', 'http://attacker.example:19301'));
  const agent = new OpenShellProxyAgent('http://127.0.0.1:3128', 'http://host.openshell.internal:19301');
  let error;
  agent.createConnection({ host: 'other', port: 19301 }, value => { error = value; });
  assert.equal(error.code, 'PROXY_DESTINATION_DENIED');
  agent.destroy();
});

test('provider binding uses header injection only and a dedicated helper binary', () => {
  const binding = browserPodBinding({ endpoint: 'http://host.openshell.internal:19301', bridgeAddress: '172.18.0.1', bindingId: 'fixture' });
  const route = binding.profile.endpoints[0];
  assert.equal(route.protocol, 'rest'); assert.equal(route.tls, 'none');
  assert.equal(route.websocket_credential_rewrite, false);
  assert.equal(route.request_body_credential_rewrite, false);
  assert.deepEqual(route.rules.map(r => [r.allow.method, r.allow.path]), [
    ['POST', '/browsers'], ['DELETE', '/browsers/*'], ['GET', '/control'], ['GET', '/cdp/*'],
    ['POST', '/api/session'], ['GET', '/api/session/*'], ['GET', '/api/session/*/downloads-url'], ['GET', '/api/sessions'],
    ['PUT', '/api/session/*/stop'], ['POST', '/api/session/*/uploads'], ['GET', '/artifacts/*/*'],
  ]);
  assert.deepEqual(binding.profile.binaries, ['/usr/local/bin/openrind-browser-pod-helper']);
  assert.throws(() => browserPodBinding({ endpoint: 'http://host.openshell.internal:18770', bridgeAddress: '172.18.0.1', bindingId: 'fixture' }));
});

test('broker configuration must be private, owned, and not a symlink', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config');
  await writeFile(path, '{}', { mode: 0o600 });
  assert.deepEqual(await readConfig(path), {});
  await chmod(path, 0o644);
  await assert.rejects(readConfig(path), { code: 'UNSAFE_CONFIG_FILE' });
  await symlink(path, join(dir, 'link'));
  await assert.rejects(readConfig(join(dir, 'link')));
  for (const host of ['0.0.0.0', '8.8.8.8', '::']) assert.throws(() => brokerAddress({ listen: { host, port: 19301 }, owners: [{}] }));
});

test('client activation rejects local-browser overrides and a missing file policy', async () => {
  const env = { AGENT_BROWSER_PROVIDER: 'kernel', KERNEL_ENDPOINT: 'http://127.0.0.1:19300',
    KERNEL_API_KEY: 'openrind-compat', KERNEL_HEADLESS: 'true', KERNEL_STEALTH: 'false',
    AGENT_BROWSER_ACTION_POLICY: '/opt/openrind/browser/agent-browser-policy.json' };
  const policy = async () => ({ default: 'allow', deny: ['upload', 'download', 'waitfordownload'] });
  await validateClientProfile(env, policy);
  await assert.rejects(validateClientProfile({ ...env, AGENT_BROWSER_EXECUTABLE_PATH: '/bin/chrome' }, policy));
  await assert.rejects(validateClientProfile(env, async () => ({ default: 'allow', deny: [] })));
  await assert.rejects(validateClientProfile(env, async () => ({ default: 'allow', deny: ['upload', 'download'] })));
  await assert.rejects(validateClientProfile(env, async () => { throw new Error('missing'); }));
});

test('pod policy and runtime do not add FUSE, provider credentials, or an open-web default', async () => {
  assert.throws(() => browserPolicy([]));
  assert.throws(() => browserPolicy(['host.openshell.internal']));
  assert.throws(() => browserPolicy(['*']));
  const policy = browserPolicy(['example.com']);
  assert.deepEqual(policy.network_policies.browser_web.binaries, [{ path: '/usr/lib/chromium/chromium' }]);
  assert.equal(policy.network_policies.browser_web.endpoints.length, 2);
  const challengePolicy = browserPolicy(['example.com'], [
    { host: 'host.openshell.internal', port: 19410, bridgeAddress: '172.20.0.1',
      rules: [{ method: 'GET', path: '/' }, { method: 'GET', path: '/assets/**' }] },
    { host: 'host.openshell.internal', port: 19411, bridgeAddress: '172.20.0.1',
      rules: [{ method: 'POST', path: '/api/submit' }] },
  ]);
  assert.equal(challengePolicy.network_policies.challenge.endpoints.length, 2);
  assert.deepEqual(challengePolicy.network_policies.challenge.endpoints[0].rules,
    [{ allow: { method: 'GET', path: '/' } }, { allow: { method: 'GET', path: '/assets/**' } }]);
  assert.throws(() => browserPolicy(['example.com'], [{ host: 'host.openshell.internal', port: 19410,
    bridgeAddress: '172.20.0.1', rules: [{ method: 'GET', path: '/**' }] }]));
  assert.throws(() => browserPolicy(['example.com'], [{ host: 'example.com', port: 19410, bridgeAddress: '172.20.0.1' }]));
  assert.equal(policy.fuse, undefined);
  const args = { binary: '/opt/openshell', stateDir: '/tmp/pods', gateway: 'http://127.0.0.1:18770',
    image: `sandbox@sha256:${'a'.repeat(64)}`, websiteHosts: ['example.com'], acceptNoSandbox: true };
  assert.throws(() => new OpenShellRuntime({ ...args, image: 'sandbox:latest' }));
  assert.throws(() => new OpenShellRuntime({ ...args, acceptNoSandbox: false }));
  const calls = [];
  const runtime = new OpenShellRuntime({ ...args, run: async (_, command) => {
    calls.push(command); return '[]';
  } });
  await assert.rejects(runtime.remove({ id: 'session', name: 'browser-session', handle: null }), { code: 'CREATE_OUTCOME_UNKNOWN' });
  assert.deepEqual(await runtime.remove({ id: 'session', name: 'browser-session', handle: { id: 'known' } }), { deleted: true });
  assert.equal(calls.length, 2);
});

test('native forward parser validates sandbox, target and assigned loopback port', () => {
  const line = 'Forwarding 127.0.0.1:12345 -> 127.0.0.1:9222 in sandbox browser-one via gRPC';
  assert.equal(parseForwardLine(line, 'browser-one', 9222), 12345);
  assert.equal(parseForwardLine(line, 'other', 9222), null);
  assert.equal(parseForwardLine(line, 'browser-one', 9230), null);
});

test('a slow or failed pod does not delay lease requests to healthy pods', async () => {
  const runtime = new OpenShellRuntime({ binary: '/opt/openshell', stateDir: '/tmp/pods',
    gateway: 'http://127.0.0.1:18770', image: `sandbox@sha256:${'a'.repeat(64)}`,
    websiteHosts: ['example.com'], acceptNoSandbox: true });
  runtime.live.set('slow', { sessionId: 'slow' });
  runtime.live.set('healthy', { sessionId: 'healthy' });
  const calls = []; const revoked = [];
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  runtime.control = async live => {
    calls.push(live.sessionId);
    return live.sessionId === 'slow' ? slow : { state: 'ready' };
  };
  const heartbeat = runtime.heartbeat({ registry: { get: () => ({ accessRevokedAt: null }) },
    revoke: id => revoked.push(id), reconcile: () => assert.fail('cleanup must not run in a heartbeat') });
  try { assert.deepEqual(calls, ['slow', 'healthy']); }
  finally { release({ state: 'failed' }); await heartbeat; }
  assert.deepEqual(revoked, ['slow']);
});

class FakeWebSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.paused = false; this.closed = false; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  terminate() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  close(code, reason) { this.closeArgs = [code, reason]; this.closed = true; this.readyState = 3; this.emit('close', code, reason); }
  send(bytes, options, callback) { this.sent.push({ bytes, options, callback }); }
}

test('message relay preserves large bytes and pauses until the receiver drains', () => {
  const a = new FakeWebSocket(); const b = new FakeWebSocket(); const budget = { bytes: 0, max: 128 * 1024 * 1024 };
  relayWebSockets(a, b, budget);
  const bytes = Buffer.alloc(17 * 1024 * 1024, 65);
  a.emit('message', bytes, false);
  assert.equal(b.sent[0].bytes, bytes); assert.equal(b.sent[0].options.binary, false);
  assert.equal(a.paused, true); assert.equal(budget.bytes, bytes.length);
  b.sent[0].callback();
  assert.equal(a.paused, false); assert.equal(budget.bytes, 0);
  b.terminate(); assert.equal(a.closed, true);
});

test('message relay closes rather than exceed its queued-message budget', () => {
  const a = new FakeWebSocket(); const b = new FakeWebSocket();
  relayWebSockets(a, b, { bytes: 0, max: 2 });
  a.emit('message', Buffer.from('too large'), true);
  assert.equal(a.closed, true); assert.equal(b.closed, true);
  assert.equal(b.sent.length, 0);
});

test('relay preserves normal close code and reason without sending reserved codes', () => {
  for (const code of [1000, 1001, 4001, 1005]) {
    const a = new FakeWebSocket(); const b = new FakeWebSocket();
    relayWebSockets(a, b, { bytes: 0, max: 1024 });
    const reason = Buffer.from('session ended');
    a.readyState = 3; a.emit('close', code, reason);
    assert.deepEqual(b.closeArgs, code === 1005 ? [undefined, undefined] : [code, reason]);
  }
});

test('lease failures need eight seconds without success; definite loss revokes immediately', async () => {
  let now = 0;
  const runtime = new OpenShellRuntime({ binary: '/opt/openshell', stateDir: '/tmp/pods',
    gateway: 'http://127.0.0.1:18770', image: `sandbox@sha256:${'a'.repeat(64)}`,
    websiteHosts: ['example.com'], acceptNoSandbox: true, clock: () => now });
  const live = { sessionId: 'one', lastLeaseAt: 0, cdp: { closed: false }, control: { closed: false } };
  runtime.live.set('one', live);
  const revoked = [];
  const core = { registry: { get: () => ({ accessRevokedAt: null }) }, revoke: (id, reason) => revoked.push([id, reason]) };
  runtime.control = async () => { throw new Error('transient timeout'); };
  for (now of [1500, 3500, 7999]) { await runtime.heartbeat(core); assert.equal(revoked.length, 0); }
  runtime.control = async () => ({ state: 'ready' }); now = 8000; await runtime.heartbeat(core);
  runtime.control = async () => { throw new Error('transient timeout'); };
  now = 15_999; await runtime.heartbeat(core); assert.equal(revoked.length, 0);
  now = 16_000; await runtime.heartbeat(core); assert.equal(revoked.length, 1);
  for (const code of ['BROWSER_GENERATION_LOST', 'CONTROL_FORWARD_LOST']) {
    runtime.control = async () => { throw new PodError(code); };
    live.lastLeaseAt = now; await runtime.heartbeat(core);
  }
  live.cdp.closed = true;
  runtime.control = async () => assert.fail('a lost CDP forward needs no health probe');
  await runtime.heartbeat(core);
  assert.equal(revoked.length, 4);
});

test('HTTP cancellation does not abort native create and still records its late handle', async () => {
  const controller = new AbortController(); const calls = []; let observed;
  const runtime = new OpenShellRuntime({ binary: '/opt/openshell', stateDir: '/tmp/pods',
    gateway: 'http://127.0.0.1:18770', image: `sandbox@sha256:${'a'.repeat(64)}`,
    websiteHosts: ['example.com'], acceptNoSandbox: true, run: async (_binary, args, options) => {
      calls.push(args);
      if (args.includes('create')) { assert.equal(options.signal, undefined); controller.abort(); return ''; }
      if (args.includes('list')) return JSON.stringify([{ id: 'native-id', name: 'br-one', phase: 'Ready', labels: { 'openrind.browser.session': 'one' } }]);
      assert.fail('a cancelled create must not start Chromium');
    } });
  runtime.policyPath = '/tmp/pods/policy';
  await assert.rejects(runtime.provision({ id: 'one', name: 'br-one' }, controller.signal, handle => { observed = handle; }));
  assert.deepEqual(observed, { id: 'native-id', instance: null });
  assert.equal(calls.length, 2);
});
