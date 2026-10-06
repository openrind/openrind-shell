import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startInstalledBrowserRuntime } from './browser-runtime.mjs';
import { createBrowserSessions } from './browser-sessions.mjs';
import { resolveOpenrindShellSandboxWorkspaceId } from './fuse-sandbox.mjs';
import { FUSE_IMAGE } from './fuse-runtime.mjs';

const id = (prefix, value) => `${prefix}_${createHash('sha256').update(value).digest('hex')}`;
// One host registry for the local Desktop user. This module is never renderer IPC.
export function createDesktopBrowserController({ resourcesPath, userDataPath, onDisconnect }) {
  let starting;
  let sessions;
  let stopped = false;
  async function ensure() {
    if (stopped) throw new Error('Desktop browser controller is stopped');
    if (!starting) {
      starting = startInstalledBrowserRuntime({ resourcesPath, databasePath: join(userDataPath, 'browser', 'registry.sqlite'),
        port: 18789, image: FUSE_IMAGE, onDisconnect: () => {
          starting = undefined;
          sessions = undefined;
          onDisconnect?.();
        } }).then(async runtime => {
        if (stopped) { await runtime.close(); throw new Error('Desktop browser startup was cancelled'); }
        sessions = createBrowserSessions({ runtime });
        return sessions;
      }).catch(error => { starting = undefined; throw error; });
    }
    return starting;
  }
  return Object.freeze({
    async prepare({ sandboxName, conversationId, profile = 'openrind-shell-claude', workspaceId, onLost }) {
      if (typeof conversationId !== 'string' || !/^[a-f0-9]{32}$/.test(conversationId)) throw new Error('A trusted conversation identity is required');
      // Resolve the recorded sandbox workspace; never fall back to a renderer ID.
      const resolvedWorkspaceId = await resolveOpenrindShellSandboxWorkspaceId({
        name: sandboxName,
        profile,
        fallbackWorkspaceId: workspaceId,
      });
      const active = await ensure();
      return active.prepare({ sandboxName, onLost,
        scope: { tenantId: id('local', userDataPath), workspaceId: id('workspace', resolvedWorkspaceId),
          sandboxId: id('sandbox', sandboxName), conversationId: id('conversation', conversationId) },
        // Desktop policy explicitly opts into public origins (allowAnyPublicOrigin: true)
        // so agents can browse public web resources like Amazon while blocking local/private destinations.
        policy: { revision: 1, providers: ['local-chromium', 'browserbase', 'desktop-webview'],
          origins: [], profiles: [], approveMutations: false, allowAnyPublicOrigin: true },
      });
    },
    async removeSandbox(name) { if (starting) await (await starting).removeSandbox(name); },
    async close() {
      stopped = true;
      if (starting) { const active = await starting.catch(() => null); await active?.close(); }
      starting = undefined;
      sessions = undefined;
    },
  });
}
