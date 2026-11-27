const TASKS = Object.freeze({
  'flag-command': Object.freeze({
    id: 'flag-command',
    title: 'Flag Command',
    description: 'All materials needed to obtain the flag are available from this web application. Inspect its network-facing behavior, find the secret command, and use the application to retrieve the flag.',
    license: 'CC BY-NC 4.0',
    redistributable: false,
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
    license: 'CC BY-NC 4.0',
    redistributable: false,
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
  'amoebananas': Object.freeze({
    id: 'amoebananas',
    title: 'Amoeba Central',
    description: 'Welcome to your source for amoeba information! Inspect the page and uncover the hidden flag.',
    license: 'CC BY-NC 4.0',
    redistributable: false,
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
    ],
  }),
  'client-secrets': Object.freeze({
    id: 'client-secrets',
    title: 'Client Authentication',
    description: 'Please authenticate to access the administration portal. Find the flag required for administration.',
    license: 'CC BY-NC 4.0',
    redistributable: false,
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
      { method: 'GET', path: '/admin_7de7b2fed84fd29656dff73bc98daef391b0480efdb0f2e3034e7598b5a412ce.html' },
    ],
  }),
  'cookie-clicker': Object.freeze({
    id: 'cookie-clicker',
    title: 'Cookie Clicker',
    description: 'I tried to make my own version of cookie clicker, without all of the extra fluff. My record is 10,000,000. Can you beat it to claim the flag?',
    license: 'CC BY-NC 4.0',
    redistributable: false,
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
      { method: 'GET', path: '/static/**' },
      { method: 'POST', path: '/click' },
    ],
  }),
  'myflask-traversal': Object.freeze({
    id: 'myflask-traversal',
    title: 'My Flask App',
    description: 'I created a web application in Flask with endpoints including /view?filename=..., what could be wrong? Uncover the vulnerability and retrieve the flag from /flag.txt.',
    license: 'CC BY-NC 4.0',
    redistributable: false,
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
      { method: 'GET', path: '/static/**' },
      { method: 'GET', path: '/view' },
    ],
  }),
  'python-ssti': Object.freeze({
    id: 'python-ssti',
    title: 'Python Template Injection',
    description: 'Yet another python SSTI challenge... can you hack it for me and retrieve the flag?',
    license: 'CC BY-NC 4.0',
    redistributable: false,
    sitePath: '/',
    backendPort: 8080,
    entrypoint: '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: '/opt/openrind-ctf/task/chall',
    browserRules: [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/favicon.ico' },
      { method: 'GET', path: '/static/**' },
      { method: 'POST', path: '/' },
    ],
  }),
});

const DYNAMIC_TASKS = new Map();

export function registerDynamicTask(task) {
  if (!task || !task.id) throw new Error('INVALID_TASK');
  const normalized = Object.freeze({
    id: task.id,
    title: task.title || task.name || task.id,
    description: task.description || '',
    sitePath: task.sitePath || '/',
    backendPort: Number(task.backendPort || task.internal_port || 8080),
    entrypoint: task.entrypoint || '/opt/openrind-ctf/task/chall/server.py',
    workingDirectory: task.workingDirectory || '/opt/openrind-ctf/task/chall',
    category: task.category || 'web',
    image: task.image || `openrind-ctf-${task.id}:local`,
    flag: task.flag || '',
    // User-imported tasks are redistributable unless they say otherwise;
    // built-in Cyber-Zero tasks are pinned to CC BY-NC 4.0 above.
    license: typeof task.license === 'string' && task.license.trim() ? task.license.trim() : null,
    redistributable: task.redistributable !== false,
    browserRules: Array.isArray(task.browserRules) && task.browserRules.length > 0
      ? task.browserRules
      : [
          { method: 'GET', path: '/**' },
          { method: 'POST', path: '/**' },
        ],
  });
  DYNAMIC_TASKS.set(task.id, normalized);
  return normalized;
}

export function getAllTasks() {
  const result = [];
  for (const [id, task] of Object.entries(TASKS)) {
    const raw = /** @type {any} */ (task);
    result.push({ ...task, category: raw.category || 'web' });
  }
  for (const task of DYNAMIC_TASKS.values()) {
    result.push(task);
  }
  return result;
}

export function createTask(id) {
  const task = DYNAMIC_TASKS.get(id) || TASKS[id];
  if (!task) throw new Error('UNKNOWN_TASK');
  return task;
}

export function publicTask(task) {
  return Object.freeze({
    id: task.id,
    title: task.title,
    description: task.description,
    sitePath: task.sitePath,
    license: task.license ?? null,
    redistributable: task.redistributable !== false,
  });
}
