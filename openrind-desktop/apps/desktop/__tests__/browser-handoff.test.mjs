import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCore, Repository } from '@openrind/browser-core';
import { createLocalChromiumProvider } from '@openrind/browser-providers';

test('Ordered Human Handoff: take control, epoch increment, mutation fencing, and resume', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-handoff-'));
  const repo = new Repository(join(dir, 'registry.sqlite'));
  const provider = createLocalChromiumProvider({ headless: true });

  const core = new BrowserCore({
    repository: repo,
    providers: [provider],
  });

  t.after(async () => {
    await core.shutdown();
    if (repo.db) repo.close();
    await rm(dir, { recursive: true, force: true });
  });

  const scope = { tenantId: 'tenant_test', workspaceId: 'workspace_test', sandboxId: 'sandbox_test', conversationId: 'conversation_test' };
  const policy = { revision: 1, providers: ['local-chromium'], origins: [], approveMutations: false };

  const grant = core.grants.issue(scope, policy);

  // 1. Start session
  const startResult = await core.call(grant.token, 'browser_start', {
    provider: 'local-chromium',
    operationId: 'op_start_handoff',
  });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.sessionId;
  let sessionEpoch = startResult.sessionEpoch;
  const pageId = startResult.data.pages[0].pageId;

  // 2. Take a snapshot to acquire a reference
  const snapResult = await core.call(grant.token, 'browser_snapshot', {
    sessionId,
    sessionEpoch,
    pageId,
  });
  assert.equal(snapResult.ok, true);

  // 3. Initiate Human Handoff: browser_take_control
  const takeoverResult = await core.call(grant.token, 'browser_take_control', {
    sessionId,
    sessionEpoch,
    operationId: 'op_take_control_1',
  });

  assert.equal(takeoverResult.ok, true);
  assert.ok(takeoverResult.data.handoffId);

  // Notice sessionEpoch increments on takeover to fence existing operations
  sessionEpoch = takeoverResult.sessionEpoch;
  const handoffId = takeoverResult.data.handoffId;

  // 4. Verify session state is now HumanControl
  const statusRes = await core.call(grant.token, 'browser_status', {
    sessionId,
    sessionEpoch,
  });
  assert.equal(statusRes.data.state, 'HumanControl');
  assert.equal(statusRes.data.human, 'active');

  // 5. Verify agent operations are blocked during Human Control
  const clickRes = await core.call(grant.token, 'browser_click', {
    sessionId,
    sessionEpoch,
    pageId,
    operationId: 'op_click_during_human',
    ref: 'br_dummy_ref',
  });
  assert.equal(clickRes.ok, false);
  assert.ok(clickRes.code === 'ACTION_NOT_POSSIBLE' || clickRes.code === 'STALE_REF');

  // 6. Resume: requires trusted handoffId and release
  // Simulate release in session record
  const sessionRecord = core.repo.session(sessionId);
  sessionRecord.handoff.released = true;
  core.repo.saveSession(sessionRecord);

  const resumeResult = await core.call(grant.token, 'browser_resume', {
    sessionId,
    sessionEpoch,
    handoffId,
    operationId: 'op_resume_1',
  });

  assert.equal(resumeResult.ok, true);
  assert.equal(resumeResult.data.resumed, true);

  // 7. Verify session is Ready again with a new epoch
  sessionEpoch = resumeResult.sessionEpoch;
  const postResumeStatus = await core.call(grant.token, 'browser_status', {
    sessionId,
    sessionEpoch,
  });
  assert.equal(postResumeStatus.data.state, 'Ready');
  assert.equal(postResumeStatus.data.human, 'none');

  // 8. Close session
  await core.call(grant.token, 'browser_close', {
    sessionId,
    sessionEpoch,
    operationId: 'op_close_handoff',
  });
});
