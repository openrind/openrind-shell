import { LOCAL_TOOLS, parseTool, toolDefinitions, BrowserFault } from '@openrind/browser-contract';
import { createLocalTransfers, assertPathBeneath, verifyNoSymlinkEscape } from './transfers.mjs';

export { createLocalTransfers, assertPathBeneath, verifyNoSymlinkEscape };
export const clientToolDefinitions = () => toolDefinitions({ local: true });
export function validateClientRequest(name, input) { return parseTool(name, input, { local: true }); }
export async function routeClientRequest(name, input, { remote, localTransfers }) {
  const args = validateClientRequest(name, input);
  if (LOCAL_TOOLS.includes(name)) {
    if (!localTransfers) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    return localTransfers(name, args);
  }
  return remote(name, args);
}
// Approved filesystem transfer adapters remain a later step; no host path is
// forwarded as a remote tool request. The stdio adapter lives in mcp-adapter.mjs.
