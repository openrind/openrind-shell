import electron from 'electron';
const WebContentsView = electron?.WebContentsView || electron?.default?.WebContentsView;
import { randomBytes, createHash } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';

export function createOwnedContentsBroker({ getMainWindow, clock = Date.now } = {}) {
  const views = new Map(); // viewId -> record
  const sessions = new Map(); // sessionId -> Set of viewIds

  function getRecord(viewId, owner) {
    const record = views.get(viewId);
    if (!record || (owner && record.owner !== owner)) {
      throw new BrowserFault('SESSION_LOST');
    }
    if (record.fenced) {
      throw new BrowserFault('SESSION_LOST');
    }
    return record;
  }

  return {
    views,

    createView({ owner, sessionId, conversationId, partition, bounds, allowedOrigins = [] }) {
      if (!owner || !sessionId) throw new BrowserFault('INVALID_ARGUMENT');

      const viewId = `bv_${randomBytes(16).toString('hex')}`;
      const viewPartition = partition || `openrind-browser-${randomBytes(8).toString('hex')}`;

      // Strictly hardened preferences: no node, no preload, isolated, sandboxed
      const view = new WebContentsView({
        webPreferences: {
          partition: viewPartition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          webviewTag: false,
          allowRunningInsecureContent: false,
          plugins: false,
        },
      });

      const wc = view.webContents;
      const record = {
        viewId,
        owner,
        sessionId,
        conversationId,
        view,
        wc,
        fenced: false,
        epoch: 1,
        documentGeneration: 1,
        allowedOrigins: [...allowedOrigins],
        createdAt: clock(),
      };

      // Security guards: lock down permissions and popups
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.session.setPermissionRequestHandler((_w, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);

      // Navigation guard
      wc.on('will-navigate', (event, targetUrl) => {
        try {
          const u = new URL(targetUrl);
          if (u.protocol !== 'https:' && targetUrl !== 'about:blank') {
            event.preventDefault();
            return;
          }
          if (record.allowedOrigins.length > 0 && !record.allowedOrigins.includes(u.origin)) {
            event.preventDefault();
          }
        } catch {
          event.preventDefault();
        }
      });

      // Detach and crash fencing: if debugger is detached or renderer crashes, fence view
      wc.debugger.on('detach', () => {
        record.fenced = true;
        record.epoch++;
        view.setVisible(false);
      });

      wc.on('render-process-gone', () => {
        record.fenced = true;
        record.epoch++;
        view.setVisible(false);
      });

      // Track view
      views.set(viewId, record);
      const sessionViews = sessions.get(sessionId) || new Set();
      sessionViews.add(viewId);
      sessions.set(sessionId, sessionViews);

      // Attach to main window if available
      const mainWindow = getMainWindow?.();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.contentView.addChildView(view);
          if (bounds) {
            view.setBounds(bounds);
          }
        } catch {}
      }

      return {
        viewId,
        epoch: record.epoch,
        documentGeneration: record.documentGeneration,
      };
    },

    async initDebugger(viewId, owner) {
      const record = getRecord(viewId, owner);
      const wc = record.wc;

      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Page.enable');
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      }
    },

    async navigate(viewId, owner, url) {
      const record = getRecord(viewId, owner);
      const targetUrl = typeof url === 'string' ? url : url.href;

      try {
        record.documentGeneration++;
        await record.wc.loadURL(targetUrl);
        return {
          url: record.wc.getURL(),
          documentGeneration: record.documentGeneration,
        };
      } catch (err) {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async snapshot(viewId, owner, options = {}) {
      const record = getRecord(viewId, owner);
      const depth = options.depth || 8;
      const maxNodes = options.maxNodes || LIMITS.snapshotNodes;
      const maxTextBytes = options.maxTextBytes || LIMITS.snapshotTextBytes;

      try {
        // Execute fixed inspection script through debugger evaluate
        const expr = `(${function (depth, maxNodes, maxTextBytes) {
          let count = 0;
          let textBytes = 0;
          let idCounter = 0;

          const isVisible = el => {
            if (!el || el.nodeType !== 1) return true;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          };

          const getRole = el => {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'button') return 'button';
            if (tag === 'a' && el.hasAttribute('href')) return 'link';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              const type = (el.type || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type)) return 'button';
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              return 'textbox';
            }
            if (/^h[1-6]$/.test(tag)) return 'heading';
            return null;
          };

          const getName = el => {
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
            if (el.id) {
              const label = document.querySelector('label[for="' + el.id + '"]');
              if (label) return label.textContent.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel) return parentLabel.textContent.trim();
            if (el.tagName.toLowerCase() === 'input' && ['button', 'submit'].includes(el.type)) return el.value;
            if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tagName.toLowerCase())) {
              return el.textContent.trim();
            }
            return el.placeholder || undefined;
          };

          function traverse(node, currentDepth) {
            if (!node || currentDepth > depth || count >= maxNodes || textBytes >= maxTextBytes) return null;

            if (node.nodeType === 3) {
              const textContent = node.textContent.trim();
              if (!textContent) return null;
              count++;
              textBytes += textContent.length;
              return { kind: 'text', frameId: 'main', text: textContent };
            }

            if (node.nodeType === 1) {
              if (!isVisible(node)) return null;
              const tag = node.tagName.toLowerCase();
              if (['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link'].includes(tag)) return null;

              const role = getRole(node);
              const name = getName(node);
              const isPassword = tag === 'input' && (node.type === 'password' || node.getAttribute('type')?.toLowerCase() === 'password');
              const isInteractive = ['button', 'textbox', 'link', 'checkbox', 'radio', 'combobox'].includes(role);
              let handle = undefined;
              if (isInteractive) {
                handle = 'h_' + (++idCounter);
                node.setAttribute('data-openrind-handle', handle);
              }

              count++;
              const item = {
                kind: 'element',
                frameId: 'main',
                ...(role ? { role } : {}),
                ...(name ? { name } : {}),
                ...(isPassword ? { sensitive: true } : {}),
                ...(role === 'textbox' ? { editable: true } : {}),
                ...(node.checked !== undefined && ['checkbox', 'radio'].includes(role) ? { checked: Boolean(node.checked) } : {}),
                ...(node.disabled !== undefined ? { disabled: Boolean(node.disabled) } : {}),
                ...(handle ? { handle } : {})
              };

              const children = [];
              for (const child of node.childNodes) {
                const c = traverse(child, currentDepth + 1);
                if (c) children.push(c);
              }
              if (children.length > 0) item.children = children;
              return item;
            }
            return null;
          }

          const bodyTree = traverse(document.body, 1);
          return bodyTree ? [bodyTree] : [];
        }})(${depth}, ${maxNodes}, ${maxTextBytes})`;

        let result;
        if (record.wc.debugger.isAttached()) {
          const evalRes = await record.wc.debugger.sendCommand('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
          });
          result = evalRes.result?.value || [];
        } else {
          result = await record.wc.executeJavaScript(expr);
        }

        return {
          documentGeneration: record.documentGeneration,
          nodes: result,
        };
      } catch (err) {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async act(viewId, owner, action) {
      const record = getRecord(viewId, owner);
      const { kind, target, text, values, key, direction, distance } = action;

      try {
        if (target?.handle) {
          const checkExpr = `(${function (handle, kind, text, values, key) {
            const el = document.querySelector('[data-openrind-handle="' + handle + '"]');
            if (!el) return { error: 'STALE_REF' };
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return { error: 'ACTION_NOT_POSSIBLE' };
            }
            if (el.disabled) {
              return { error: 'ACTION_NOT_POSSIBLE' };
            }

            if (kind === 'click') {
              el.scrollIntoView({ block: 'center' });
              el.click();
            } else if (kind === 'fill') {
              el.focus();
              el.value = text || '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (kind === 'select') {
              if (Array.isArray(values) && values.length > 0) {
                el.value = values[0];
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else if (kind === 'press') {
              el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
            }
            return { ok: true };
          }})(${JSON.stringify(target.handle)}, ${JSON.stringify(kind)}, ${JSON.stringify(text || '')}, ${JSON.stringify(values || [])}, ${JSON.stringify(key || '')})`;

          const res = await record.wc.executeJavaScript(checkExpr);
          if (res?.error === 'STALE_REF') throw new BrowserFault('STALE_REF');
          if (res?.error === 'ACTION_NOT_POSSIBLE') throw new BrowserFault('ACTION_NOT_POSSIBLE');
        } else {
          if (kind === 'press') {
            record.wc.sendInputEvent({ type: 'keyDown', keyCode: key });
            record.wc.sendInputEvent({ type: 'keyUp', keyCode: key });
          } else if (kind === 'scroll') {
            const dist = distance || 250;
            const deltaX = direction === 'left' ? -dist : direction === 'right' ? dist : 0;
            const deltaY = direction === 'up' ? -dist : direction === 'down' ? dist : 0;
            record.wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX, deltaY });
          }
        }
      } catch (err) {
        if (err instanceof BrowserFault) throw err;
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    async screenshot(viewId, owner, options = {}) {
      const record = getRecord(viewId, owner);
      try {
        const image = await record.wc.capturePage(options.region);
        return image.toPNG();
      } catch {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }
    },

    setBounds(viewId, bounds) {
      const record = views.get(viewId);
      if (record && !record.wc.isDestroyed()) {
        record.view.setBounds(bounds);
      }
    },

    setVisible(viewId, visible) {
      const record = views.get(viewId);
      if (record && !record.wc.isDestroyed()) {
        record.view.setVisible(Boolean(visible));
      }
    },

    destroyView(viewId) {
      const record = views.get(viewId);
      if (record) {
        views.delete(viewId);
        record.fenced = true;
        const mainWindow = getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.contentView.removeChildView(record.view);
          } catch {}
        }
        if (!record.wc.isDestroyed()) {
          try {
            if (record.wc.debugger.isAttached()) {
              record.wc.debugger.detach();
            }
            record.wc.close();
          } catch {}
        }
      }
    },

    destroySession(sessionId) {
      const viewIds = sessions.get(sessionId);
      if (viewIds) {
        sessions.delete(sessionId);
        for (const viewId of viewIds) {
          this.destroyView(viewId);
        }
      }
    },
  };
}
