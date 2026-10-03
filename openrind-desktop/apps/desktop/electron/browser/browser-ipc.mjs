import { ipcMain } from 'electron';
import { BrowserFault } from '@openrind/browser-contract';

export function registerBrowserIpc({ broker, assertTrustedSender }) {
  if (!broker) throw new Error('OwnedContentsBroker is required');

  const checkSender = event => {
    if (assertTrustedSender) {
      assertTrustedSender(event, 'browser IPC');
    }
  };

  ipcMain.handle('openrind-desktop:browser:start', async (event, opts = {}) => {
    checkSender(event);
    const { owner = 'desktop_user', sessionId, conversationId, partition, bounds, allowedOrigins, initialUrl } = opts;
    if (!sessionId) throw new BrowserFault('INVALID_ARGUMENT');

    const view = broker.createView({
      owner,
      sessionId,
      conversationId,
      partition,
      bounds,
      allowedOrigins: allowedOrigins || [],
    });

    await broker.initDebugger(view.viewId, owner).catch(() => {});

    if (initialUrl) {
      await broker.navigate(view.viewId, owner, initialUrl).catch(() => {});
    }

    return {
      ok: true,
      viewId: view.viewId,
      epoch: view.epoch,
      documentGeneration: view.documentGeneration,
    };
  });

  ipcMain.handle('openrind-desktop:browser:navigate', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, owner = 'desktop_user', url } = opts;
    if (!viewId || !url) throw new BrowserFault('INVALID_ARGUMENT');
    const res = await broker.navigate(viewId, owner, url);
    return { ok: true, url: res.url, documentGeneration: res.documentGeneration };
  });

  ipcMain.handle('openrind-desktop:browser:stop', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, sessionId } = opts;
    if (viewId) {
      broker.destroyView(viewId);
    } else if (sessionId) {
      broker.destroySession(sessionId);
    }
    return { ok: true, closed: true };
  });

  ipcMain.handle('openrind-desktop:browser:take-control', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, owner } = opts;
    const record = broker.views.get(viewId);
    if (!record || (owner && record.owner !== owner)) throw new BrowserFault('SESSION_LOST');

    // Handoff takeover: increments epoch, invalidating existing agent refs
    record.epoch++;
    record.humanControl = true;
    return { ok: true, handoffId: `bh_${Date.now()}`, epoch: record.epoch };
  });

  ipcMain.handle('openrind-desktop:browser:resume', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, owner } = opts;
    const record = broker.views.get(viewId);
    if (!record || (owner && record.owner !== owner)) throw new BrowserFault('SESSION_LOST');

    record.epoch++;
    record.humanControl = false;
    return { ok: true, resumed: true, epoch: record.epoch };
  });

  ipcMain.handle('openrind-desktop:browser:set-bounds', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, bounds } = opts;
    if (viewId && bounds) {
      broker.setBounds(viewId, {
        x: Math.max(0, Math.floor(bounds.x || 0)),
        y: Math.max(0, Math.floor(bounds.y || 0)),
        width: Math.max(10, Math.floor(bounds.width || 10)),
        height: Math.max(10, Math.floor(bounds.height || 10)),
      });
    }
    return { ok: true };
  });

  ipcMain.handle('openrind-desktop:browser:set-visible', async (event, opts = {}) => {
    checkSender(event);
    const { viewId, visible } = opts;
    if (viewId) {
      broker.setVisible(viewId, Boolean(visible));
    }
    return { ok: true };
  });

  ipcMain.handle('openrind-desktop:browser:status', async (event, opts = {}) => {
    checkSender(event);
    const { viewId } = opts;
    const record = broker.views.get(viewId);
    if (!record) return { ok: false, status: 'closed' };

    return {
      ok: true,
      status: record.fenced ? 'fenced' : record.humanControl ? 'human_control' : 'ready',
      url: record.wc.isDestroyed() ? 'about:blank' : record.wc.getURL(),
      epoch: record.epoch,
      documentGeneration: record.documentGeneration,
    };
  });
}
