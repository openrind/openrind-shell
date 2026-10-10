import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

function parseCookies(value = '') {
  return Object.fromEntries(value.split(';').map(part => part.trim().split(/=(.*)/s, 2)).filter(([name, value]) => name && value));
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

function write(res, result, extra = {}) {
  res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store', ...result.headers, ...extra });
  res.end(result.body);
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_RUN_EVENT_LOGS = 64;
const MAX_RUN_EVENT_BYTES = 384 * 1024;
const MAX_TOTAL_EVENT_BYTES = 2 * 1024 * 1024;

export function createChallengeServer({ task, judgeToken, record = async () => {} }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(judgeToken)) throw new Error('INVALID_JUDGE_TOKEN');
  const expected = createHash('sha256').update(`Bearer ${judgeToken}`).digest();
  const eventLogs = new Map();
  let totalEventBytes = 0;
  let eventActorCapacityExceeded = false;
  async function recordEvent(event) {
    await record(event);
    if (!RUN_ID_PATTERN.test(event.actor ?? '')) return;
    let log = eventLogs.get(event.actor);
    if (!log) {
      if (eventLogs.size >= MAX_RUN_EVENT_LOGS) {
        eventActorCapacityExceeded = true;
        return;
      }
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
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    try {
      if (!req.url || req.url.length > 4096) { writeJson(res, 400, { code: 'INVALID_REQUEST' }); return; }
      const url = new URL(req.url, 'http://challenge.local');
      if (req.method === 'GET' && url.pathname === '/health') { writeJson(res, 200, { state: 'ready', task: task.id }); return; }
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.openrind_ctf_session ?? randomBytes(18).toString('base64url');
      const requestedRun = url.searchParams.get('run');
      const actorCandidate = requestedRun ?? cookies.openrind_ctf_run ?? req.headers['x-openrind-run-actor'] ?? null;
      const actor = typeof actorCandidate === 'string' && RUN_ID_PATTERN.test(actorCandidate) ? actorCandidate : null;
      const setCookies = [];
      if (!cookies.openrind_ctf_session) {
        setCookies.push(`openrind_ctf_session=${sessionId}; Path=/site/; HttpOnly; SameSite=Strict`);
      }
      if (url.pathname.startsWith('/site/')) {
        if (actor && requestedRun && cookies.openrind_ctf_run !== actor) {
          setCookies.push(`openrind_ctf_run=${actor}; Path=/site/; SameSite=Strict`);
        }
        const jsonBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req, 64 * 1024) : null;
        const result = await task.route({ method: req.method, path: url.pathname, jsonBody, sessionId });
        await recordEvent({ kind: 'site', at: new Date().toISOString(), actor, method: req.method, path: url.pathname,
          status: result.status, durationMs: performance.now() - started });
        write(res, result, setCookies.length > 0 ? { 'set-cookie': setCookies } : {}); return;
      }
      const candidate = createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!timingSafeEqual(candidate, expected)) { writeJson(res, 401, { code: 'UNAUTHORIZED' }); return; }
      if (req.method === 'GET' && url.pathname === '/v1/task') { writeJson(res, 200, { id: task.id, title: task.title, description: task.description, sitePath: '/site/' }); return; }
      if (req.method === 'POST' && url.pathname === '/v1/submit') {
        const body = await readJson(req, 4096);
        const submission = typeof body?.flag === 'string' ? body.flag : '';
        const correct = submission.trim() === task.flag;
        await recordEvent({ kind: 'judge', at: new Date().toISOString(), actor: req.headers['x-openrind-run-actor'] ?? null,
          submission, correct, durationMs: performance.now() - started });
        writeJson(res, 200, { correct }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        const runId = url.searchParams.get('run');
        if (!RUN_ID_PATTERN.test(runId ?? '')) { writeJson(res, 400, { code: 'INVALID_RUN_ID' }); return; }
        const log = eventLogs.get(runId);
        writeJson(res, 200, { runId, events: log?.events ?? [], truncated: log?.truncated ?? eventActorCapacityExceeded }); return;
      }
      writeJson(res, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      const code = error instanceof SyntaxError ? 'INVALID_JSON' : error.message === 'REQUEST_TOO_LARGE' ? error.message : 'SERVICE_ERROR';
      writeJson(res, code === 'SERVICE_ERROR' ? 500 : 400, { code });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 60_000;
  return server;
}
