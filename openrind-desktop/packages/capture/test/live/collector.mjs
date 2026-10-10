import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCapture, CAPTURE_LIMITS } from "../../src/index.mjs";
import { createRuntimeDiagnostics } from "../../src/diagnostics.mjs";

const image = "otel/opentelemetry-collector-contrib:0.145.0@sha256:a7343f01869071ea3f4c5e1e97df1bb1b3c4d5c77247db80e053a80b9df530c4";
const name = `openrind-capture-test-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), "openrind-capture-test-"));
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
}).trim();
let created = false;
let capture;
let diagnostics;

function attributes(record) {
  return Object.fromEntries((record.attributes ?? []).map(({ key, value }) => [key,
    value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue]));
}

function records(signal, scopeKey, recordKey) {
  const text = readFileSync(join(directory, `${signal}.json`), "utf8");
  return text.trim().split("\n").filter(Boolean).flatMap((line) => {
    const data = JSON.parse(line);
    const resourceKey = signal === "traces" ? "resourceSpans"
      : `resource${signal[0].toUpperCase()}${signal.slice(1)}`;
    return (data[resourceKey] ?? []).flatMap((resource) =>
      (resource[scopeKey] ?? []).flatMap((scope) => scope[recordKey] ?? []));
  });
}

try {
  assert.equal(docker("info", "--format", "{{.OSType}}"), "linux", "This fixture needs a Linux Docker daemon");
  writeFileSync(join(directory, "config.yaml"), `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        max_request_body_size: 8388608
exporters:
  file/logs:
    path: /data/logs.json
    flush_interval: 100ms
  file/traces:
    path: /data/traces.json
    flush_interval: 100ms
  file/metrics:
    path: /data/metrics.json
    flush_interval: 100ms
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file/logs]
    traces:
      receivers: [otlp]
      exporters: [file/traces]
    metrics:
      receivers: [otlp]
      exporters: [file/metrics]
`);
  docker("run", "-d", "--name", name, "--user", `${process.getuid()}:${process.getgid()}`,
    "-p", "127.0.0.1::4318", "--mount", `type=bind,src=${directory},dst=/data`,
    image, "--config=/data/config.yaml");
  created = true;
  const port = docker("port", name, "4318/tcp").split(":").at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 75; attempt++) {
    try {
      const response = await fetch(`${endpoint}/v1/traces`, { method: "POST",
        headers: { "content-type": "application/x-protobuf" }, body: Buffer.alloc(0),
        signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status === 200) { ready = true; break; }
    } catch { /* The collector may still be starting. */ }
    await delay(200);
  }
  assert.ok(ready, "Collector did not become ready");
  const traceId = "1234567890abcdef1234567890abcdef";
  const parentSpanId = "1234567890abcdef";
  capture = createCapture({ endpoint, serviceName: "openrind-capture-fixture", serviceVersion: "1",
    proxyUrl: "", traceparent: `00-${traceId}-${parentSpanId}-01`, instanceId: "fixture", streamId: "one" });
  const bytes = Buffer.alloc(17 * 1024 * 1024, 171);
  const receipt = capture.recordPayload({ data: bytes, type: "application.fixture" });
  const operation = capture.recordOperation({ name: "fixture.read", startMs: Date.now(), status: "ok" });
  const state = await capture.shutdown();
  assert.equal(receipt.accepted, true);
  assert.equal(operation.accepted, true);
  assert.equal(state.localStatus, "pending");
  assert.equal(state.persistentAcceptance, "unverified");
  assert.deepEqual(state.accepted, { logs: 6, traces: 1, metrics: 1 });
  diagnostics = createRuntimeDiagnostics({ env: { OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT: endpoint } });
  assert.equal(diagnostics.filesystemHealth("collector-fixture", {
    state: "writable", dirtyBytes: 4096, lastWritebackError: null,
    diagnostics: { version: 1, instanceId: "12345678-1234-1234-1234-123456789abc",
      requestsStarted: 3, requestsCompleted: 3, requestErrors: 0, requestDurationMicros: 200 },
  }), true);
  assert.equal(diagnostics.agentLifecycle({ traceId, rootSpanId: parentSpanId }, {
    startMs: Date.now(), endMs: Date.now(), attributes: {
      "openrind.agent.id": "claude", "openrind.lifecycle": "completed",
    },
  }), true);
  const diagnosticStatus = await diagnostics.shutdown();
  assert.equal(diagnosticStatus.capture.accepted.traces, 2);
  docker("stop", "--time", "10", name);

  const logs = records("logs", "scopeLogs", "logRecords");
  assert.equal(logs.length, 6);
  const chunks = logs.filter((record) => attributes(record)["openrind.evidence.type"] === "application.fixture")
    .sort((a, b) => Number(attributes(a)["openrind.payload.part_index"]) - Number(attributes(b)["openrind.payload.part_index"]));
  assert.equal(chunks.length, 5);
  const decoded = chunks.map((record) => {
    const part = Buffer.from(record.body.bytesValue, "base64");
    assert.ok(part.length <= CAPTURE_LIMITS.chunkBytes);
    assert.equal(attributes(record)["openrind.payload.part_sha256"], createHash("sha256").update(part).digest("hex"));
    assert.equal(record.traceId, traceId);
    assert.equal(record.spanId, parentSpanId);
    return part;
  });
  assert.deepEqual(Buffer.concat(decoded), bytes);
  assert.deepEqual(logs.map((log) => Number(attributes(log)["openrind.evidence.sequence"])), [1, 2, 3, 4, 5, 6]);
  const manifest = Object.fromEntries(logs.at(-1).body.kvlistValue.values.map(({ key, value }) =>
    [key, value.stringValue ?? value.intValue ?? value.doubleValue]));
  assert.equal(manifest.sha256, receipt.sha256);
  assert.equal(Number(manifest.bytes), bytes.length);
  assert.equal(Number(manifest.partCount), 5);
  const spans = records("traces", "scopeSpans", "spans");
  assert.equal(spans.length, 3);
  assert.equal(spans[0].traceId, traceId);
  assert.equal(spans[0].parentSpanId, parentSpanId);
  assert.equal(spans[0].spanId, operation.spanId);
  const filesystem = spans.find(span => span.name === "filesystem.health");
  assert.equal(Number(attributes(filesystem)["filesystem.requestsCompleted"]), 3);
  assert.equal(attributes(filesystem)["diagnostic.source"], "same_uid_fuse_health");
  const lifecycle = spans.find(span => span.name === "agent.session");
  assert.equal(lifecycle.traceId, traceId);
  assert.equal(lifecycle.parentSpanId, parentSpanId);
  const metrics = records("metrics", "scopeMetrics", "metrics");
  assert.ok(metrics.some((metric) => metric.name === "openrind.capture.records"));
  console.log(JSON.stringify({ result: "passed", image, logs: logs.length, spans: spans.length,
    payloadBytes: bytes.length, signals: ["logs", "traces", "metrics"],
    limits: "Collector and diagnostic projection only; synthetic health input, no live mount or Haloop durability claim" }, null, 2));
} catch (error) {
  if (created) console.error(docker("logs", "--tail", "30", name));
  throw error;
} finally {
  try {
    if (capture) await capture.shutdown();
    if (diagnostics) await diagnostics.shutdown();
  } finally {
    if (created) docker("rm", "-f", name);
    rmSync(directory, { recursive: true, force: true });
  }
}
