import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';
import { PlaywrightSession, findChromiumExecutable } from '@openrind/browser-drivers';

export function createLocalChromiumProvider(options = {}) {
  const profileMode = options.profile || 'ephemeral';
  const customExecutable = options.executablePath;
  const activeSessions = new Map();
  const sessionProfiles = new Map();

  const capabilities = {
    protocol: 1,
    provider: 'local-chromium',
    driver: 'playwright',
    browserVersion: options.browserVersion || '120.0.6099.28',
    navigation: true,
    semanticSnapshot: true,
    elementActions: true,
    crossOriginFrames: false,
    screenshots: options.screenshots !== false,
    fileUpload: options.fileUpload !== false,
    fileDownload: options.fileDownload !== false,
    managedPopups: false,
    backgroundAutomation: true,
    manualControl: 'local-window',
    profiles: profileMode,
    reconnect: 'existing-session',
    networkEnforcement: 'application-guardrails',
  };

  return {
    kind: 'local-chromium',
    capabilities,

    async create(spec, ctx) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (spec.provider !== 'local-chromium') throw new BrowserFault('CAPABILITY_UNAVAILABLE');

      const executablePath = findChromiumExecutable(customExecutable);
      if (!executablePath) {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      let profileDir;
      let isEphemeral = false;
      if (spec.profileMode === 'host-retained') {
        if (!spec.profileId || typeof spec.profileId !== 'string' || /[\\/:]/.test(spec.profileId)) {
          throw new BrowserFault('POLICY_DENIED');
        }
        const base = options.profilesDir || join(tmpdir(), 'openrind-retained-profiles');
        profileDir = join(base, spec.profileId);
      } else {
        isEphemeral = true;
        profileDir = await mkdtemp(join(tmpdir(), 'openrind-chromium-'));
      }

      const isHeadless = process.env.OPENRIND_HEADLESS === 'false' ? false : options.headless !== false;
      let context;
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          executablePath,
          headless: isHeadless,
          chromiumSandbox: true,
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
          ],
          timeout: LIMITS.creationMs,
        });
      } catch (error) {
        if (isEphemeral) {
          await rm(profileDir, { recursive: true, force: true }).catch(() => {});
        }
        if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      const initialPages = context.pages();
      const initialPage = initialPages[0] || await context.newPage();
      const pageId = `bp_${randomBytes(12).toString('hex')}`;

      const handle = `lc_${randomBytes(16).toString('hex')}`;
      const session = new PlaywrightSession({
        handle,
        capabilities,
        context,
        pages: [{ pageId, page: initialPage }],
      });

      activeSessions.set(handle, { session, context, profileDir, isEphemeral });

      if (spec.initialUrl) {
        try {
          const pageDriver = session.page(pageId);
          await pageDriver.navigate(spec.initialUrl, ctx);
        } catch (error) {
          await session.close().catch(() => {});
          if (isEphemeral) {
            await rm(profileDir, { recursive: true, force: true }).catch(() => {});
          }
          activeSessions.delete(handle);
          throw error;
        }
      }

      return session;
    },

    async recover(record, _ctx) {
      const active = activeSessions.get(record.handle);
      if (!active) {
        return { lost: true, reason: 'Session closed or process unavailable' };
      }
      return active.session;
    },

    async close(session, _reason) {
      const handle = typeof session === 'string' ? session : session.handle;
      const active = activeSessions.get(handle);
      if (active) {
        activeSessions.delete(handle);
        try {
          await active.session.close();
        } catch {}
        if (active.isEphemeral && active.profileDir) {
          await rm(active.profileDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      return { closed: true };
    },
  };
}
