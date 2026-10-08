import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCapture, CAPTURE_LIMITS } from "../src/index.mjs";
import { captureAttributes, captureContext, captureEndpoint, captureHeaders } from "../src/contracts.mjs";
import { ExportQueue } from "../src/exporter.mjs";

const parent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
const clients = new WeakMap();

async function fixture(t, respond = (_request, res) => res.end()) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const request = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts) };
    requests.push(request);
    res.setHeader("Content-Type", "application/x-protobuf");
    await respond(request, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const capture of clients.get(t) ?? []) await capture.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}` };
}

function producer(t, endpoint, options = {}) {
  const capture = createCapture({ endpoint, serviceName: "capture-test", serviceVersion: "1",
    proxyUrl: "", timeoutMillis: 1000, traceparent: parent, ...options });
  if (!clients.has(t)) clients.set(t, []);
  clients.get(t).push(capture);
  return capture;
}

test("validates origins, headers, metadata and W3C context without echoing secrets", () => {
  assert.equal(captureEndpoint("https://example.test"), "https://example.test");
  for (const value of ["file:///tmp/test", "https://name:private@example.test", "https://example.test/v1/logs",
    "https://example.test?token=private", "https://example.test#private"]) {
    assert.throws(() => captureEndpoint(value), /OTLP endpoint/);
  }
  assert.throws(() => captureHeaders({ "x-api-key": "private\nvalue" }), /credential header/);
  assert.throws(() => captureHeaders({ "x-w8-haloop-project": "other-project" }), /credential header/);
  assert.throws(() => captureHeaders({ "content-type": "application/json" }), /credential header/);
  assert.throws(() => captureHeaders({ "x-api-key": "a", "X-Api-Key": "b" }), /credential header/);
  assert.throws(() => captureAttributes({ "openrind.evidence.sequence": 42 }), /Reserved/);
  assert.throws(() => captureAttributes({ Authorization: "private" }), /sensitive/);
  assert.deepEqual(captureAttributes({ "gen_ai.usage.input_tokens": 17 }), { "gen_ai.usage.input_tokens": 17 });
  assert.throws(() => captureAttributes({ value: Infinity }), /finite/);
  assert.throws(() => captureAttributes({ value: "a".repeat(CAPTURE_LIMITS.metadataBytes) }), /metadata/);
  assert.throws(() => captureContext("00-00000000000000000000000000000000-1234567890abcdef-01"), /traceparent/);
  assert.throws(() => captureContext(`${parent}-bad`), /traceparent/);
  assert.ok(captureContext(parent));
});

test("exports all signals with protobuf and never claims persistence", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint, { headers: { "x-api-key": "test-placeholder" } });
  const observed = capture.recordPayload({ data: Buffer.from([0, 255, 127]), type: "application.result" });
  const operation = capture.recordOperation({ name: "document.read", startMs: Date.now(), status: "ok" });
  assert.equal(observed.accepted, true);
  assert.equal(operation.traceId, parent.split("-")[1]);
  assert.match(operation.spanId, /^[a-f0-9]{16}$/);
  const state = await capture.flush();
  assert.deepEqual(state.accepted, { logs: 2, traces: 1, metrics: 1 });
  assert.equal(state.localStatus, "pending");
  assert.equal(state.persistentAcceptance, "unverified");
  assert.deepEqual(new Set(server.requests.map((req) => req.path)), new Set(["/v1/logs", "/v1/traces", "/v1/metrics"]));
  for (const req of server.requests) {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/x-protobuf");
    assert.equal(req.headers["x-api-key"], "test-placeholder");
    assert.ok(req.body.length > 0);
    assert.ok(req.body.length < CAPTURE_LIMITS.requestBytes);
    assert.equal(req.body.includes(Buffer.from("test-placeholder")), false);
  }
  assert.equal(JSON.stringify(state).includes("test-placeholder"), false);
});

test("chunks 17 MiB as bytes and emits a hash manifest", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint);
  const data = Buffer.alloc(17 * 1024 * 1024, 171);
  const receipt = capture.recordPayload({ data });
  assert.equal(receipt.partCount, 5);
  assert.equal(receipt.sha256, createHash("sha256").update(data).digest("hex"));
  data.fill(0); // Exported bytes must no longer depend on caller-owned buffers.
  await capture.flush();
  const logs = server.requests.filter((req) => req.path === "/v1/logs");
  assert.equal(logs.length, 6);
  assert.ok(logs[0].body.includes(Buffer.alloc(1024, 171)));
  assert.ok(logs.every((req) => req.body.length <= CAPTURE_LIMITS.requestBytes));
  assert.ok(logs.at(-1).body.includes(Buffer.from(receipt.sha256)));
});

test("preserves application content without applying a training-data filter", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint);
  const data = '{"type":"thinking","thinking":"returned text","signature":"opaque"}';
  capture.recordPayload({ data, mediaType: "application/json" });
  await capture.flush();
  assert.ok(server.requests.some((req) => req.body.includes(Buffer.from(data))));
});

test("records HTTP 200 partial rejection without retrying the batch", async (t) => {
  // ExportLogsServiceResponse.partial_success.rejected_log_records = 1.
  const partial = Buffer.from([0x0a, 0x02, 0x08, 0x01]);
  const server = await fixture(t, (req, res) => res.end(req.path === "/v1/logs" ? partial : undefined));
  const capture = producer(t, server.endpoint);
  capture.recordPayload({ data: "sample" });
  const state = await capture.flush();
  assert.equal(state.partial.logs, 2);
  assert.equal(state.accepted.logs, 0);
  assert.equal(state.localStatus, "degraded");
  assert.equal(server.requests.filter((req) => req.path === "/v1/logs").length, 2);
});

test("rejects malformed success responses instead of treating them as acceptance", async (t) => {
  const server = await fixture(t, (_req, res) => res.end(Buffer.from([0x0a, 0xff])));
  const capture = producer(t, server.endpoint);
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.failed.traces, 1);
  assert.equal(state.lastIssue, "invalid_response");
});

test("an interrupted HTTP 200 response remains uncertain", async (t) => {
  const server = await fixture(t, async (req, res) => {
    if (req.path !== "/v1/traces") return res.end();
    res.writeHead(200, { "content-length": "100" });
    res.write(Buffer.from([0x0a]));
    await delay(15);
    res.destroy();
  });
  const capture = producer(t, server.endpoint);
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.failed.traces, 1);
  assert.equal(state.localStatus, "degraded");
});

test("permanent HTTP errors are visible and are not retried", async (t) => {
  const server = await fixture(t, (_req, res) => { res.statusCode = 403; res.end("private-detail"); });
  const capture = producer(t, server.endpoint);
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.failed.traces, 1);
  assert.equal(server.requests.filter((req) => req.path === "/v1/traces").length, 1);
  assert.equal(JSON.stringify(state).includes("private-detail"), false);
});

test("retryable HTTP errors reuse the same encoded request", async (t) => {
  let calls = 0;
  const server = await fixture(t, (req, res) => {
    if (req.path === "/v1/traces" && calls++ === 0) {
      res.statusCode = 503; res.setHeader("retry-after", "1");
    }
    res.end();
  });
  const capture = producer(t, server.endpoint, { timeoutMillis: 3000 });
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  const requests = server.requests.filter((req) => req.path === "/v1/traces");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(state.accepted.traces, 1);
});

test("a stalled request is reported without a false successful flush", async (t) => {
  const server = await fixture(t, (req, res) => { if (req.path !== "/v1/traces") res.end(); });
  const capture = producer(t, server.endpoint, { timeoutMillis: 50 });
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.failed.traces, 1);
  assert.equal(state.persistentAcceptance, "unverified");
});

test("queue and session limits reject whole payload groups", async (t) => {
  const server = await fixture(t);
  const limited = producer(t, server.endpoint, { maxQueueRecords: 1 });
  assert.equal(limited.recordPayload({ data: "sample" }).accepted, false);
  assert.equal(limited.status().lastIssue, "queue_limit");
  const budget = producer(t, server.endpoint, { maxSessionBytes: 1 });
  assert.equal(budget.recordPayload({ data: "sample" }).accepted, false);
  assert.equal(budget.status().lastIssue, "session_limit");
  await limited.flush(); await budget.flush();
  assert.equal(server.requests.some((req) => req.path === "/v1/logs"), false);
});

test("oversized payloads are rejected, not truncated", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint);
  const result = capture.recordPayload({ data: Buffer.alloc(CAPTURE_LIMITS.payloadBytes + 1) });
  assert.deepEqual(result, { accepted: false, reason: "payload_limit" });
  await capture.flush();
  assert.equal(server.requests.some((req) => req.path === "/v1/logs"), false);
});

test("refreshes credentials for later exports without putting them in payloads", async (t) => {
  let token = "test-first";
  const server = await fixture(t);
  const capture = producer(t, server.endpoint, { headers: async () => ({ "x-api-key": token }) });
  capture.recordOperation({ name: "one", startMs: Date.now() });
  await capture.flush();
  token = "test-second";
  capture.recordOperation({ name: "two", startMs: Date.now() });
  await capture.flush();
  const requests = server.requests.filter((req) => req.path === "/v1/traces");
  assert.deepEqual(requests.map((req) => req.headers["x-api-key"]), ["test-first", "test-second"]);
});

test("uses an explicit HTTP proxy without a direct-dial fallback", async (t) => {
  const proxy = await fixture(t);
  const capture = producer(t, "http://capture.invalid", { proxyUrl: proxy.endpoint });
  capture.recordOperation({ name: "proxied", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.accepted.traces, 1);
  assert.ok(proxy.requests.every((req) => req.path.startsWith("http://capture.invalid/v1/")));
});

test("a failed credential refresh sends no request and does not expose its error", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint, { headers: async () => { throw new Error("private-refresh-detail"); } });
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(server.requests.length, 0);
  assert.equal(state.failed.traces, 1);
  assert.equal(JSON.stringify(state).includes("private-refresh-detail"), false);
});

test("a stalled credential source has a bounded wait", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint, { timeoutMillis: 25, headers: () => new Promise(() => {}) });
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(server.requests.length, 0);
  assert.equal(state.failed.traces, 1);
});

test("metric failures do not change evidence health", async (t) => {
  const server = await fixture(t, (req, res) => {
    if (req.path === "/v1/metrics") res.statusCode = 400;
    res.end();
  });
  const capture = producer(t, server.endpoint);
  capture.recordOperation({ name: "sample", startMs: Date.now() });
  const state = await capture.flush();
  assert.equal(state.failed.metrics, 1);
  assert.equal(state.localStatus, "pending");
});

test("shutdown is idempotent and refuses new records", async (t) => {
  const server = await fixture(t);
  const capture = producer(t, server.endpoint);
  capture.recordPayload({ data: "" });
  const first = capture.shutdown();
  assert.strictEqual(capture.shutdown(), first);
  assert.throws(() => capture.recordPayload({ data: "late" }), /closed/);
  assert.equal((await first).closed, true);
});

test("queue accounts for in-flight bytes and drains in order", async () => {
  const sent = [];
  const rejected = [];
  let release;
  const queue = new ExportQueue({
    encode: (data) => Buffer.from(data),
    async send(packet) { sent.push(packet.items); await new Promise((r) => { release = r; }); },
    async shutdown() {},
  }, { maxBytes: 4, maxRecords: 2, onRejected: (reason) => rejected.push(reason) });
  assert.equal(queue.enqueueMany(["ab"]), true);
  await delay(0);
  assert.equal(queue.enqueueMany(["cde"]), false);
  assert.equal(queue.size.bytes, 2);
  release();
  await queue.flush();
  assert.deepEqual(sent, ["ab"]);
  assert.deepEqual(rejected, ["queue_limit"]);
  assert.equal(queue.size.bytes, 0);
  await queue.shutdown();
});
