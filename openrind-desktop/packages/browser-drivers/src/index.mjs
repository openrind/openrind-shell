import { BrowserFault } from '@openrind/browser-contract';
import { PlaywrightPageDriver, PlaywrightSession, findChromiumExecutable } from './playwright-driver.mjs';

export { PlaywrightPageDriver, PlaywrightSession, findChromiumExecutable };

// Shared adapter guard. Real Playwright/Electron drivers arrive in their
// vertical slices; this package does not expose arbitrary CDP or evaluation.
export function assertDriver(driver) {
  if (!driver || typeof driver.pageId !== 'string' ||
      ['navigate', 'snapshot', 'act', 'close'].some(name => typeof driver[name] !== 'function')) throw new BrowserFault('BACKEND_UNAVAILABLE');
  return driver;
}
