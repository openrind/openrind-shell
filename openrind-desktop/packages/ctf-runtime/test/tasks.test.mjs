import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChallengeServer } from '../src/challenge-server.mjs';
import { runCtfAgent, validateChallengeEventExport } from '../src/agent.mjs';
import { createTask, getAllTasks, publicTask, registerDynamicTask } from '../src/tasks.mjs';

// Synthetic fixture: the runtime bundles no tasks, so the tests register a tiny
// dynamic task that follows the standard directory conventions (a chall/
// server, a flag.txt, and a narrow route allowlist).
const SYNTHETIC_TASK = {
  id: 'synthetic-web',
  title: 'Synthetic Web Challenge',
  description: 'A tiny fixture app used to test the proxy and judge contract.',
  backendPort: 8080,
  entrypoint: '/opt/openrind-ctf/task/chall/server.py',
  workingDirectory: '/opt/openrind-ctf/task/chall',
  browserRules: [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/favicon.ico' },
    { method: 'GET', path: '/static/**' },
    { method: 'GET', path: '/api/options' },
    { method: 'POST', path: '/api/monitor' },
  ],
};

test('the task registry starts empty and rejects unknown tasks', () => {
  assert.deepEqual(getAllTasks(), []);
  assert.throws(() => createTask('synthetic-web'), /UNKNOWN_TASK/);
});

test('registerDynamicTask normalizes discovered task metadata', () => {
  const minimal = registerDynamicTask({ id: 'synthetic-minimal' });
  assert.equal(minimal.title, 'synthetic-minimal');
  assert.equal(minimal.description, '');
  assert.equal(minimal.sitePath, '/');
  assert.equal(minimal.backendPort, 8080);
  assert.equal(minimal.entrypoint, '/opt/openrind-ctf/task/chall/server.py');
  assert.equal(minimal.workingDirectory, '/opt/openrind-ctf/task/chall');
  assert.equal(minimal.category, 'web');
  assert.equal(minimal.image, 'openrind-ctf-synthetic-minimal:local');
  assert.equal(minimal.flag, '');
  assert.equal(minimal.license, null);
  assert.equal(minimal.redistributable, true);
  assert.deepEqual(minimal.browserRules, [
    { method: 'GET', path: '/**' },
    { method: 'POST', path: '/**' },
  ]);

  const task = registerDynamicTask(SYNTHETIC_TASK);
  assert.equal(createTask('synthetic-web'), task);
  assert.ok(getAllTasks().some(entry => entry.id === 'synthetic-web'));
  assert.equal(task.title, 'Synthetic Web Challenge');
  assert.equal(task.backendPort, 8080);
  assert.ok(task.browserRules.some(rule => rule.path === '/api/options'));
  assert.ok(task.browserRules.some(rule => rule.path === '/static/**'));

  const publicView = publicTask(task);
  assert.equal(publicView.id, 'synthetic-web');
  assert.equal(publicView.title, 'Synthetic Web Challenge');
  assert.equal('entrypoint' in publicView, false);
  assert.equal('browserRules' in publicView, false);
  assert.equal('flag' in publicView, false);

  assert.throws(() => registerDynamicTask({}), /INVALID_TASK/);
  assert.throws(() => createTask('never-registered'), /UNKNOWN_TASK/);
});

test('the service proxies original app paths and records the browser run cookie', async () => {
  const task = createTask('synthetic-web');
  const events = [];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'benchmark-session=abc; Path=/' });
    res.end(`${req.method} ${req.url}`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const service = createChallengeServer({ task, judgeToken: 'a'.repeat(43), expectedFlag: 'flag{unit-test}',
    upstreamPort: upstream.address().port, record: async event => events.push(event) });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const origin = `http://127.0.0.1:${service.address().port}`;
  try {
    const page = await fetch(`${origin}/?run=run-12345678`);
    assert.equal(await page.text(), 'GET /');
    assert.deepEqual(page.headers.getSetCookie(), [
      'benchmark-session=abc; Path=/', 'openrind_ctf_run=run-12345678; Path=/; HttpOnly; SameSite=Strict',
    ]);
    const script = await fetch(`${origin}/static/terminal/js/main.js`, {
      headers: { cookie: 'openrind_ctf_run=run-12345678' },
    });
    assert.equal(await script.text(), 'GET /static/terminal/js/main.js');
    assert.ok(events.some(event => event.kind === 'site' && event.path === '/' && event.actor === 'run-12345678'));
    assert.ok(events.some(event => event.kind === 'site' && event.path === '/static/terminal/js/main.js' && event.actor === 'run-12345678'));
  } finally {
    const closed = Promise.all([once(service, 'close'), once(upstream, 'close')]);
    service.close(); upstream.close();
    await closed;
  }
});

test('the judge route is not proxied and is unavailable without the judge credential', async () => {
  const task = createTask('synthetic-web');
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => { upstreamRequests++; res.end('unexpected'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const events = [];
  const token = 'b'.repeat(43);
  const service = createChallengeServer({ task, judgeToken: token, expectedFlag: 'flag{unit-test}',
    upstreamPort: upstream.address().port, record: async event => events.push(event) });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const origin = `http://127.0.0.1:${service.address().port}`;
  try {
    const denied = await fetch(`${origin}/v1/submit`, { method: 'POST', body: JSON.stringify({ flag: 'flag{unit-test}' }) });
    assert.equal(denied.status, 401);
    assert.equal(upstreamRequests, 0);
    const accepted = await fetch(`${origin}/v1/submit`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-openrind-run-actor': 'run-12345678' },
      body: JSON.stringify({ flag: 'flag{unit-test}' }) });
    assert.deepEqual(await accepted.json(), { correct: true });
    assert.ok(events.some(event => event.kind === 'judge' && event.correct && event.actor === 'run-12345678'));
  } finally {
    const closed = Promise.all([once(service, 'close'), once(upstream, 'close')]);
    service.close(); upstream.close();
    await closed;
  }
});

test('challenge event export rejects records from another run', () => {
  assert.deepEqual(validateChallengeEventExport({ runId: 'run-12345678', truncated: false,
    events: [{ actor: 'run-12345678', kind: 'site' }] }, 'run-12345678'),
  [{ actor: 'run-12345678', kind: 'site' }]);
  assert.throws(() => validateChallengeEventExport({ runId: 'run-12345678', truncated: false,
    events: [{ actor: 'run-87654321', kind: 'site' }] }, 'run-12345678'), /CHALLENGE_EVENT_EXPORT_INCOMPLETE/);
});

test('the unimplemented Haloop mode fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openrind-ctf-mode-'));
  const configPath = join(directory, 'agent.json');
  try {
    await writeFile(configPath, JSON.stringify({ modelMode: 'haloop' }));
    await assert.rejects(runCtfAgent(configPath), /HALOOP_CTF_PROFILE_NOT_IMPLEMENTED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
