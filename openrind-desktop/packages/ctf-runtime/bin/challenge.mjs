#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createChallengeServer } from '../src/challenge-server.mjs';
import { createTask } from '../src/tasks.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]; const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || args.has(name)) throw new Error('INVALID_ARGUMENTS');
  args.set(name, value);
}
const task = createTask(args.get('--task'));
const token = args.get('--judge-token');
const port = Number(args.get('--port') ?? '19401');
const upstreamPort = task.backendPort;
const eventsPath = args.get('--events') ?? '/sandbox/events.jsonl';
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) {
  throw new Error('INVALID_ARGUMENTS');
}

await mkdir('/sandbox/ctf', { recursive: true });
const expectedFlag = (await readFile('/opt/openrind-ctf/task/flag.txt', 'utf8')).trim();
if (!expectedFlag) throw new Error('CHALLENGE_FLAG_MISSING');
const events = await open(eventsPath, 'a', 0o600);
const record = async value => { await events.write(`${JSON.stringify(value)}\n`); await events.sync(); };
const app = spawn('/opt/openrind-ctf/venv/bin/python', [task.entrypoint], {
  cwd: task.workingDirectory,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  stdio: 'ignore',
});
let appExited;
const appExit = new Promise(resolve => {
  app.once('error', () => resolve({ code: -1 }));
  app.once('exit', (code, signal) => resolve({ code, signal }));
});

async function waitForApp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    appExited = await Promise.race([appExit, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
    if (appExited) throw new Error('CHALLENGE_APP_EXITED');
    const socket = connect({ host: '127.0.0.1', port: upstreamPort });
    const connected = await new Promise(resolve => {
      socket.setTimeout(150);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
  }
  app.kill('SIGTERM');
  throw new Error('CHALLENGE_APP_START_TIMEOUT');
}

await waitForApp();
const server = createChallengeServer({ task, judgeToken: token, expectedFlag, upstreamPort, record });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
await record({ kind: 'challenge_ready', at: new Date().toISOString(), task: task.id, port, upstreamPort });
const close = async () => {
  server.close();
  if (app.exitCode === null) app.kill('SIGTERM');
  await Promise.race([appExit, new Promise(resolve => setTimeout(resolve, 1500))]);
  if (app.exitCode === null) app.kill('SIGKILL');
  await events.close();
};
process.once('SIGTERM', () => { close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { close().finally(() => process.exit(0)); });
