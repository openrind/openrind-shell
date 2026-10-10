import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const images = {
  'flag-command': process.env.CTF_FLAG_COMMAND_IMAGE || 'openrind-ctf-flag-command:e2e',
  'glacier-exchange': process.env.CTF_GLACIER_EXCHANGE_IMAGE || 'openrind-ctf-glacier-exchange:e2e',
};

function docker(args, timeout = 60_000) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const details = `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim();
    throw new Error(`docker ${args[0]} failed${details ? `: ${details.slice(-4000)}` : ''}`);
  }
}

async function verifyImage(taskId, image) {
  docker(['image', 'inspect', image]);
  const name = `ctf-app-${taskId}-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const runId = `${taskId}-smoke-${randomBytes(4).toString('hex')}`;
  docker(['run', '-d', '--name', name, image, 'sleep', 'infinity']);
  try {
    docker(['exec', '-d', name, '/usr/bin/node', '/opt/openrind-ctf/bin/challenge.mjs',
      '--task', taskId, '--judge-token', token, '--port', '19401', '--events', '/sandbox/ctf/events.jsonl']);
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
      const json = async (path, method = 'GET', body) => {
        const response = await fetch(base + path, { method,
          headers: { cookie, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        assert.equal(response.status, 200, path);
        addCookies(response);
        return response.json();
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
      let flag;
      if (${JSON.stringify(taskId)} === 'flag-command') {
        assert.match(html, /<title>Flag Command<\\/title>/);
        const script = await fetch(base + '/static/terminal/js/main.js', { headers: { cookie } });
        assert.equal(script.status, 200);
        assert.match(await script.text(), /api\\/options/);
        const options = await json('/api/options');
        const command = options.allPossibleCommands.secret[0];
        flag = (await json('/api/monitor', 'POST', { command })).message.trim();
        assert.match(flag, /^HTB\\{/);
      } else {
        assert.match(html, /<title>GlacierExchange<\\/title>/);
        const script = await fetch(base + '/assets/scripts/index.js', { headers: { cookie } });
        assert.equal(script.status, 200);
        assert.match(await script.text(), /api\\/wallet\\/transaction/);
        await json('/api/wallet/balances');
        for (const [sourceCoin, targetCoin, balance] of [
          ['ascoin', 'glaciercoin', '-1e28'],
          ['ascoin', 'cashout', '1e9'],
          ['ascoin', 'glaciercoin', '1e28'],
        ]) {
          assert.equal((await json('/api/wallet/transaction', 'POST', { sourceCoin, targetCoin, balance })).result, 1);
        }
        const club = await json('/api/wallet/join_glacier_club', 'POST', {});
        assert.equal(club.inClub, true);
        flag = club.clubToken;
        assert.match(flag, /^gctf\\{/);
      }
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
    process.stdout.write(`${taskId}: original app, proxy, and judge passed\n`);
  } finally {
    try { docker(['rm', '-f', name]); } catch {}
  }
}

for (const [taskId, image] of Object.entries(images)) await verifyImage(taskId, image);
