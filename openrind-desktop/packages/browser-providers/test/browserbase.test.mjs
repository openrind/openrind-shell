import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrowserCore, Repository } from '@openrind/browser-core';
import { createBrowserbaseProvider } from '../src/browserbase.mjs';
import { findChromiumExecutable } from '@openrind/browser-drivers';

test('browserbase: capabilities and credential missing rejection', async t => {
  const provider = createBrowserbaseProvider({
    apiKey: undefined,
    projectId: undefined,
  });

  assert.equal(provider.kind, 'browserbase');
  assert.equal(provider.capabilities.provider, 'browserbase');
  assert.equal(provider.capabilities.driver, 'playwright');
  assert.equal(provider.capabilities.manualControl, 'provider-viewer');
  assert.equal(provider.capabilities.profiles, 'provider-context');

  // Creation without credentials must fail with CAPABILITY_UNAVAILABLE
  await assert.rejects(
    provider.create({ provider: 'browserbase' }),
    error => error.code === 'CAPABILITY_UNAVAILABLE'
  );
});

test('browserbase: mock allocation, connect URL validation, and cleanup release', async t => {
  const apiCalls = [];
  const fakeSessionId = 'bb-sess-12345';

  // Spin up a local chromium to serve as the CDP target for the test
  const executablePath = findChromiumExecutable();
  const serverBrowser = await chromium.launch({
    executablePath,
    headless: true,
  });
  t.after(async () => { await serverBrowser.close(); });

  const mockFetch = async (url, options = {}) => {
    apiCalls.push({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/sessions') && options.method === 'POST') {
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.status === 'REQUEST_RELEASE') {
        return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fakeSessionId,
          connectUrl: 'wss://connect.browserbase.com/session-cdp',
          liveUrl: 'https://browserbase.com/sessions/view-12345',
        }),
      };
    }
    if (url.includes('/sessions/' + fakeSessionId) && options.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fakeSessionId,
          status: 'RUNNING',
          connectUrl: 'wss://connect.browserbase.com/session-cdp',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };

  const provider = createBrowserbaseProvider({
    apiKey: 'test-api-key',
    projectId: 'test-project-id',
    fetch: mockFetch,
    connectOverCDP: async (_url) => serverBrowser,
  });

  const session = await provider.create({
    provider: 'browserbase',
    profileMode: 'provider-context',
  });

  assert.equal(session.handle, `bb_${fakeSessionId}`);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].headers['X-BB-API-Key'], 'test-api-key');
  assert.equal(apiCalls[0].body.projectId, 'test-project-id');

  // Verify pages
  const pages = await session.pages();
  assert.ok(pages.length >= 1);

  // Recovery test
  const recovered = await provider.recover({ handle: session.handle });
  assert.equal(recovered.handle, session.handle);

  // Close session
  const closeResult = await provider.close(session);
  assert.equal(closeResult.closed, true);

  // Verify release request was made to Browserbase API
  const releaseCall = apiCalls.find(c => c.body?.status === 'REQUEST_RELEASE');
  assert.ok(releaseCall, 'REQUEST_RELEASE call must be dispatched on session close');
});

test('browserbase: spoofed connect URL rejection', async t => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'sess-malicious',
      connectUrl: 'wss://attacker-site.com/evil-cdp',
    }),
  });

  const provider = createBrowserbaseProvider({
    apiKey: 'test-key',
    projectId: 'test-project',
    fetch: mockFetch,
  });

  await assert.rejects(
    provider.create({ provider: 'browserbase' }),
    error => error.code === 'POLICY_DENIED'
  );
});

test('browserbase integration with BrowserCore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-core-bb-'));
  const repo = new Repository(join(dir, 'registry.sqlite'));

  const executablePath = findChromiumExecutable();
  const serverBrowser = await chromium.launch({
    executablePath,
    headless: true,
  });
  t.after(async () => { await serverBrowser.close(); });

  const fakeSessionId = 'bb-core-sess-1';
  const mockFetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.status === 'REQUEST_RELEASE') return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fakeSessionId,
          connectUrl: 'wss://connect.browserbase.com/cdp-stream',
          liveUrl: 'https://browserbase.com/view/1',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ id: fakeSessionId, status: 'RUNNING' }) };
  };

  const provider = createBrowserbaseProvider({
    apiKey: 'test-bb-key',
    projectId: 'test-bb-project',
    fetch: mockFetch,
    connectOverCDP: async () => serverBrowser,
  });

  const core = new BrowserCore({
    repository: repo,
    providers: [provider],
  });

  t.after(async () => {
    await core.shutdown();
    if (repo.db) repo.close();
    await rm(dir, { recursive: true, force: true });
  });

  const scope = { tenantId: 'tenant_bb', workspaceId: 'workspace_bb', sandboxId: 'sandbox_bb', conversationId: 'conversation_bb' };
  const policy = { revision: 1, providers: ['browserbase'], origins: [], approveMutations: false };

  const grant = core.grants.issue(scope, policy);

  // Discover capabilities
  const caps = await core.call(grant.token, 'browser_capabilities', {});
  assert.ok(caps.data.providers.some(p => p.provider === 'browserbase'));

  // Start Browserbase session
  const startResult = await core.call(grant.token, 'browser_start', {
    provider: 'browserbase',
    profileMode: 'provider-context',
    operationId: 'op_start_bb',
  });
  assert.equal(startResult.ok, true);
  assert.equal(startResult.data.provider, 'browserbase');
  assert.equal(startResult.data.state, 'Ready');

  // Close session
  const closeResult = await core.call(grant.token, 'browser_close', {
    sessionId: startResult.sessionId,
    sessionEpoch: startResult.sessionEpoch,
    operationId: 'op_close_bb',
  });
  assert.equal(closeResult.ok, true);
});
