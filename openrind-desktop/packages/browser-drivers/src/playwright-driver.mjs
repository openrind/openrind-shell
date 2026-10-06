import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';

export function findChromiumExecutable(customPath) {
  if (customPath && existsSync(customPath)) return customPath;
  if (process.env.OPENRIND_CHROMIUM_EXECUTABLE && existsSync(process.env.OPENRIND_CHROMIUM_EXECUTABLE)) {
    return process.env.OPENRIND_CHROMIUM_EXECUTABLE;
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const msPlaywright = join(localAppData, 'ms-playwright');
      if (existsSync(msPlaywright)) {
        try {
          for (const entry of readdirSync(msPlaywright)) {
            if (entry.startsWith('chromium-')) {
              candidates.push(join(msPlaywright, entry, 'chrome-win', 'chrome.exe'));
              candidates.push(join(msPlaywright, entry, 'chrome-win64', 'chrome.exe'));
            }
          }
        } catch {}
      }
    }
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  } else if (process.platform === 'linux') {
    const home = process.env.HOME;
    if (home) {
      const msPlaywright = join(home, '.cache', 'ms-playwright');
      if (existsSync(msPlaywright)) {
        try {
          for (const entry of readdirSync(msPlaywright)) {
            if (entry.startsWith('chromium-')) {
              candidates.push(join(msPlaywright, entry, 'chrome-linux', 'chrome'));
            }
          }
        } catch {}
      }
    }
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
    candidates.push('/usr/bin/google-chrome');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class PlaywrightPageDriver {
  constructor({ pageId, page, context, initialGeneration = 1 }) {
    this.pageId = pageId;
    this.page = page;
    this.context = context;
    this.documentGeneration = initialGeneration;
    this._handleCounter = 0;
  }

  async navigate(url, ctx) {
    if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
    try {
      const targetUrl = typeof url === 'string' ? url : url.href;
      await this.page.goto(targetUrl, {
        timeout: LIMITS.actionMs,
        waitUntil: 'domcontentloaded',
      });
      this.documentGeneration++;
      return {
        url: this.page.url(),
        documentGeneration: this.documentGeneration,
      };
    } catch (error) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (error instanceof BrowserFault) throw error;
      if (error?.name === 'TimeoutError') throw new BrowserFault('TIMEOUT');
      throw new BrowserFault('BACKEND_UNAVAILABLE');
    }
  }

  async snapshot(options = {}, ctx) {
    if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
    const depth = Math.max(Number(options.depth) || 10, 10);
    const maxNodes = Math.max(Number(options.maxNodes) || LIMITS.snapshotNodes, 1000);
    const maxTextBytes = options.maxTextBytes || LIMITS.snapshotTextBytes;

    try {
      const rawNodes = await this.page.evaluate(({ depth, maxNodes, maxTextBytes }) => {
        let count = 0;
        let textBytes = 0;
        let idCounter = 0;

        const getGeometry = el => {
          if (!el || el.nodeType !== 1) return null;
          const rect = el.getBoundingClientRect();
          const bounds = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
          const center = [
            Math.round(rect.x + rect.width / 2),
            Math.round(rect.y + rect.height / 2),
          ];
          const hasSize = bounds.width > 0 && bounds.height > 0;
          const vpW = window.innerWidth || document.documentElement.clientWidth || 1024;
          const vpH = window.innerHeight || document.documentElement.clientHeight || 768;
          const inViewport = hasSize &&
            rect.bottom > 0 &&
            rect.top < vpH &&
            rect.right > 0 &&
            rect.left < vpW;

          let hitTestable = false;
          if (inViewport && center[0] >= 0 && center[1] >= 0 && center[0] < vpW && center[1] < vpH) {
            try {
              const hit = document.elementFromPoint(center[0], center[1]);
              hitTestable = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
            } catch {
              hitTestable = false;
            }
          }
          return { bounds, center, inViewport, hitTestable, hasSize };
        };

        const isVisible = (el, geo) => {
          if (!el || el.nodeType !== 1) return true;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        };

        const getRole = el => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit.toLowerCase();
          const tag = el.tagName.toLowerCase();
          if (tag === 'button') return 'button';
          if (tag === 'a' && el.hasAttribute('href')) return 'link';
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'input') {
            const type = (el.type || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            return 'textbox';
          }
          if (/^h[1-6]$/.test(tag)) return 'heading';
          return null;
        };

        const getName = el => {
          const aria = el.getAttribute('aria-label');
          if (aria && aria.trim()) return aria.trim();
          if (el.id) {
            try {
              const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (label && label.textContent.trim()) return label.textContent.trim();
            } catch {}
          }
          const parentLabel = el.closest('label');
          if (parentLabel && parentLabel.textContent.trim()) return parentLabel.textContent.trim();
          if (el.tagName.toLowerCase() === 'input') {
            const type = (el.type || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(type) && el.value) return el.value.trim();
            if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
            if (el.getAttribute('title')) return el.getAttribute('title').trim();
            if (el.name) return el.name;
          }
          if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tagName.toLowerCase())) {
            const text = el.textContent.trim();
            if (text) return text.length > 200 ? text.slice(0, 197) + '...' : text;
          }
          if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
          if (el.getAttribute('title')) return el.getAttribute('title').trim();
          return undefined;
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
            const geo = getGeometry(node);
            if (!isVisible(node, geo)) return null;
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
              ...(geo ? {
                bounds: geo.bounds,
                center: geo.center,
                inViewport: geo.inViewport,
                hitTestable: geo.hitTestable,
              } : {}),
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
      }, { depth, maxNodes, maxTextBytes });

      return {
        documentGeneration: this.documentGeneration,
        nodes: rawNodes,
      };
    } catch (error) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (error instanceof BrowserFault) throw error;
      throw new BrowserFault('BACKEND_UNAVAILABLE');
    }
  }

  async act(action, ctx) {
    if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
    const { kind, target, text, values, key, direction, distance } = action;

    try {
      if (target?.handle) {
        const selector = `[data-openrind-handle="${target.handle}"]`;
        const locator = this.page.locator(selector);
        const count = await locator.count();
        if (count === 0) throw new BrowserFault('STALE_REF');

        const isVisible = await locator.isVisible().catch(() => false);
        if (!isVisible) throw new BrowserFault('ACTION_NOT_POSSIBLE');

        const isDisabled = await locator.isDisabled().catch(() => false);
        if (isDisabled) throw new BrowserFault('ACTION_NOT_POSSIBLE');

        if (kind === 'click') {
          try {
            await locator.click({ timeout: 10_000 });
          } catch (clickErr) {
            if (target?.center && Array.isArray(target.center)) {
              await this.page.mouse.click(target.center[0], target.center[1]);
            } else {
              throw clickErr;
            }
          }
        } else if (kind === 'fill') {
          await locator.fill(text ?? '', { timeout: 15_000 });
        } else if (kind === 'select') {
          await locator.selectOption(values ?? [], { timeout: 15_000 });
        } else if (kind === 'press') {
          await locator.press(key, { timeout: 15_000 });
        } else if (kind === 'upload_file') {
          if (!action.artifact) throw new BrowserFault('INVALID_ARGUMENT');
          await locator.setInputFiles({
            name: action.artifact.filename || 'upload.bin',
            mimeType: action.artifact.mimeType || 'application/octet-stream',
            buffer: action.artifact.buffer,
          }, { timeout: 15_000 });
        } else {
          throw new BrowserFault('ACTION_NOT_POSSIBLE');
        }
      } else {
        if (kind === 'press') {
          if (!key) throw new BrowserFault('INVALID_ARGUMENT');
          await this.page.keyboard.press(key);
        } else if (kind === 'scroll') {
          const dist = distance || 250;
          const deltaX = direction === 'left' ? -dist : direction === 'right' ? dist : 0;
          const deltaY = direction === 'up' ? -dist : direction === 'down' ? dist : 0;
          await this.page.mouse.wheel(deltaX, deltaY);
        } else {
          throw new BrowserFault('ACTION_NOT_POSSIBLE');
        }
      }
    } catch (error) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (error instanceof BrowserFault) throw error;
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('not visible') || msg.includes('disabled') || msg.includes('not actionable') || msg.includes('intercepted')) {
        throw new BrowserFault('ACTION_NOT_POSSIBLE');
      }
      if (error?.name === 'TimeoutError' || msg.includes('timeout')) {
        throw new BrowserFault('TIMEOUT');
      }
      throw new BrowserFault('BACKEND_UNAVAILABLE');
    }
  }

  async screenshot(options = {}, ctx) {
    if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
    try {
      const clip = options.region ? {
        x: options.region.x,
        y: options.region.y,
        width: options.region.width,
        height: options.region.height,
      } : (options.width && options.height ? {
        x: Number(options.x) || 0,
        y: Number(options.y) || 0,
        width: Number(options.width),
        height: Number(options.height),
      } : undefined);
      return await this.page.screenshot({
        clip,
        timeout: 15_000,
      });
    } catch (error) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (error instanceof BrowserFault) throw error;
      throw new BrowserFault('BACKEND_UNAVAILABLE');
    }
  }

  async close() {
    try {
      await this.page.close();
    } catch {}
  }
}

export class PlaywrightSession {
  constructor({ handle, capabilities, context, pages = [], onDownload }) {
    this.handle = handle;
    this.capabilities = capabilities;
    this.context = context;
    this._pages = new Map();
    this._humanControl = false;
    this.onDownload = onDownload;

    const setupDownload = page => {
      page.on('download', async dl => {
        try {
          const filename = dl.suggestedFilename();
          const filePath = await dl.path();
          if (this.onDownload) {
            await this.onDownload({ filename, filePath, download: dl });
          }
        } catch {}
      });
    };

    for (const p of pages) {
      const driver = new PlaywrightPageDriver({ pageId: p.pageId, page: p.page, context });
      this._pages.set(p.pageId, driver);
      setupDownload(p.page);
    }
  }

  async pages() {
    const records = [];
    for (const [pageId, driver] of this._pages) {
      records.push({
        pageId,
        documentGeneration: driver.documentGeneration,
        url: driver.page.url(),
      });
    }
    return records;
  }

  async openPage(url, ctx) {
    if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
    const page = await this.context.newPage();
    const pageId = `bp_${randomBytes(12).toString('hex')}`;
    const driver = new PlaywrightPageDriver({ pageId, page, context: this.context });
    this._pages.set(pageId, driver);

    page.on('download', async dl => {
      try {
        const filename = dl.suggestedFilename();
        const filePath = await dl.path();
        if (this.onDownload) {
          await this.onDownload({ filename, filePath, download: dl });
        }
      } catch {}
    });

    let currentUrl = 'about:blank';
    if (url) {
      const nav = await driver.navigate(url, ctx);
      currentUrl = nav.url;
    }

    return {
      pageId,
      documentGeneration: driver.documentGeneration,
      url: currentUrl,
    };
  }

  page(id) {
    const driver = this._pages.get(id);
    if (!driver) throw new BrowserFault('SESSION_LOST');
    return driver;
  }

  async setHumanControl(active, _ctx) {
    this._humanControl = Boolean(active);
  }

  async close() {
    for (const driver of this._pages.values()) {
      await driver.close().catch(() => {});
    }
    this._pages.clear();
    await this.context.close().catch(() => {});
  }
}
