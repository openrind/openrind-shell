// Live container smoke test: build a challenge image from a tiny synthetic
// task directory through the generic sandboxes/ctf-challenge/Dockerfile, then
// verify the challenge proxy, run attribution, judge, and event export inside
// the container. Needs Docker. It does not need OpenShell, a browser, or a
// model key, and it is not a model evaluation.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const runtimeDir = join(root, 'openrind-desktop/packages/ctf-runtime');

const TASK_ID = 'synthetic-web';
const FLAG = 'flag{synthetic_container_smoke}';
const IMAGE = process.env.OPENRIND_CTF_SYNTHETIC_IMAGE || `openrind-ctf-${TASK_ID}:e2e`;

const SERVER_PY = `import json
from http.server import BaseHTTPRequestHandler, HTTPServer

with open('/flag.txt') as fh:
    FLAG = fh.read().strip()

PAGE = (b'<!doctype html><html><head><title>Synthetic Web Challenge</title></head>'
        b'<body><h1>Synthetic Web Challenge</h1><script src="/static/app.js"></script></body></html>')

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self._send(200, 'text/html', PAGE)
        elif self.path == '/static/app.js':
            self._send(200, 'text/javascript', b'console.log("synthetic");\\n')
        elif self.path == '/api/flag':
            self._send(200, 'application/json', json.dumps({'flag': FLAG}).encode())
        else:
            self._send(404, 'application/json', b'{"error":"not_found"}')

    def _send(self, status, content_type, body):
        self.send_response(status)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(('127.0.0.1', 8080), Handler).serve_forever()
`;

function docker(args, timeout = 60_000) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const details = `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim();
    throw new Error(`docker ${args[0]} failed${details ? `: ${details.slice(-4000)}` : ''}`);
  }
}

// Stage a build context with the runtime, the generic Dockerfile, and a tiny
// synthetic task directory (chall/ server, challenge.json, flag.txt).
function stageBuildContext() {
  const contextDir = mkdtempSync(join(tmpdir(), 'openrind-ctf-synthetic-'));
  mkdirSync(join(contextDir, 'runtime', 'bin'), { recursive: true });
  cpSync(join(runtimeDir, 'package.json'), join(contextDir, 'runtime', 'package.json'));
  cpSync(join(runtimeDir, 'src'), join(contextDir, 'runtime', 'src'), { recursive: true });
  cpSync(join(runtimeDir, 'bin', 'challenge.mjs'), join(contextDir, 'runtime', 'bin', 'challenge.mjs'));
  cpSync(join(root, 'sandboxes/ctf-challenge/Dockerfile'), join(contextDir, 'Dockerfile'));

  const taskDir = join(contextDir, 'task');
  mkdirSync(join(taskDir, 'chall'), { recursive: true });
  writeFileSync(join(taskDir, 'chall', 'server.py'), SERVER_PY);
  writeFileSync(join(taskDir, 'flag.txt'), `${FLAG}\n`);
  writeFileSync(join(taskDir, 'challenge.json'), JSON.stringify({
    id: TASK_ID,
    name: 'Synthetic Web Challenge',
    description: 'Tiny fixture app for the container smoke test.',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
  }, null, 2));
  return contextDir;
}

function buildImage() {
  if (process.env.OPENRIND_CTF_SYNTHETIC_IMAGE) {
    docker(['image', 'inspect', IMAGE]);
    return;
  }
  const contextDir = stageBuildContext();
  try {
    docker(['build', '--pull=false', '-f', join(contextDir, 'Dockerfile'),
      '--build-arg', 'RUNTIME_DIR=runtime', '--build-arg', 'TASK_DIR=task',
      '-t', IMAGE, contextDir], 600_000);
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

const name = `ctf-app-${TASK_ID}-${randomBytes(4).toString('hex')}`;
const token = randomBytes(32).toString('base64url');
const runId = `${TASK_ID}-smoke-${randomBytes(4).toString('hex')}`;

buildImage();
docker(['run', '-d', '--name', name, IMAGE, 'sleep', 'infinity']);
try {
  docker(['exec', '-d', name, '/usr/bin/node', '/opt/openrind-ctf/bin/challenge.mjs',
    '--task', TASK_ID, '--judge-token', token, '--port', '19401', '--events', '/sandbox/ctf/events.jsonl']);
  const testCode = `
    import assert from 'node:assert/strict';
    const base = 'http://127.0.0.1:19401';
    const token = ${JSON.stringify(token)};
    const runId = ${JSON.stringify(runId)};
    let cookie = '';
    const addCookies = response => {
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';', 1)[0];
        const name = pair.split('=', 1)[0];
        cookie = [...cookie.split('; ').filter(item => item.split('=', 1)[0] !== name), pair].filter(Boolean).join('; ');
      }
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(base + '/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'challenge server did not start');
    const page = await fetch(base + '/?run=' + runId);
    assert.equal(page.status, 200);
    const html = await page.text();
    addCookies(page);
    assert.match(html, /<title>Synthetic Web Challenge<\\/title>/);
    assert.ok(cookie.includes('openrind_ctf_run=' + runId), 'run cookie was not set');
    const script = await fetch(base + '/static/app.js', { headers: { cookie } });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /synthetic/);
    const flagResponse = await fetch(base + '/api/flag', { headers: { cookie } });
    assert.equal(flagResponse.status, 200);
    const flag = (await flagResponse.json()).flag.trim();
    assert.match(flag, /^flag\\{/);
    const submittedResponse = await fetch(base + '/v1/submit', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
        'x-openrind-run-actor': runId }, body: JSON.stringify({ flag }) });
    assert.equal(submittedResponse.status, 200);
    const submitted = await submittedResponse.json();
    assert.equal(submitted.correct, true);
    const exported = await (await fetch(base + '/v1/events?run=' + runId, {
      headers: { authorization: 'Bearer ' + token },
    })).json();
    assert.equal(exported.truncated, false);
    assert.ok(exported.events.some(event => event.kind === 'site' && event.actor === runId));
    assert.ok(exported.events.some(event => event.kind === 'judge' && event.actor === runId && event.correct));
  `;
  docker(['exec', name, '/usr/bin/node', '--input-type=module', '-e', testCode]);
  process.stdout.write(`${TASK_ID}: synthetic app, proxy, and judge passed\n`);
} finally {
  try { docker(['rm', '-f', name]); } catch {}
}
