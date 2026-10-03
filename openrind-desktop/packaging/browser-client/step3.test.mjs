import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgePeer } from './bridge/bridge-peer.mjs';
import { startHttpEdge } from './bridge/bridge-http.mjs';
import { mergeManagedServer, browserCredentials, validateDescriptor } from '../../packages/browser-client/src/launch-config.mjs';
import { createBrowserPtyLease } from '../../apps/desktop/electron/openshell/browser-pty-lease.mjs';

test('PTY cleanup can retry a failed revocation and cannot reactivate a stopped lease', async () => {
  let attempts = 0;
  const lease = await createBrowserPtyLease({
    beginLaunch: async () => ({ launchId: 'launch_test', token: 'opaque-test-token' }),
    stopLaunch: async () => { if (++attempts === 1) throw new Error('temporary failure'); },
  }, {}, {});
  await assert.rejects(lease.stop());
  await lease.stop();
  assert.equal(attempts, 2);
  assert.throws(() => lease.activate());
});

test('fixed configuration preserves other servers and rejects overrides', () => {
  const input = { mcpServers: { custom: { command: '/custom', args: [] } } };
  assert.deepEqual(mergeManagedServer(input).mcpServers.custom, input.mcpServers.custom);
  assert.equal(input.mcpServers['openrind-browser'], undefined);
  assert.throws(() => mergeManagedServer(input, [{ mcpServers: { 'openrind-browser': { command: '/tmp/override' } } }]));
  assert.throws(() => validateDescriptor({ protocol: 1, endpoint: 'http://example.com/mcp', requireProxy: true }));
  assert.throws(() => browserCredentials({ OPENRIND_BROWSER_SERVICE_TOKEN: 'x'.repeat(32), OPENRIND_BROWSER_GRANT: 'bad\nvalue' }));
});

test('production worker, CBOR bridge, SDK discovery, owner isolation and revocation', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openrind-step3-'));
  const token = randomBytes(32).toString('base64url');
  const worker = fork(fileURLToPath(new URL('./dist/worker.cjs', import.meta.url)), [], {
    execArgv: process.execArgv, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let diagnostics = '';
  worker.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-2048); });
  const exited = new Promise(resolve => worker.once('exit', code => resolve(code)));
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => {
      if (message.type === 'ready') resolve();
      else { const request = pending.get(message.id); pending.delete(message.id); request?.(message); }
    });
  });
  const control = (type, fields) => new Promise(resolve => {
    const id = randomBytes(16).toString('hex'); pending.set(id, resolve); worker.send({ id, type, ...fields });
  });
  const peer = new BridgePeer(worker.stdout, worker.stdin, { initiator: true });
  let edge, client, transport;
  try {
    worker.send({ type: 'initialize', databasePath: join(directory, 'registry.sqlite'), serviceToken: token });
    edge = await startHttpEdge(peer);
    await ready;
    const scope = { tenantId: 'tenant_one', workspaceId: 'workspace_one', sandboxId: 'sandbox_one', conversationId: 'conversation_one' };
    const policy = { providers: ['local-chromium'], origins: [], revision: 1 };
    const issued = await control('begin', { scope, policy });
    assert.equal(issued.ok, true, diagnostics);
    const duplicate = await control('begin', { scope, policy });
    assert.equal(duplicate.ok, false);
    const headers = { authorization: `Bearer ${token}`, 'x-openrind-browser-grant': issued.value.token };
    assert.equal((await fetch(edge.endpoint, { headers: { ...headers, authorization: 'Bearer invalid-service-credential' } })).status, 401);
    assert.equal((await fetch(edge.endpoint, { headers: { ...headers, 'x-openrind-browser-grant': 'a'.repeat(43) } })).status, 401);
    client = new Client({ name: 'step3-test', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(edge.endpoint), { requestInit: { headers }, reconnectionOptions: { maxRetries: 0 } });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 17);
    assert.ok(!tools.tools.some(tool => tool.name === 'browser_import_file'));
    const capabilities = await client.callTool({ name: 'browser_capabilities', arguments: {} });
    assert.equal(capabilities.structuredContent.ok, true);
    assert.deepEqual(capabilities.structuredContent.data.providers, []);
    const other = await control('begin', { scope: { ...scope, conversationId: 'conversation_two' }, policy });
    const stolen = await fetch(edge.endpoint, { method: 'DELETE', headers: { ...headers,
      'x-openrind-browser-grant': other.value.token, 'mcp-session-id': transport.sessionId } });
    assert.equal(stolen.status, 403);
    assert.equal((await control('heartbeat', { launchId: issued.value.launchId })).ok, true);
    await control('stop', { launchId: issued.value.launchId });
    const revoked = await fetch(edge.endpoint, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': transport.sessionId } });
    assert.equal(revoked.status, 401);
  } finally {
    await client?.close();
    peer.close();
    await edge?.close();
    if (worker.connected) worker.disconnect();
    const timer = setTimeout(() => worker.kill(), 15_000);
    const code = await exited; clearTimeout(timer);
    assert.equal(code, 0, diagnostics);
    await rm(directory, { recursive: true, force: true });
  }
});
