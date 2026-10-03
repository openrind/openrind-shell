import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { startDesktopBrowserHost } from '../../packages/browser-service/src/desktop-host.mjs';
import { serviceBridge } from './bridge/service-peer.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
let host;
let stopping = false;
let startupTimer;
let terminationTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  // The parent must also supervise this deadline and report forced termination.
  terminationTimer = setTimeout(() => process.exit(1), 10_000);
  void Promise.resolve(host?.close()).then(() => {
    clearTimeout(terminationTimer);
    process.stdin.destroy(); process.stdout.end();
    if (process.connected) process.disconnect();
  }, () => {
    process.stderr.write('openrind-browser: worker cleanup incomplete\n');
    process.exitCode = 1;
    clearTimeout(terminationTimer);
    process.stdin.destroy(); process.stdout.end();
    if (process.connected) process.disconnect();
  });
}
function send(message) {
  if (!process.connected || stopping) return;
  process.send(message, error => { if (error) stop(); });
}
async function main() {
  if (process.argv.length !== 2 || !process.send || !process.connected) throw new Error('Private worker IPC required');
  process.once('disconnect', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
  const settings = await new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Worker bootstrap timeout')), 20_000);
    process.once('message', message => { clearTimeout(startupTimer); resolve(message); });
  });
  if (!exact(settings, ['type', 'databasePath', 'serviceToken']) || settings.type !== 'initialize' ||
      typeof settings.databasePath !== 'string' || settings.databasePath.length > 4096 || !isAbsolute(settings.databasePath) ||
      typeof settings.serviceToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(settings.serviceToken)) throw new Error('Invalid worker bootstrap');
  host = await startDesktopBrowserHost({ databasePath: settings.databasePath, serviceToken: settings.serviceToken,
    sdk: { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest },
    startBridge: serviceBridge(process.stdin, process.stdout),
    onDisconnect: stop,
  });
  if (stopping || !process.connected) { await host.close(); return; }
  // Only the fork-owning main process has this channel. No message is forwarded
  // from the renderer; the binary stdio bridge cannot invoke these controls.
  process.on('message', message => {
    if (stopping) return;
    if (!object(message) || typeof message.id !== 'string' || !/^[a-f0-9]{32}$/.test(message.id)) { stop(); return; }
    try {
      let value;
      if (message.type === 'begin' && exact(message, ['id', 'type', 'scope', 'policy'])) {
        value = host.beginLaunch(message.scope, message.policy);
      } else if (message.type === 'heartbeat' && exact(message, ['id', 'type', 'launchId'])) {
        if (typeof message.launchId !== 'string' || message.launchId.length > 64) throw new Error();
        value = host.heartbeat(message.launchId);
      } else if (message.type === 'stop' && exact(message, ['id', 'type', 'launchId'])) {
        if (typeof message.launchId !== 'string' || message.launchId.length > 64) throw new Error();
        host.stopLaunch(message.launchId); value = {};
      } else if (message.type === 'shutdown' && exact(message, ['id', 'type'])) {
        stop(); return;
      } else throw new Error();
      send({ type: 'result', id: message.id, ok: true, value });
    } catch { send({ type: 'result', id: message.id, ok: false, error: 'Browser control request failed' }); }
  });
  send({ type: 'ready', protocol: 1 });
}
main().catch(() => {
  process.stderr.write('openrind-browser: worker startup failed\n');
  process.exitCode = 1;
  stop();
});
