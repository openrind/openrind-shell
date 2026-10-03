import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCore, Repository } from '@openrind/browser-core';
import { createLocalChromiumProvider } from '../src/local-chromium.mjs';

test('local-chromium provider: session lifecycle, tabs, and ephemeral profile cleanup', async t => {
  const provider = createLocalChromiumProvider({ headless: true });
  assert.equal(provider.kind, 'local-chromium');
  assert.equal(provider.capabilities.provider, 'local-chromium');
  assert.equal(provider.capabilities.driver, 'playwright');

  const session = await provider.create({
    provider: 'local-chromium',
    profileMode: 'ephemeral',
  });

  t.after(async () => {
    await provider.close(session).catch(() => {});
  });

  assert.ok(session.handle.startsWith('lc_'));
  const pages = await session.pages();
  assert.equal(pages.length, 1);
  const initialPageId = pages[0].pageId;
  const initialPage = session.page(initialPageId);
  assert.ok(initialPage);

  // Tab management
  const newTab = await session.openPage();
  assert.ok(newTab.pageId);
  assert.notEqual(newTab.pageId, initialPageId);
  assert.equal((await session.pages()).length, 2);

  const newTabPage = session.page(newTab.pageId);
  await newTabPage.close();

  // Recovery test
  const recovered = await provider.recover({ handle: session.handle });
  assert.equal(recovered.handle, session.handle);

  // Close and cleanup
  const closeResult = await provider.close(session);
  assert.equal(closeResult.closed, true);

  const postClose = await provider.recover({ handle: session.handle });
  assert.equal(postClose.lost, true);
});

test('local-chromium: DOM navigation, semantic snapshot, form filling, and click actions', async t => {
  const provider = createLocalChromiumProvider({ headless: true });
  const session = await provider.create({
    provider: 'local-chromium',
    profileMode: 'ephemeral',
  });

  t.after(async () => {
    await provider.close(session).catch(() => {});
  });

  const page = session.page((await session.pages())[0].pageId);

  const fixtureHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Form Test</title></head>
      <body>
        <h1>Feedback Form</h1>
        <form id="test-form" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Submitted: ' + document.getElementById('name').value + ' | ' + document.getElementById('category').value;">
          <label for="name">Your Name</label>
          <input id="name" type="text" placeholder="Enter name">

          <label for="pwd">Secret Key</label>
          <input id="pwd" type="password" placeholder="Password">

          <label for="category">Category</label>
          <select id="category">
            <option value="general">General</option>
            <option value="bug">Bug Report</option>
            <option value="feature">Feature Request</option>
          </select>

          <button id="btn-submit" type="submit">Submit Feedback</button>
          <button id="btn-disabled" type="button" disabled>Disabled Action</button>
        </form>
        <div id="status">Waiting</div>
      </body>
    </html>
  `;

  const dataUri = `data:text/html;base64,${Buffer.from(fixtureHtml).toString('base64')}`;
  const navResult = await page.navigate(dataUri);
  assert.equal(navResult.documentGeneration, 2);

  // Snapshot verification
  const snapshot = await page.snapshot({ depth: 8 });
  assert.equal(snapshot.documentGeneration, 2);
  assert.ok(Array.isArray(snapshot.nodes));

  // Find form elements in snapshot
  const flatNodes = [];
  function flatten(nodes) {
    for (const n of nodes) {
      flatNodes.push(n);
      if (n.children) flatten(n.children);
    }
  }
  flatten(snapshot.nodes);

  const nameInputNode = flatNodes.find(n => n.role === 'textbox' && n.name === 'Your Name');
  assert.ok(nameInputNode, 'Name input element must be discovered');
  assert.ok(nameInputNode.handle, 'Interactive element must have a handle');
  assert.equal(nameInputNode.editable, true);

  const passwordNode = flatNodes.find(n => n.role === 'textbox' && (n.name === 'Secret Key' || n.name === 'Password'));
  assert.ok(passwordNode, 'Password input must be found');
  assert.equal(passwordNode.sensitive, true, 'Password input must be marked sensitive');

  const selectNode = flatNodes.find(n => n.role === 'combobox');
  assert.ok(selectNode, 'Select combobox must be found');
  assert.ok(selectNode.handle);

  const submitButtonNode = flatNodes.find(n => n.role === 'button' && n.name === 'Submit Feedback');
  assert.ok(submitButtonNode, 'Submit button must be found');
  assert.ok(submitButtonNode.handle);

  const disabledButtonNode = flatNodes.find(n => n.role === 'button' && n.name === 'Disabled Action');
  assert.ok(disabledButtonNode, 'Disabled button must be found');
  assert.equal(disabledButtonNode.disabled, true);

  // Perform actions: fill name input
  await page.act({
    kind: 'fill',
    target: { handle: nameInputNode.handle },
    text: 'Alice Engineer',
  });

  // Select dropdown option
  await page.act({
    kind: 'select',
    target: { handle: selectNode.handle },
    values: ['bug'],
  });

  // Click submit button
  await page.act({
    kind: 'click',
    target: { handle: submitButtonNode.handle },
  });

  // Verify form was successfully submitted in the DOM
  const statusText = await page.page.textContent('#status');
  assert.equal(statusText, 'Submitted: Alice Engineer | bug');

  // Verify action on disabled element fails with ACTION_NOT_POSSIBLE
  await assert.rejects(
    page.act({
      kind: 'click',
      target: { handle: disabledButtonNode.handle },
    }),
    error => error.code === 'ACTION_NOT_POSSIBLE'
  );

  // Verify action on non-existent element fails with STALE_REF
  await assert.rejects(
    page.act({
      kind: 'click',
      target: { handle: 'non_existent_handle_123' },
    }),
    error => error.code === 'STALE_REF'
  );
});

test('local-chromium integration with BrowserCore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-core-lc-'));
  const repo = new Repository(join(dir, 'registry.sqlite'));
  const provider = createLocalChromiumProvider({ headless: true });
  const scope = { tenantId: 'tenant_test', workspaceId: 'workspace_test', sandboxId: 'sandbox_test', conversationId: 'conversation_test' };
  const policy = { revision: 1, providers: ['local-chromium'], origins: [], approveMutations: false };

  const core = new BrowserCore({
    repository: repo,
    providers: [provider],
  });

  t.after(async () => {
    await core.shutdown();
    if (repo.db) repo.close();
    await rm(dir, { recursive: true, force: true });
  });

  const grant = core.grants.issue(scope, policy);
  const startResult = await core.call(grant.token, 'browser_start', {
    provider: 'local-chromium',
    operationId: 'op_start_lc',
  });

  assert.equal(startResult.ok, true);
  assert.equal(startResult.data.provider, 'local-chromium');
  assert.equal(startResult.data.state, 'Ready');
  assert.equal(startResult.data.pages.length, 1);

  const sessionId = startResult.sessionId;
  const sessionEpoch = startResult.sessionEpoch;
  const pageId = startResult.data.pages[0].pageId;

  // Snapshot on about:blank
  const snapResult = await core.call(grant.token, 'browser_snapshot', {
    sessionId,
    sessionEpoch,
    pageId,
  });
  assert.equal(snapResult.ok, true);
  assert.ok(Array.isArray(snapResult.data.nodes));

  // Close session
  const closeResult = await core.call(grant.token, 'browser_close', {
    sessionId,
    sessionEpoch,
    operationId: 'op_close_lc',
  });
  assert.equal(closeResult.ok, true);
});
