import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { createBrowserService } from './index.mjs';
import { createMcpHttpHandler } from './http.mjs';
import { installedProviders } from '@openrind/browser-providers';
import { ArtifactsManager } from '@openrind/browser-core';
import { join } from 'node:path';

// Standalone Electron-free server for remote / container deployments
export function createStandaloneService(config = {}) {
  if (!config?.databasePath) throw new Error('Private service registry path required');
  const artifactsDir = config.artifactsDir || join(config.databasePath, '..', 'artifacts');
  const artifacts = config.artifacts || new ArtifactsManager({ stagingDir: artifactsDir });
  return createBrowserService({
    ...config,
    artifacts,
    providers: config.providers || installedProviders,
  });
}

export async function startStandaloneBrowserServer({
  databasePath,
  port = 8789,
  host = '127.0.0.1',
  serviceToken,
  operatorToken,
  tls,
  sdk,
  providers = installedProviders,
  ...options
}) {
  if (!databasePath) throw new Error('Database path required');
  const effectiveServiceToken = serviceToken || randomBytes(32).toString('base64url');
  const effectiveOperatorToken = operatorToken || effectiveServiceToken;

  const service = createStandaloneService({ databasePath, providers, ...options });

  let server;
  let ready = false;
  let stopping = false;
  let sweeping;

  // Background sweep of expired grants, sessions, and artifacts
  const sweepTimer = setInterval(() => {
    if (stopping || sweeping) return;
    sweeping = Promise.all([
      service.core.sweep().catch(() => {}),
      service.core.artifacts?.sweep().catch(() => {}),
    ]).finally(() => { sweeping = undefined; });
  }, 5000);
  sweepTimer.unref();

  return new Promise((resolve, reject) => {
    const handler = async (req, res) => {
      // 1. Health endpoint
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          ready,
          providers: [...service.core.providers.keys()],
        }));
        return;
      }

      // 2. Readiness endpoint
      if (req.url === '/ready' && req.method === 'GET') {
        if (!ready) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ready: false }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true }));
        return;
      }

      // 3. Operator grant management endpoint: POST /v1/operator/grants
      if (req.url === '/v1/operator/grants' && req.method === 'POST') {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${effectiveOperatorToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized operator token' }));
          return;
        }

        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', () => {
          try {
            const body = JSON.parse(bodyStr || '{}');
            const grant = service.core.grants.issue(body.scope, body.policy);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token: grant.token, principal: grant.principal }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // 4. Operator revoke grant endpoint: DELETE /v1/operator/grants/:id
      if (req.url?.startsWith('/v1/operator/grants/') && req.method === 'DELETE') {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${effectiveOperatorToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized operator token' }));
          return;
        }

        const grantId = req.url.slice('/v1/operator/grants/'.length);
        try {
          service.core.grants.revoke(grantId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, revoked: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 5. MCP endpoint
      if (mcpHandler) {
        mcpHandler.handle(req, res);
        return;
      }

      res.writeHead(404);
      res.end();
    };

    server = tls
      ? createHttpsServer({ ...tls, maxHeaderSize: 16 * 1024 }, handler)
      : createHttpServer({ maxHeaderSize: 16 * 1024 }, handler);

    let mcpHandler;

    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' ? addr.port : port;
      const authority = `${host}:${actualPort}`;

      if (sdk) {
        mcpHandler = createMcpHttpHandler({
          service,
          sdk,
          authority,
          serviceToken: effectiveServiceToken,
        });
      }

      ready = true;

      resolve(Object.freeze({
        server,
        service,
        port: actualPort,
        authority,
        serviceToken: effectiveServiceToken,
        operatorToken: effectiveOperatorToken,
        async close() {
          stopping = true;
          clearInterval(sweepTimer);
          ready = false;
          await new Promise(r => server.close(r));
          await service.shutdown();
        },
      }));
    });
  });
}
