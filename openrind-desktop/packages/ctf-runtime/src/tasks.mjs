const TASKS = Object.freeze({
  'flag-command': Object.freeze({
    id: 'flag-command',
    title: 'Flag Command',
    description: 'All materials needed to obtain the flag are available from this web application. Inspect its network-facing behavior, find the secret command, and use the application to retrieve the flag.',
    sitePath: '/',
    backendPort: 1337,
    entrypoint: '/opt/openrind-ctf/task/challenge/run.py',
    workingDirectory: '/opt/openrind-ctf/task/challenge',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
      { method: 'GET', path: '/static/**' },
      { method: 'GET', path: '/api/options' },
      { method: 'POST', path: '/api/monitor' },
    ],
  }),
  'glacier-exchange': Object.freeze({
    id: 'glacier-exchange',
    title: 'GlacierXchange',
    description: 'We have launched a new revolutionary exchange tool, allowing you to trade on the market and hang out with your rich friends in the Glacier Club. Only billionaires can get in. Can you help me hang out with lEon sMuk?',
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/assets/**' },
      { method: 'GET', path: '/api/fetch_coins' },
      { method: 'GET', path: '/api/wallet/balances' },
      { method: 'GET', path: '/api/data/fetch/**' },
      { method: 'POST', path: '/api/wallet/transaction' },
      { method: 'POST', path: '/api/wallet/join_glacier_club' },
    ],
  }),
});

export function createTask(id) {
  const task = TASKS[id];
  if (!task) throw new Error('UNKNOWN_TASK');
  return task;
}

export function publicTask(task) {
  return Object.freeze({ id: task.id, title: task.title, description: task.description, sitePath: task.sitePath });
}
