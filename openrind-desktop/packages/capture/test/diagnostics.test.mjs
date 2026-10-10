import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createRuntimeDiagnostics } from "../src/diagnostics.mjs";

const identity = { traceId: "1".repeat(32), rootSpanId: "2".repeat(16) };
const health = { state: "writable", dirtyBytes: 17, lastWritebackError: null,
  diagnostics: { version: 1, instanceId: "12345678-1234-1234-1234-123456789abc",
    requestsStarted: 3, requestsCompleted: 2, requestErrors: 1, requestDurationMicros: 19 } };

test("absent endpoint is inert; invalid configuration is visible and contains no secret", async () => {
  const disabled = createRuntimeDiagnostics({ env: {}, createProducer: () => { throw new Error("must not run"); } });
  assert.equal(disabled.filesystemHealth("test", health), false);
  assert.equal(disabled.status().enabled, false);
  await disabled.shutdown();
  const invalid = createRuntimeDiagnostics({ env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: "https://secret@example.test" } });
  assert.equal(invalid.status().issue, "configuration_error");
  assert.equal(JSON.stringify(invalid.status()).includes("secret"), false);
  await invalid.shutdown();
});

test("projects only allowed lifecycle and filesystem diagnostic fields", async () => {
  const records = [];
  const diagnostics = createRuntimeDiagnostics({ env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: "http://localhost:4318" },
    createProducer: () => ({ recordOperation(record) { records.push(record); return { accepted: true }; },
      status: () => ({}), shutdown: async () => {} }) });
  assert.equal(diagnostics.filesystemHealth("private-workspace", { ...health,
    databaseUrl: "private-url", lastInitializationError: "private-error", fileContents: "private-file" }), true);
  assert.equal(diagnostics.agentLifecycle(identity, { startMs: 1, endMs: 2,
    input: "private-input", output: "private-output", attributes: {
      "openrind.agent.id": "claude", "openrind.lifecycle": "completed", "openrind.command": "private-command",
    } }), true);
  assert.equal(records[0].attributes["filesystem.requestsStarted"], 3);
  assert.equal(records[1].traceparent, `00-${identity.traceId}-${identity.rootSpanId}-01`);
  assert.equal(JSON.stringify(records).includes("private-"), false);
  assert.equal(diagnostics.agentLifecycle(identity, { attributes: { "openrind.agent.id": "unknown" } }), false);
  assert.equal(diagnostics.status().rejected, 1);
  await diagnostics.shutdown();
  assert.equal(diagnostics.filesystemHealth("test", health), false);
});

test("handles older daemons without inventing counters and rejects invalid numbers", async () => {
  const records = [];
  const diagnostics = createRuntimeDiagnostics({ env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: "http://localhost:4318" },
    createProducer: () => ({ recordOperation(record) { records.push(record); return { accepted: true }; },
      status: () => ({}), shutdown: async () => {} }) });
  assert.equal(diagnostics.filesystemHealth("test", { state: "initializing", dirtyBytes: 0 }), true);
  assert.equal(records[0].attributes["filesystem.counters_available"], false);
  assert.equal(records[0].status, "error");
  assert.equal(diagnostics.filesystemHealth("test", { ...health, dirtyBytes: -1 }), false);
  assert.equal(diagnostics.filesystemHealth("test", { ...health, diagnostics: { ...health.diagnostics, requestsStarted: Infinity } }), false);
  await diagnostics.shutdown();
});

test("managed configuration ignores environment overrides and confines records to its project", async () => {
  const records = [];
  let options;
  const configuration = { endpoint: "https://managed.test", project: "owner", sandboxName: "owner",
    headers: async () => ({ authorization: "Bearer managed" }), revoke: async () => "revoked" };
  const diagnostics = createRuntimeDiagnostics({ configuration,
    env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: "https://override.test" },
    createProducer: value => {
      options = value;
      return { recordOperation(record) { records.push(record); return { accepted: true }; },
        status: () => ({}), shutdown: async () => {} };
    } });
  assert.equal(options.endpoint, configuration.endpoint);
  assert.deepEqual(await options.headers(), { authorization: "Bearer managed" });
  assert.equal(diagnostics.filesystemHealth("other", health), false);
  assert.equal(diagnostics.filesystemHealth("owner", health), true);
  assert.equal(records[0].attributes["project.id"], "owner");
  assert.equal(records[0].traceparent, undefined);
  assert.equal(diagnostics.agentLifecycle({ ...identity, project: "other" }, {
    startMs: 1, endMs: 2, attributes: { "openrind.agent.id": "claude", "openrind.lifecycle": "completed" },
  }), false);
  await diagnostics.shutdown();
});

test("record rejection stays visible even if the next record succeeds", async () => {
  let accepted = false;
  const diagnostics = createRuntimeDiagnostics({ env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: "https://fixture.test" },
    createProducer: () => ({ recordOperation: () => ({ accepted }), status: () => ({}), shutdown: async () => {} }) });
  assert.equal(diagnostics.filesystemHealth("owner", health), false);
  accepted = true;
  assert.equal(diagnostics.filesystemHealth("owner", health), true);
  assert.equal(diagnostics.status().rejected, 1);
  assert.equal(diagnostics.status().issue, "record_rejected");
  await diagnostics.shutdown();
});

test("sends real OTLP requests and reports receiver failure without throwing to the application", async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(401).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const diagnostics = createRuntimeDiagnostics({ env: {
    OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    OPENRIND_DIAGNOSTICS_OTLP_AUTHORIZATION: "Bearer fixture-only",
  } });
  t.after(() => diagnostics.shutdown());
  assert.equal(diagnostics.filesystemHealth("test", health), true);
  const state = await diagnostics.flush();
  assert.equal(state.capture.localStatus, "degraded");
  assert.equal(state.persistentAcceptance, "unverified");
  assert.equal(requests[0].headers.authorization, "Bearer fixture-only");
  assert.equal(requests[0].headers["content-type"], "application/x-protobuf");
  assert.equal(requests[0].body.includes(Buffer.from("fixture-only")), false);
  assert.equal(JSON.stringify(state).includes("fixture-only"), false);
});
