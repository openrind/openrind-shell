import { runFuseOpenShell } from "./fuse-runtime.mjs";

let moduleTask;
async function loadDiagnosticProducer() {
  // This asset contains its dependencies. No SDK is resolved during app startup.
  const asset = new URL("../generated/runtime-diagnostics.cjs", import.meta.url).href;
  moduleTask ??= import(asset).catch(error => { moduleTask = undefined; throw error; });
  const module = await moduleTask;
  return module.createRuntimeDiagnostics ?? module.default.createRuntimeDiagnostics;
}

export function createDesktopDiagnostics({ producer = null, loadProducer = loadDiagnosticProducer,
  run = runFuseOpenShell, intervalMs = 30_000, initializeTimeoutMs = 5000, shutdownTimeoutMs = 2000 } = {}) {
  const watches = new Map();
  let closed = false;
  let configured = Boolean(producer);
  let phase = producer ? "ready" : "idle";
  let issue = null;
  let task;
  let shutdownTask;
  let sampleFailures = 0;
  let rejected = 0;
  let drainTimedOut = false;

  function status() {
    return { enabled: Boolean(producer?.status().enabled) && !closed, configured, closed, phase, issue,
      rejected, watchedSandboxes: watches.size, sampleFailures, drainTimedOut,
      persistentAcceptance: "unverified", producer: producer?.status() ?? null };
  }

  async function dispose(value) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => value.shutdown()).catch(() => { issue = "shutdown_error"; }),
        new Promise(resolve => { timer = setTimeout(() => { drainTimedOut = true; resolve(); }, shutdownTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function configure(resolveConfiguration) {
    if (closed || producer) return Promise.resolve(status());
    if (task) return task;
    configured = true;
    phase = "discovering";
    issue = null;
    let expired = false;
    let timer;
    const initialize = async () => {
      try {
        const configuration = await resolveConfiguration();
        if (closed || expired) return;
        if (!configuration) { phase = "unavailable"; issue = "receiver_unsupported"; return; }
        phase = "loading";
        const createProducer = await loadProducer();
        if (closed || expired) return;
        const candidate = await createProducer({ configuration, env: {} });
        if (closed || expired) { await dispose(candidate); return; }
        if (!candidate.status().enabled) {
          phase = "unavailable"; issue = "configuration_error";
          await dispose(candidate);
          return;
        }
        producer = candidate;
        phase = "ready";
        issue = null;
        for (const watch of watches.values()) start(watch);
      } catch (error) {
        if (closed || expired) return;
        issue = phase === "loading" ? "producer_load_failed" :
          ["receiver_unsupported", "route_invalid", "route_unauthorized", "route_unavailable"].includes(error?.code)
            ? error.code : "route_unavailable";
        phase = "unavailable";
      }
    };
    const current = Promise.race([
      initialize(),
      new Promise(resolve => { timer = setTimeout(() => {
        expired = true;
        if (!closed) { phase = "unavailable"; issue = "initialization_timeout"; }
        resolve();
      }, initializeTimeoutMs); }),
    ]).finally(() => clearTimeout(timer)).then(status);
    task = current;
    void current.then(
      () => { if (task === current) task = undefined; },
      () => { if (task === current) task = undefined; },
    );
    return current;
  }

  function start(watch) {
    if (closed || watch.stopped || watch.timer || !producer?.status().enabled) return;
    watch.timer = setInterval(() => { void watch.sample(); }, intervalMs);
    watch.timer.unref?.();
    void watch.sample();
  }

  function watchFilesystem(name) {
    if (closed || !configured || (producer && !producer.status().enabled)) return () => {};
    let watch = watches.get(name);
    if (!watch) {
      if (watches.size >= 32) { sampleFailures++; return () => {}; }
      watch = { references: 0, pending: false, timer: null, stopped: false, sample: null };
      watch.sample = async () => {
        if (watch.pending || watch.stopped || closed) return;
        watch.pending = true;
        try {
          const result = await run(["sandbox", "exec", "-n", name, "--", "openrind-shell-fused", "health"],
            { ensure: false, timeout: 5000 });
          if (watch.stopped || closed) return;
          if (result.exitCode !== 0 || result.stdout.length > 64 * 1024) throw new Error("Health unavailable");
          if (!producer.filesystemHealth(name, JSON.parse(result.stdout))) rejected++;
        } catch { if (!watch.stopped && !closed) sampleFailures++; }
        finally { watch.pending = false; }
      };
      watches.set(name, watch);
      start(watch);
    }
    watch.references++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--watch.references === 0) {
        watch.stopped = true;
        clearInterval(watch.timer);
        watches.delete(name);
      }
    };
  }

  function agentLifecycle(identity, event) {
    if (closed || !producer?.status().enabled) { rejected++; return false; }
    try {
      const accepted = producer.agentLifecycle(identity, event);
      if (!accepted) rejected++;
      return accepted;
    } catch { rejected++; issue = "invalid_diagnostic_record"; return false; }
  }

  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true;
    phase = "closed";
    for (const watch of watches.values()) {
      watch.stopped = true;
      clearInterval(watch.timer);
    }
    watches.clear();
    shutdownTask = (async () => { if (producer) await dispose(producer); return status(); })();
    return shutdownTask;
  }

  return { configure, watchFilesystem, status, shutdown, agentLifecycle };
}

export function createManagedDiagnostics({ createController = createDesktopDiagnostics } = {}) {
  const routes = new Map();
  const recent = [];
  const drains = new Set();
  let closed = false;
  let rejected = 0;
  let shutdownTask;

  function ensureManaged(name, resolveConfiguration) {
    if (closed) return;
    const current = routes.get(name);
    if (current) { void current.controller.configure(resolveConfiguration); return; }
    if (!/^[A-Za-z0-9_.-]{1,19}$/.test(name) || routes.size + drains.size >= 32) { rejected++; return; }
    const entry = { controller: createController(), references: 0 };
    routes.set(name, entry);
    void entry.controller.configure(resolveConfiguration);
  }

  function watchFilesystem(name) {
    const entry = routes.get(name);
    if (!entry || closed) return () => {};
    entry.references++;
    const release = entry.controller.watchFilesystem(name);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      entry.references--;
      // Defer teardown until the lifecycle callback has finished recording its event.
      queueMicrotask(() => {
        if (entry.references || routes.get(name) !== entry) return;
        routes.delete(name);
        const snapshot = { sandboxName: name, ...entry.controller.status() };
        recent.push(snapshot);
        if (recent.length > 32) recent.shift();
        const drain = entry.controller.shutdown().then(state => Object.assign(snapshot, state));
        drains.add(drain);
        void drain.finally(() => drains.delete(drain));
      });
    };
  }

  function status() {
    return { mode: "managed", closed, rejected, persistentAcceptance: "unverified",
      enabled: [...routes.values()].some(entry => entry.controller.status().enabled),
      draining: drains.size,
      watchedSandboxes: [...routes.values()].filter(entry => entry.references > 0).length,
      routes: [...routes].map(([name, entry]) => ({ sandboxName: name, ...entry.controller.status() })),
      recent: structuredClone(recent) };
  }

  function agentLifecycle(identity, event) {
    const entry = routes.get(identity?.project);
    if (!entry || closed) { rejected++; return false; }
    return entry.controller.agentLifecycle(identity, event);
  }

  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true;
    shutdownTask = (async () => {
      await Promise.all([...drains, ...[...routes.values()].map(entry => entry.controller.shutdown())]);
      routes.clear();
      return status();
    })();
    return shutdownTask;
  }
  return { ensureManaged, watchFilesystem, status, agentLifecycle, shutdown };
}

export async function openDiagnosticSession({ diagnostics, openSession, options,
  resolveConfiguration, onLifecycleExit }) {
  diagnostics.ensureManaged?.(options.sandboxName, resolveConfiguration);
  const release = diagnostics.watchFilesystem(options.sandboxName);
  try {
    const opened = await openSession({ ...options, onLifecycleExit: async event => {
      try { await onLifecycleExit(event); }
      finally { release(); }
    } });
    if (opened.reused) release();
    return opened;
  } catch (error) { release(); throw error; }
}

export async function recordLifecycleWithDurabilityFallback({ diagnostics, identity, event, legacyRecord }) {
  // Local queue admission is not a durable acknowledgement. Keep the existing
  // Haloop path until the receiver contract can confirm persistent acceptance.
  if (diagnostics.status().persistentAcceptance === "accepted" && diagnostics.agentLifecycle(identity, event)) {
    return "otlp";
  }
  await legacyRecord();
  return "legacy";
}

export const runtimeDiagnostics = createManagedDiagnostics();
