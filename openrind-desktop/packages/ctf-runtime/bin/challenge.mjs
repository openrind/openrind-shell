#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createChallengeServer } from '../src/challenge-server.mjs';
import { createTask, registerDynamicTask } from '../src/tasks.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]; const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || args.has(name)) throw new Error('INVALID_ARGUMENTS');
  args.set(name, value);
}

// Images built from an arbitrary task directory carry no bundled registry.
// Resolve the task from metadata baked into the image at build time.
async function resolveTask(id) {
  try { return createTask(id); } catch {}
  try {
    const parsed = JSON.parse(await readFile('/opt/openrind-ctf/task/challenge.json', 'utf8'));
    const task = registerDynamicTask({ ...parsed, id: parsed.id || id });
    if (task.id !== id) throw new Error('TASK_ID_MISMATCH');
    return task;
  } catch (error) {
    if (error.message === 'TASK_ID_MISMATCH') throw error;
  }
  // Minimal convention: chall/server.py plus flag.txt needs no metadata file.
  try {
    await readFile('/opt/openrind-ctf/task/flag.txt', 'utf8');
    return registerDynamicTask({ id });
  } catch {}
  throw new Error('UNKNOWN_TASK');
}

const task = await resolveTask(args.get('--task'));
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
  stdio: ['ignore', 'inherit', 'pipe'],
});
let appStderr = '';
app.stderr?.on('data', chunk => appStderr += chunk);
let appExited;
const appExit = new Promise(resolve => {
  app.once('error', (err) => resolve({ code: -1, signal: null, err }));
  app.once('exit', (code, signal) => resolve({ code, signal }));
});

async function waitForApp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    appExited = await Promise.race([appExit, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
    if (appExited) throw new Error(`CHALLENGE_APP_EXITED: code=${appExited.code} signal=${appExited.signal} stderr=${appStderr}`);
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
const host = args.get('--host') ?? '0.0.0.0';
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
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
