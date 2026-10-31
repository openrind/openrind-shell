import test from "node:test";
import assert from "node:assert/strict";

import {
  createEvidenceRecord,
  validateEvidenceRecord,
  createRunIdentity,
  ArtifactStore,
  buildOtlpSpan,
  buildOtlpTracesDocument,
  SPAN_KINDS,
  STATUS_CODES,
  CaptureProducer,
  buildTracePackFiles,
  projectToSellTraces,
  sources,
} from "../src/index.mjs";

test("createRunIdentity produces unified 32-hex trace_id and 16-hex root_span_id", () => {
  const identity = createRunIdentity({
    runId: "custom-run-123",
    taskId: "web-test",
    sessionId: "custom-session",
    nativeSessionId: "native-123",
  });

  assert.equal(identity.run_id, "custom-run-123");
  assert.equal(identity.trace_id.length, 32);
  assert.match(identity.trace_id, /^[0-9a-f]{32}$/);
  assert.equal(identity.root_span_id.length, 16);
  assert.match(identity.root_span_id, /^[0-9a-f]{16}$/);
  assert.equal(identity.session_id, "custom-session");
  assert.equal(identity.native_session_id, "native-123");
});

test("createEvidenceRecord creates conformant schema matching Section 13.3", () => {
  const identity = createRunIdentity({ runId: "test-run" });
  const record = createEvidenceRecord({
    runId: identity.run_id,
    traceId: identity.trace_id,
    spanId: identity.root_span_id,
    sessionId: identity.session_id,
    producerId: "agent",
    sequence: 1,
    kind: "tool_action",
    executor: "agent_browser",
    attribution: { method: "click", action_id: "e12" },
    payload: { name: "browser_click", status: "ok" },
  });

  assert.equal(record.schema, "openrind-evidence/v1");
  assert.equal(record.producer_id, "agent");
  assert.equal(record.executor, "agent_browser");
  assert.equal(record.sequence, 1);
  assert.equal(validateEvidenceRecord(record), true);
});

test("ArtifactStore computes deterministic SHA-256 and content-addressed storage", () => {
  const store = new ArtifactStore();
  const hash1 = store.record("test1.txt", "hello world", "text/plain");
  const hash2 = store.record("test2.txt", "hello world", "text/plain");

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.equal(store.get(hash1).size, 11);

  const zipFiles = store.toZipFiles("test/artifacts");
  assert.equal(zipFiles.length, 2); // manifest.json + 1 artifact
  assert.equal(zipFiles[0].path, "test/artifacts/manifest.json");
  assert.equal(zipFiles[1].path, `test/artifacts/${hash1}`);
});

test("OTLP builder generates lowerCamelCase standard JSON schema", () => {
  const span = buildOtlpSpan({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "test.step",
    kind: SPAN_KINDS.INTERNAL,
    startTimeMs: 1700000000000,
    endTimeMs: 1700000001000,
    attributes: [
      { key: "agent.name", val: "codex" },
      { key: "step.count", val: 5 },
      { key: "success", val: true },
    ],
    status: { code: STATUS_CODES.OK },
  });

  assert.equal(span.traceId, "a".repeat(32));
  assert.equal(span.spanId, "b".repeat(16));
  assert.equal(span.kind, 1);
  assert.equal(span.startTimeUnixNano, "1700000000000000000");
  assert.equal(span.endTimeUnixNano, "1700000001000000000");
  assert.equal(span.status.code, 1);
  assert.equal(span.attributes[0].value.stringValue, "codex");
  assert.equal(span.attributes[1].value.intValue, 5);
  assert.equal(span.attributes[2].value.boolValue, true);

  const doc = buildOtlpTracesDocument({ spans: [span] });
  assert.ok(Array.isArray(doc.resourceSpans));
  assert.equal(doc.resourceSpans[0].scopeSpans[0].spans[0].name, "test.step");
});

test("CaptureProducer manages sequence, outbox, and seals with verified receipt", () => {
  const identity = createRunIdentity({ runId: "producer-test" });
  const producer = new CaptureProducer({ identity });

  const r1 = producer.emit({ kind: "step_start", payload: { step: 1 } });
  const r2 = producer.emit({ kind: "step_end", payload: { step: 1, durationMs: 200 } });

  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
  assert.equal(producer.getRecords().length, 2);

  const sealed = producer.seal({ complete: true });
  assert.equal(sealed.receipt.schema, "openrind-receipt/v1");
  assert.equal(sealed.receipt.state, "sealed_complete");
  assert.equal(sealed.receipt.components.agent_execution.seal_verified, true);
  assert.equal(sealed.totalRecords, 2);
});

test("TracePack builder compiles canonical archive files", () => {
  const { files, manifest, receipt } = buildTracePackFiles({
    trajectory: {
      id: "tracepack-test-run",
      model: "openai/gpt-4o",
      steps: [
        { number: 1, thought: "think", tool: "browser", action: { action: "open" }, observation: "ok" },
      ],
      completedAt: new Date().toISOString(),
    },
  });

  assert.equal(manifest.schema_version, "1.0.0");
  assert.equal(manifest.capture.complete, true);
  assert.equal(receipt.state, "sealed_complete");
  assert.ok(files.some((f) => f.path === "tracepack/manifest.json"));
  assert.ok(files.some((f) => f.path === "tracepack/conversation.jsonl"));
  assert.ok(files.some((f) => f.path === "tracepack/events.jsonl"));
  assert.ok(files.some((f) => f.path === "tracepack/otlp/traces.json"));
  assert.ok(files.some((f) => f.path === "tracepack/receipts/run.json"));
});

test("SellTraces projector redacts PII and produces companion report", () => {
  const { sellTracesJson, projectionReport } = projectToSellTraces({
    trajectory: {
      id: "selltraces-test-run",
      model: "claude-sonnet-4-6",
      steps: [
        {
          number: 1,
          thought: "Using sk-ant-api03-abcdefghijklmnopqrstuvwxyz and test@example.com",
          action: "open",
          observation: "secret password=\"supersecret123\"",
        },
      ],
      completedAt: new Date().toISOString(),
    },
    scrubPii: true,
  });

  assert.equal(sellTracesJson.schema_version, "1.0.0");
  const assistantMsg = sellTracesJson.traces[0].messages.find((m) => m.role === "assistant");
  assert.ok(assistantMsg.content.includes("[REDACTED_ANTHROPIC_KEY]"));
  assert.ok(assistantMsg.content.includes("[REDACTED_EMAIL]"));
  assert.equal(projectionReport.pii_redacted, true);
  assert.ok(projectionReport.pii_findings.length > 0);
});

test("Native history sources parse Claude Code and Codex transcripts", () => {
  const sampleClaude = JSON.stringify({
    type: "human",
    message: { content: "hello world" },
    timestamp: "2026-10-28T12:00:00Z",
    sessionId: "claude-session-1",
  });
  const claudeTurns = sources.parseClaudeCodeJsonl(sampleClaude);
  assert.equal(claudeTurns.length, 1);
  assert.equal(claudeTurns[0].role, "user");
  assert.equal(claudeTurns[0].content, "hello world");

  const sampleCodex = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: "I am ready",
    },
    timestamp: "2026-10-28T12:00:00Z",
  });
  const codexTurns = sources.parseCodexRolloutJsonl(sampleCodex);
  assert.equal(codexTurns.length, 1);
  assert.equal(codexTurns[0].role, "assistant");
  assert.equal(codexTurns[0].content, "I am ready");
});
