import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createDesktopDiagnostics, createManagedDiagnostics, openDiagnosticSession,
  recordLifecycleWithDurabilityFallback } from "../../electron/openshell/runtime-diagnostics.mjs";

function producer(enabled = true) {
  const samples = [];
  return { samples, status: () => ({ enabled }), filesystemHealth: (...args) => samples.push(args),
    agentLifecycle() {}, shutdown: async () => {} };
}

test("disabled diagnostics run no sandbox commands", async () => {
  const diagnostics = createDesktopDiagnostics({ producer: producer(false), run: () => assert.fail("unexpected exec") });
  diagnostics.watchFilesystem("owner")();
  assert.equal(diagnostics.status().watchedSandboxes, 0);
  await diagnostics.shutdown();
});

test("lifecycle records use the legacy path until OTLP has persistent acceptance", async () => {
  let legacyCalls = 0;
  let otlpCalls = 0;
  const diagnostics = { status: () => ({ persistentAcceptance: "unverified" }),
    agentLifecycle: () => { otlpCalls++; return true; } };
  const result = await recordLifecycleWithDurabilityFallback({ diagnostics, identity: {}, event: {},
    legacyRecord: async () => { legacyCalls++; } });
  assert.equal(result, "legacy");
  assert.equal(legacyCalls, 1);
  assert.equal(otlpCalls, 0);
});

test("lifecycle records use OTLP only after the receiver confirms persistent acceptance", async () => {
  let legacyCalls = 0;
  let otlpCalls = 0;
  const diagnostics = { status: () => ({ persistentAcceptance: "accepted" }),
    agentLifecycle: () => { otlpCalls++; return true; } };
  const result = await recordLifecycleWithDurabilityFallback({ diagnostics, identity: {}, event: {},
    legacyRecord: async () => { legacyCalls++; } });
  assert.equal(result, "otlp");
  assert.equal(legacyCalls, 0);
  assert.equal(otlpCalls, 1);
});

test("concurrent sessions share one non-overlapping health poll and release it by reference count", async () => {
  const sink = producer();
  let finish;
  let calls = 0;
  const diagnostics = createDesktopDiagnostics({ producer: sink, intervalMs: 5,
    run: (args, options) => {
      calls++;
      assert.deepEqual(args, ["sandbox", "exec", "-n", "owner", "--", "openrind-shell-fused", "health"]);
      assert.equal(options.ensure, false);
      assert.equal(options.timeout, 5000);
      return new Promise(resolve => { finish = resolve; });
    } });
  const first = diagnostics.watchFilesystem("owner");
  const second = diagnostics.watchFilesystem("owner");
  await delay(25);
  assert.equal(calls, 1);
  first(); first();
  assert.equal(diagnostics.status().watchedSandboxes, 1);
  finish({ exitCode: 0, stdout: '{"state":"writable","dirtyBytes":0}' });
  await delay(0);
  assert.equal(sink.samples.length, 1);
  second();
  assert.equal(diagnostics.status().watchedSandboxes, 0);
  await diagnostics.shutdown();
});

test("late health response after release is discarded", async () => {
  const sink = producer();
  let finish;
  const diagnostics = createDesktopDiagnostics({ producer: sink, run: () => new Promise(resolve => { finish = resolve; }) });
  diagnostics.watchFilesystem("owner")();
  finish({ exitCode: 0, stdout: '{}' });
  await delay(0);
  assert.equal(sink.samples.length, 0);
  await diagnostics.shutdown();
});

test("exec and parse errors are visible without disclosing output or blocking sessions", async () => {
  const diagnostics = createDesktopDiagnostics({ producer: producer(), run: async () => ({ exitCode: 0, stdout: "secret-invalid-json" }) });
  const release = diagnostics.watchFilesystem("owner");
  await delay(0);
  assert.equal(diagnostics.status().sampleFailures, 1);
  assert.equal(JSON.stringify(diagnostics.status()).includes("secret"), false);
  release();
  await diagnostics.shutdown();
});

test("shutdown bounds a stalled exporter and stops polls", async () => {
  const sink = producer();
  sink.shutdown = () => new Promise(() => {});
  const diagnostics = createDesktopDiagnostics({ producer: sink, run: async () => ({ exitCode: 1 }) });
  diagnostics.watchFilesystem("owner");
  const state = await diagnostics.shutdown();
  assert.equal(state.drainTimedOut, true);
  assert.equal(state.watchedSandboxes, 0);
});

test("idle controller never loads the SDK", async () => {
  const diagnostics = createDesktopDiagnostics({ loadProducer: () => assert.fail("SDK loaded"),
    run: () => assert.fail("unexpected exec") });
  diagnostics.watchFilesystem("owner")();
  assert.equal(diagnostics.status().phase, "idle");
  await diagnostics.shutdown();
});

test("unsupported route does not load the SDK and reports unavailable", async () => {
  const diagnostics = createDesktopDiagnostics({ loadProducer: () => assert.fail("SDK loaded") });
  await diagnostics.configure(async () => null);
  assert.equal(diagnostics.status().issue, "receiver_unsupported");
  assert.equal(diagnostics.status().phase, "unavailable");
  await diagnostics.shutdown();
});

test("a later launch retries an unsupported route without restarting the session", async () => {
  const diagnostics = createManagedDiagnostics({ createController: () => createDesktopDiagnostics({
    loadProducer: async () => () => producer(), run: async () => ({ exitCode: 1 }),
  }) });
  diagnostics.ensureManaged("owner", async () => null);
  const release = diagnostics.watchFilesystem("owner");
  await delay(0);
  assert.equal(diagnostics.status().routes[0].issue, "receiver_unsupported");
  diagnostics.ensureManaged("owner", async () => ({}));
  await delay(0);
  assert.equal(diagnostics.status().routes[0].phase, "ready");
  assert.equal(diagnostics.status().routes[0].issue, null);
  assert.equal(diagnostics.status().watchedSandboxes, 1);
  release();
  await diagnostics.shutdown();
});

test("released watch is not restarted after a shared lazy initialization", async () => {
  let finish;
  let loads = 0;
  const diagnostics = createDesktopDiagnostics({ loadProducer: () => {
    loads++;
    return new Promise(resolve => { finish = resolve; });
  }, run: () => assert.fail("late poll") });
  const first = diagnostics.configure(async () => ({ endpoint: "https://fixture.test" }));
  const second = diagnostics.configure(() => assert.fail("duplicate discovery"));
  assert.equal(first, second);
  const release = diagnostics.watchFilesystem("owner");
  release();
  await delay(0);
  finish(() => producer());
  await first;
  assert.equal(loads, 1);
  assert.equal(diagnostics.status().watchedSandboxes, 0);
  await diagnostics.shutdown();
});

test("load failure does not expose errors or escape into agent launch", async () => {
  const diagnostics = createDesktopDiagnostics({ loadProducer: () => { throw new Error("secret-module-path"); } });
  await diagnostics.configure(async () => ({}));
  assert.equal(diagnostics.status().issue, "producer_load_failed");
  assert.equal(JSON.stringify(diagnostics.status()).includes("secret"), false);
  assert.equal(diagnostics.agentLifecycle({}, {}), false);
  assert.equal(diagnostics.status().rejected, 1);
  await diagnostics.shutdown();
});

test("shutdown disposes a producer whose creation completes late", async () => {
  let finish;
  let stopped = 0;
  const diagnostics = createDesktopDiagnostics({ loadProducer: async () =>
    () => new Promise(resolve => { finish = resolve; }), run: () => assert.fail("late poll") });
  const loading = diagnostics.configure(async () => ({}));
  diagnostics.watchFilesystem("owner");
  await delay(0);
  await diagnostics.shutdown();
  finish({ ...producer(), shutdown: async () => { stopped++; } });
  await loading;
  assert.equal(stopped, 1);
  assert.equal(diagnostics.status().phase, "closed");
});

test("discovery has a deadline and never loads after it expires", async () => {
  let finish;
  const diagnostics = createDesktopDiagnostics({ initializeTimeoutMs: 5,
    loadProducer: () => assert.fail("late load") });
  await diagnostics.configure(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(diagnostics.status().issue, "initialization_timeout");
  finish({});
  await delay(0);
  await diagnostics.shutdown();
});

test("session adoption releases only the extra watch and preserves the original callback", async () => {
  const diagnostics = createDesktopDiagnostics({ producer: producer(),
    run: async () => ({ exitCode: 0, stdout: '{"state":"writable","dirtyBytes":0}' }) });
  let original;
  let exits = 0;
  const first = await openDiagnosticSession({ diagnostics, options: { sandboxName: "owner" },
    openSession: async options => { original = options; return { reused: false }; },
    onLifecycleExit: async () => { exits++; } });
  assert.equal(first.reused, false);
  const second = await openDiagnosticSession({ diagnostics, options: { sandboxName: "owner" },
    openSession: async () => ({ reused: true }), onLifecycleExit: () => assert.fail("replaced original callback") });
  assert.equal(second.reused, true);
  assert.equal(diagnostics.status().watchedSandboxes, 1);
  await original.onLifecycleExit({});
  assert.equal(exits, 1);
  assert.equal(diagnostics.status().watchedSandboxes, 0);
  await diagnostics.shutdown();
});

test("lifecycle completion runs before its final diagnostics watch is released", async () => {
  const order = [];
  let finishLifecycle;
  let sessionOptions;
  const diagnostics = { ensureManaged() {}, watchFilesystem: () => () => order.push("released") };
  await openDiagnosticSession({ diagnostics, options: { sandboxName: "owner" },
    openSession: async options => { sessionOptions = options; return { reused: false }; },
    onLifecycleExit: async () => {
      await new Promise(resolve => { finishLifecycle = resolve; });
      order.push("recorded");
    } });
  const exiting = sessionOptions.onLifecycleExit({});
  await delay(0);
  assert.deepEqual(order, []);
  finishLifecycle();
  await exiting;
  assert.deepEqual(order, ["recorded", "released"]);
});

test("failed session launch releases its watch", async () => {
  const diagnostics = createDesktopDiagnostics({ producer: producer(), run: async () => ({ exitCode: 1 }) });
  await assert.rejects(openDiagnosticSession({ diagnostics, options: { sandboxName: "owner" },
    openSession: async () => { throw new Error("fixture launch failed"); }, onLifecycleExit() {} }), /launch failed/);
  assert.equal(diagnostics.status().watchedSandboxes, 0);
  await diagnostics.shutdown();
});

test("managed routes retain separate producers and drain after final lifecycle recording", async () => {
  const calls = [];
  const diagnostics = createManagedDiagnostics({ createController: () => createDesktopDiagnostics({
    loadProducer: async () => ({ configuration }) => ({ ...producer(),
      agentLifecycle(identity) { calls.push([configuration.project, identity.project]); return true; } }),
    run: async () => ({ exitCode: 1 }),
  }) });
  diagnostics.ensureManaged("one", async () => ({ project: "one" }));
  diagnostics.ensureManaged("two", async () => ({ project: "two" }));
  const first = diagnostics.watchFilesystem("one");
  const second = diagnostics.watchFilesystem("one");
  const other = diagnostics.watchFilesystem("two");
  await delay(0);
  first();
  await delay(0);
  assert.equal(diagnostics.status().watchedSandboxes, 2);
  second();
  assert.equal(diagnostics.agentLifecycle({ project: "one" }, {}), true);
  await delay(0);
  assert.equal(diagnostics.status().watchedSandboxes, 1);
  assert.equal(diagnostics.agentLifecycle({ project: "two" }, {}), true);
  assert.deepEqual(calls, [["one", "one"], ["two", "two"]]);
  other();
  await delay(0);
  assert.equal(diagnostics.status().recent.length, 2);
  await diagnostics.shutdown();
});
