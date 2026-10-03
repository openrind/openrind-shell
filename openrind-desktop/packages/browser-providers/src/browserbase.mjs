import { randomBytes, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';
import { PlaywrightSession } from '@openrind/browser-drivers';

const BROWSERBASE_API_DEFAULT = 'https://api.browserbase.com/v1';

export function createBrowserbaseProvider(options = {}) {
  const apiKey = options.apiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = options.projectId || process.env.BROWSERBASE_PROJECT_ID;
  const baseUrl = options.baseUrl || BROWSERBASE_API_DEFAULT;
  const customFetch = options.fetch || globalThis.fetch;
  const customConnect = options.connectOverCDP || (url => chromium.connectOverCDP(url, { timeout: 30_000 }));
  const profileMode = options.profile || 'provider-context';

  const activeSessions = new Map();

  const capabilities = {
    protocol: 1,
    provider: 'browserbase',
    driver: 'playwright',
    browserVersion: options.browserVersion || 'cloud-chromium',
    navigation: true,
    semanticSnapshot: true,
    elementActions: true,
    crossOriginFrames: false,
    screenshots: true,
    fileUpload: true,
    fileDownload: true,
    managedPopups: false,
    backgroundAutomation: true,
    manualControl: 'provider-viewer',
    profiles: profileMode,
    reconnect: 'existing-session',
    networkEnforcement: 'application-guardrails',
  };

  async function api(path, body, method = body ? 'POST' : 'GET', signal) {
    if (!apiKey || !projectId) {
      throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
    const response = await customFetch(url, {
      method,
      redirect: 'error',
      signal: signal || AbortSignal.timeout(20_000),
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new BrowserFault('UNAUTHORIZED');
      if (response.status === 429) throw new BrowserFault('RATE_LIMITED');
      throw new BrowserFault('BACKEND_UNAVAILABLE');
    }

    return response.json();
  }

  return {
    kind: 'browserbase',
    capabilities,

    async create(spec, ctx) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (spec.provider !== 'browserbase') throw new BrowserFault('CAPABILITY_UNAVAILABLE');

      if (!apiKey || !projectId) {
        throw new BrowserFault('CAPABILITY_UNAVAILABLE');
      }

      const clientRequestId = `bb_req_${randomBytes(16).toString('hex')}`;
      let sessionData;

      try {
        sessionData = await api('sessions', {
          projectId,
          timeout: Math.min(Math.floor(LIMITS.sessionMs / 1000), 7200),
          keepAlive: false,
          userMetadata: {
            openrindRequestId: clientRequestId,
            profileMode: spec.profileMode || profileMode,
          },
        }, 'POST', ctx?.signal);
      } catch (err) {
        if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
        if (err instanceof BrowserFault) throw err;
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      if (!sessionData?.id || typeof sessionData.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionData.id)) {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      const remoteSessionId = sessionData.id;
      const connectUrlStr = sessionData.connectUrl;

      // Validate connect URL for security: must be wss and end with browserbase.com
      let connectUrl;
      try {
        connectUrl = new URL(connectUrlStr);
      } catch {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      if (connectUrl.protocol !== 'wss:' ||
          !(connectUrl.hostname === 'connect.browserbase.com' || connectUrl.hostname.endsWith('.browserbase.com') || options.allowTestHost)) {
        throw new BrowserFault('POLICY_DENIED');
      }

      let browser;
      try {
        browser = await customConnect(connectUrlStr);
      } catch (err) {
        // Attempt release if connect fails
        try {
          await api(`sessions/${remoteSessionId}`, { status: 'REQUEST_RELEASE' }, 'POST');
        } catch {}
        if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });
      const initialPages = context.pages();
      const initialPage = initialPages[0] || await context.newPage();
      const pageId = `bp_${randomBytes(12).toString('hex')}`;

      const handle = `bb_${remoteSessionId}`;
      const session = new PlaywrightSession({
        handle,
        capabilities,
        context,
        pages: [{ pageId, page: initialPage }],
      });

      activeSessions.set(handle, {
        session,
        browser,
        context,
        remoteSessionId,
        liveUrl: sessionData.liveUrl || sessionData.viewerUrl,
      });

      if (spec.initialUrl) {
        try {
          const pageDriver = session.page(pageId);
          await pageDriver.navigate(spec.initialUrl, ctx);
        } catch (error) {
          await this.close(session, 'navigation-failed').catch(() => {});
          throw error;
        }
      }

      return session;
    },

    async recover(record, _ctx) {
      const active = activeSessions.get(record.handle);
      if (active) {
        return active.session;
      }

      // Check remote cloud session state
      const remoteSessionId = record.handle.startsWith('bb_') ? record.handle.slice(3) : record.handle;
      try {
        const state = await api(`sessions/${remoteSessionId}`, null, 'GET');
        if (state?.status === 'RUNNING' && state?.connectUrl) {
          const browser = await customConnect(state.connectUrl);
          const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });
          const initialPages = context.pages();
          const page = initialPages[0] || await context.newPage();
          const pageId = `bp_${randomBytes(12).toString('hex')}`;

          const session = new PlaywrightSession({
            handle: record.handle,
            capabilities,
            context,
            pages: [{ pageId, page }],
          });

          activeSessions.set(record.handle, {
            session,
            browser,
            context,
            remoteSessionId,
            liveUrl: state.liveUrl || state.viewerUrl,
          });

          return session;
        }
      } catch {}

      return { lost: true, reason: 'Cloud session is no longer running or available' };
    },

    async close(session, reason) {
      const handle = typeof session === 'string' ? session : session.handle;
      const active = activeSessions.get(handle);

      if (active) {
        activeSessions.delete(handle);
        try {
          await active.session.close();
        } catch {}
        try {
          await active.browser.close();
        } catch {}

        try {
          await api(`sessions/${active.remoteSessionId}`, { status: 'REQUEST_RELEASE' }, 'POST');
        } catch {}
      } else if (handle.startsWith('bb_')) {
        const remoteSessionId = handle.slice(3);
        try {
          await api(`sessions/${remoteSessionId}`, { status: 'REQUEST_RELEASE' }, 'POST');
        } catch {}
      }

      return { closed: true };
    },
  };
}
