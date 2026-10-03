import { Capabilities, BrowserFault } from '@openrind/browser-contract';
import { createLocalChromiumProvider } from './local-chromium.mjs';
import { createBrowserbaseProvider } from './browserbase.mjs';

export { createLocalChromiumProvider, createBrowserbaseProvider };

export function providerRegistry(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    Capabilities.parse(provider.capabilities);
    if (registry.has(provider.kind) || provider.kind !== provider.capabilities.provider ||
        ['create', 'recover', 'close'].some(name => typeof provider[name] !== 'function')) throw new BrowserFault('BACKEND_UNAVAILABLE');
    registry.set(provider.kind, provider);
  }
  return registry;
}

export const installedProviders = Object.freeze(
  process.env.OPENRIND_ENABLE_LOCAL_PROVIDER === '1'
    ? [createLocalChromiumProvider(), createBrowserbaseProvider()]
    : []
);
