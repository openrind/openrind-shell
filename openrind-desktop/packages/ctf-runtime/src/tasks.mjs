// The runtime bundles no challenge tasks. Task metadata arrives at runtime:
// the Desktop service discovers challenge directories and registers them here,
// and challenge images bake a task definition that bin/challenge.mjs registers.
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
    // User-imported tasks are redistributable unless they say otherwise.
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
  return [...DYNAMIC_TASKS.values()];
}

export function createTask(id) {
  const task = DYNAMIC_TASKS.get(id);
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
