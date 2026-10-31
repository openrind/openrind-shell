import assert from 'node:assert/strict';
import test from 'node:test';
import { imageForProfile, resolveAgentSessionValue } from '../../electron/openshell/openrind-shell.mjs';
import { resolveHaloopClientProfileIdentity } from '../../electron/openshell/openrind-shell-credentials.mjs';
import { buildHaloopAgentLifecycleEvent } from '../../electron/openshell/haloop-runtime.mjs';
import { resolveCodexHomeVolumeName } from '../../electron/openshell/fuse-sandbox.mjs';

const assertion = `v1.${'a'.repeat(32)}.1700000000000.1700000001000.${'b'.repeat(64)}`;

test('openrind-shell-codex uses the FUSE image and a signed launch marker', () => {
  assert.ok(imageForProfile('openrind-shell-codex'));
  assert.equal(resolveAgentSessionValue('openrind-shell-codex', null, assertion), `openrind-shell-codex:auto:${assertion}`);
  assert.equal(resolveAgentSessionValue('openrind-shell-codex', 'custom-session-1', assertion), `openrind-shell-codex:custom-session-1:${assertion}`);
  assert.throws(() => resolveAgentSessionValue('openrind-shell-codex', null, ''), /signed Haloop/);
});

test('Codex CLI owns a distinct Haloop identity and lifecycle', () => {
  const options = { sandboxName: 'or-codex-test', workspaceId: 'workspace-codex', agentId: 'codex' };
  const codex = resolveHaloopClientProfileIdentity(options);
  const claude = resolveHaloopClientProfileIdentity({ ...options, agentId: 'claude' });
  const openclaw = resolveHaloopClientProfileIdentity({ ...options, agentId: 'openclaw' });
  assert.equal(codex.agentId, 'codex');
  assert.notEqual(codex.id, claude.id);
  assert.notEqual(codex.id, openclaw.id);

  const event = buildHaloopAgentLifecycleEvent('codex', { id: 'pty-codex', exitCode: 0 });
  assert.equal(event.name, 'codex.session');
  assert.equal(event.ok, true);
  assert.equal(event.attributes['openrind.agent.id'], 'codex');
});

test('Codex CLI allocates its dedicated home volume under openrind-codex-home-', () => {
  const volumeName = resolveCodexHomeVolumeName('my-codex-sandbox');
  assert.equal(volumeName, 'openrind-codex-home-my-codex-sandbox');
});
