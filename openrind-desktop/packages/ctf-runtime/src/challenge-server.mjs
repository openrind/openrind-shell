import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_RUN_EVENT_LOGS = 64;
const MAX_RUN_EVENT_BYTES = 384 * 1024;
const MAX_TOTAL_EVENT_BYTES = 2 * 1024 * 1024;

function parseCookies(value = '') {
  return Object.fromEntries(value.split(';').map(part => part.trim().split(/=(.*)/s, 2))
    .filter(([name, cookieValue]) => name && cookieValue));
}

async function readJson(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function routeAllowed(task, method, pathname) {
  return task.browserRules.some(rule => rule.method === method &&
    (rule.path.endsWith('/**') ? pathname.startsWith(rule.path.slice(0, -2)) : pathname === rule.path));
}

function filteredHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

export function createChallengeServer({ task, judgeToken, expectedFlag, upstreamPort, record = async () => {} }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(judgeToken) || typeof expectedFlag !== 'string' || !expectedFlag ||
      !Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535 ||
      !Array.isArray(task.browserRules) || task.browserRules.length === 0) throw new Error('INVALID_CHALLENGE_CONFIG');
  const expected = createHash('sha256').update(`Bearer ${judgeToken}`).digest();
  const eventLogs = new Map();
  let totalEventBytes = 0;
  let eventActorCapacityExceeded = false;

  async function recordEvent(event) {
    await record(event);
    if (!RUN_ID_PATTERN.test(event.actor ?? '')) return;
    let log = eventLogs.get(event.actor);
    if (!log) {
      if (eventLogs.size >= MAX_RUN_EVENT_LOGS) { eventActorCapacityExceeded = true; return; }
      log = { events: [], bytes: 0, truncated: false };
      eventLogs.set(event.actor, log);
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (log.events.length < 512 && log.bytes + bytes <= MAX_RUN_EVENT_BYTES &&
        totalEventBytes + bytes <= MAX_TOTAL_EVENT_BYTES) {
      log.events.push(event);
      log.bytes += bytes;
      totalEventBytes += bytes;
    } else log.truncated = true;
  }

  function authorized(req) {
    const candidate = createHash('sha256').update(req.headers.authorization ?? '').digest();
    return timingSafeEqual(candidate, expected);
  }

  function proxySite(req, res, url, actor, requestedRun, startedAt) {
    if (!routeAllowed(task, req.method, url.pathname)) { writeJson(res, 404, { code: 'NOT_FOUND' }); return; }
    const headers = filteredHeaders(req.headers);
    headers.host = `127.0.0.1:${upstreamPort}`;
    const upstreamPath = new URL(req.url, 'http://challenge.local');
    upstreamPath.searchParams.delete('run');
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: req.method,
      path: `${upstreamPath.pathname}${upstreamPath.search}`, headers }, upstreamRes => {
      const responseHeaders = filteredHeaders(upstreamRes.headers);
      const cookies = Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] :
        (responseHeaders['set-cookie'] ? [responseHeaders['set-cookie']] : []);
      if (requestedRun && actor === requestedRun && !parseCookies(req.headers.cookie).openrind_ctf_run) {
        cookies.push(`openrind_ctf_run=${actor}; Path=/; HttpOnly; SameSite=Strict`);
      }
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      const event = { kind: 'site', at: new Date().toISOString(), actor, method: req.method,
        path: url.pathname, status: upstreamRes.statusCode ?? 502,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
      recordEvent(event).then(() => {
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      }).catch(() => { upstreamRes.destroy(); if (!res.headersSent) writeJson(res, 500, { code: 'CAPTURE_WRITE_FAILED' }); });
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
    upstream.on('error', () => { if (!res.headersSent) writeJson(res, 502, { code: 'CHALLENGE_APP_UNAVAILABLE' }); });
    req.pipe(upstream);
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    try {
      if (!req.url || req.url.length > 4096) { writeJson(res, 400, { code: 'INVALID_REQUEST' }); return; }
      const url = new URL(req.url, 'http://challenge.local');
      if (req.method === 'GET' && url.pathname === '/health') { writeJson(res, 200, { state: 'ready', task: task.id }); return; }
      if (url.pathname.startsWith('/v1/')) {
        if (!authorized(req)) { writeJson(res, 401, { code: 'UNAUTHORIZED' }); return; }
        if (req.method === 'GET' && url.pathname === '/v1/task') {
          writeJson(res, 200, { id: task.id, title: task.title, description: task.description, sitePath: task.sitePath }); return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/submit') {
          const body = await readJson(req, 4096);
          const submission = typeof body?.flag === 'string' ? body.flag : '';
          const correct = submission.trim() === expectedFlag;
          const actor = req.headers['x-openrind-run-actor'] ?? null;
          await recordEvent({ kind: 'judge', at: new Date().toISOString(), actor,
            submission, correct, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 });
          writeJson(res, 200, { correct }); return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/events') {
          const runId = url.searchParams.get('run');
          if (!RUN_ID_PATTERN.test(runId ?? '')) { writeJson(res, 400, { code: 'INVALID_RUN_ID' }); return; }
          const log = eventLogs.get(runId);
          writeJson(res, 200, { runId, events: log?.events ?? [], truncated: log?.truncated ?? eventActorCapacityExceeded }); return;
        }
        writeJson(res, 404, { code: 'NOT_FOUND' }); return;
      }
      const cookies = parseCookies(req.headers.cookie);
      const requestedRun = url.searchParams.get('run');
      const candidate = requestedRun ?? cookies.openrind_ctf_run ?? null;
      const actor = typeof candidate === 'string' && RUN_ID_PATTERN.test(candidate) ? candidate : null;
      proxySite(req, res, url, actor, requestedRun, startedAt);
    } catch (error) {
      const code = error instanceof SyntaxError ? 'INVALID_JSON' :
        error.message === 'REQUEST_TOO_LARGE' ? error.message : 'SERVICE_ERROR';
      if (!res.headersSent) writeJson(res, code === 'SERVICE_ERROR' ? 500 : 400, { code });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 60_000;
  return server;
}
