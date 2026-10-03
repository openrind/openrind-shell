import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStandaloneBrowserServer } from '../src/standalone.mjs';

test('Standalone server: health, readiness, operator grant issuance, and bounded shutdown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'standalone-test-'));
  const dbPath = join(dir, 'registry.sqlite');

  const operatorToken = 'test-operator-secret-token-12345';
  const standalone = await startStandaloneBrowserServer({
    databasePath: dbPath,
    port: 0,
    host: '127.0.0.1',
    operatorToken,
  });

  t.after(async () => {
    await standalone.close();
    await rm(dir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${standalone.port}`;

  // 1. Health check
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, 'ok');
  assert.equal(healthData.ready, true);
  assert.ok(Array.isArray(healthData.providers));

  // 2. Readiness check
  const readyRes = await fetch(`${baseUrl}/ready`);
  assert.equal(readyRes.status, 200);
  const readyData = await readyRes.json();
  assert.equal(readyData.ready, true);

  // 3. Operator grant issuance without token -> 401
  const unauthRes = await fetch(`${baseUrl}/v1/operator/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unauthRes.status, 401);

  // 4. Operator grant issuance with valid token -> 200
  const scope = {
    tenantId: 'tenant_std',
    workspaceId: 'workspace_std',
    sandboxId: 'sandbox_std',
    conversationId: 'conversation_std',
  };
  const policy = {
    revision: 1,
    providers: ['local-chromium'],
    origins: [],
    approveMutations: false,
  };

  const authRes = await fetch(`${baseUrl}/v1/operator/grants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${operatorToken}`,
    },
    body: JSON.stringify({ scope, policy }),
  });

  assert.equal(authRes.status, 200);
  const grantData = await authRes.json();
  assert.equal(grantData.ok, true);
  assert.ok(grantData.token);
  assert.equal(grantData.principal.tenantId, 'tenant_std');

  // Verify issued grant works with the underlying service
  const caps = await standalone.service.invoke(grantData.token, 'browser_capabilities', {});
  assert.equal(caps.ok, true);
});
