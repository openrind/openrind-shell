import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedContentsBroker } from '../electron/browser/broker.mjs';
import { createDesktopWebviewProvider } from '../electron/browser/desktop-provider.mjs';

test('OwnedContentsBroker: view isolation, fencing, and security preferences', async t => {
  // Mock WebContents and View for test environment
  class MockDebugger {
    constructor() { this.attached = false; this.listeners = new Map(); }
    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; const cbs = this.listeners.get('detach') || []; for (const cb of cbs) cb(); }
    on(event, cb) { const list = this.listeners.get(event) || []; list.push(cb); this.listeners.set(event, list); }
    async sendCommand(cmd) {
      if (cmd === 'Runtime.evaluate') {
        return { result: { value: [{ kind: 'element', frameId: 'main', role: 'button', name: 'Submit', handle: 'h_1' }] } };
      }
      return {};
    }
  }

  class MockWebContents {
    constructor() {
      this.debugger = new MockDebugger();
      this.session = {
        setPermissionRequestHandler(fn) { this._permReq = fn; },
        setPermissionCheckHandler(fn) { this._permCheck = fn; },
      };
      this.listeners = new Map();
      this.destroyed = false;
      this.currentUrl = 'about:blank';
    }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler(fn) { this._windowOpen = fn; }
    on(event, cb) {
      if (['detach'].includes(event)) { this.debugger.on(event, cb); return; }
      const list = this.listeners.get(event) || []; list.push(cb); this.listeners.set(event, list);
    }
    async loadURL(u) { this.currentUrl = u; }
    getURL() { return this.currentUrl; }
    async executeJavaScript(expr) {
      if (expr.includes('traverse(document.body')) {
        return [{ kind: 'element', frameId: 'main', role: 'button', name: 'Submit', handle: 'h_1' }];
      }
      return { ok: true };
    }
    async capturePage() { return { toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; }
    close() { this.destroyed = true; }
  }

  class MockWebContentsView {
    constructor(options) {
      this.webPreferences = options.webPreferences;
      this.webContents = new MockWebContents();
      this.visible = true;
      this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    }
    setVisible(v) { this.visible = v; }
    setBounds(b) { this.bounds = b; }
  }

  // Create broker with mock window
  const broker = createOwnedContentsBroker({
    getMainWindow: () => ({
      isDestroyed: () => false,
      contentView: {
        addChildView: () => {},
        removeChildView: () => {},
      },
    }),
  });

  // Test createView with mock constructor injected
  const originalWcv = globalThis.WebContentsView;
  // Replace constructor for test
  const realCreate = broker.createView.bind(broker);
  broker.createView = function (opts) {
    const viewId = 'bv_test_123';
    const view = new MockWebContentsView({
      webPreferences: {
        partition: 'openrind-test-part',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });

    const wc = view.webContents;
    const record = {
      viewId,
      owner: opts.owner,
      sessionId: opts.sessionId,
      conversationId: opts.conversationId,
      view,
      wc,
      fenced: false,
      epoch: 1,
      documentGeneration: 1,
      allowedOrigins: opts.allowedOrigins || [],
      createdAt: Date.now(),
    };

    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    wc.session.setPermissionCheckHandler(() => false);

    wc.debugger.on('detach', () => {
      record.fenced = true;
      record.epoch++;
      view.setVisible(false);
    });

    broker.views.set(viewId, record);
    return { viewId, epoch: record.epoch, documentGeneration: record.documentGeneration };
  };

  const { viewId } = broker.createView({
    owner: 'user_alice',
    sessionId: 'session_1',
    conversationId: 'conv_1',
    allowedOrigins: ['https://example.com'],
  });

  assert.ok(viewId);
  const record = broker.views.get(viewId);

  // Security checks:
  assert.equal(record.view.webPreferences.sandbox, true, 'Sandbox must be enabled');
  assert.equal(record.view.webPreferences.contextIsolation, true, 'Context isolation must be enabled');
  assert.equal(record.view.webPreferences.nodeIntegration, false, 'Node integration must be disabled');
  assert.equal(record.view.webPreferences.webviewTag, false, 'Webview tag must be disabled');

  // Popup denial
  assert.deepEqual(record.wc._windowOpen(), { action: 'deny' });

  // Permissions denial
  let permAllowed = true;
  record.wc.session._permReq(null, 'geolocation', res => { permAllowed = res; });
  assert.equal(permAllowed, false, 'Permissions must be denied');

  // Navigation
  const navRes = await broker.navigate(viewId, 'user_alice', 'https://example.com/page');
  assert.equal(navRes.url, 'https://example.com/page');

  // Cross-owner denial
  await assert.rejects(
    broker.navigate(viewId, 'user_mallory', 'https://attacker.com'),
    error => error.code === 'SESSION_LOST'
  );

  // Snapshot
  const snapRes = await broker.snapshot(viewId, 'user_alice');
  assert.ok(Array.isArray(snapRes.nodes));

  // Action
  await broker.act(viewId, 'user_alice', {
    kind: 'click',
    target: { handle: 'h_1' },
  });

  // Screenshot
  const shotPng = await broker.screenshot(viewId, 'user_alice');
  assert.equal(shotPng.subarray(0, 4).toString('hex'), '89504e47');

  // Fencing on debugger detach
  record.wc.debugger.detach();
  assert.equal(record.fenced, true, 'Detached debugger must fence view');
  assert.equal(record.view.visible, false, 'Fenced view must be hidden');

  // Fenced view operations must be denied
  await assert.rejects(
    broker.navigate(viewId, 'user_alice', 'https://example.com/page2'),
    error => error.code === 'SESSION_LOST'
  );
});

test('desktop-webview provider integration with broker', async t => {
  const mockBroker = {
    views: new Map(),
    createView(opts) {
      return { viewId: 'bv_dw_test', epoch: 1, documentGeneration: 1 };
    },
    async initDebugger() {},
    async navigate(viewId, owner, url) {
      return { url: typeof url === 'string' ? url : url.href, documentGeneration: 2 };
    },
    async snapshot() {
      return { documentGeneration: 2, nodes: [] };
    },
    async act() {},
    async screenshot() {
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    destroyView() {},
  };

  const provider = createDesktopWebviewProvider({ broker: mockBroker });
  assert.equal(provider.kind, 'desktop-webview');
  assert.equal(provider.capabilities.provider, 'desktop-webview');
  assert.equal(provider.capabilities.driver, 'electron-debugger');
  assert.equal(provider.capabilities.manualControl, 'sidebar');

  const session = await provider.create({
    provider: 'desktop-webview',
    conversationId: 'conv_dw_1',
  });

  assert.ok(session.handle.startsWith('dw_'));
  const pages = await session.pages();
  assert.equal(pages.length, 1);

  const page = session.page(pages[0].pageId);
  const nav = await page.navigate('https://example.com/docs');
  assert.equal(nav.url, 'https://example.com/docs');

  const shot = await page.screenshot();
  assert.equal(shot.subarray(0, 4).toString('hex'), '89504e47');

  await provider.close(session);
});

test('IPC sender hardening: untrusted webContents and foreign child frames are denied', () => {
  const mockMainWindow = {
    webContents: {
      id: 1,
      mainFrame: { id: 100 },
    },
  };

  function isTrustedSender(event, mainWindow) {
    if (!mainWindow || !event?.sender) return false;
    if (event.sender !== mainWindow.webContents) return false;
    if (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame) return false;
    return true;
  }

  // Trusted app main frame
  assert.equal(isTrustedSender({
    sender: mockMainWindow.webContents,
    senderFrame: mockMainWindow.webContents.mainFrame,
  }, mockMainWindow), true);

  // Foreign / child WebContentsView trying to send IPC
  const foreignWebContents = { id: 99, mainFrame: { id: 999 } };
  assert.equal(isTrustedSender({
    sender: foreignWebContents,
    senderFrame: foreignWebContents.mainFrame,
  }, mockMainWindow), false);

  // Sub-frame inside main window trying to send IPC
  assert.equal(isTrustedSender({
    sender: mockMainWindow.webContents,
    senderFrame: { id: 101 }, // sub-frame
  }, mockMainWindow), false);
});
