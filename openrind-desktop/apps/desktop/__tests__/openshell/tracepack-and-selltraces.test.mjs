import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildTracePackFiles,
  createTracePackZip,
} from "../../electron/openshell/tracepack-builder.mjs";
import {
  projectToSellTraces,
  scanPii,
  scrubPiiText,
} from "../../electron/openshell/selltraces-projector.mjs";

const SAMPLE_TRAJECTORY = {
  format: "openrind-ctf-trajectory/v1",
  task: {
    id: "flag-command",
    title: "Flag Command",
    description: "Inspect network traffic to find the secret command.",
    sitePath: "/",
  },
  model: "openai/gpt-4o",
  startedAt: "2026-10-22T10:00:00.000Z",
  solved: true,
  judge: {
    accepted: true,
    submittedAt: "2026-10-22T10:02:00.000Z",
    submission: "FLAG{test_flag_123}",
  },
  steps: [
    {
      number: 1,
      thought: "I need to inspect the page DOM for clues.",
      tool: "browser",
      action: { action: "snapshot", selector: "", value: "" },
      observation: "<h1>Welcome</h1><p>Enter command...</p>",
      durationMs: 1200,
    },
    {
      number: 2,
      thought: "Found the flag in network monitor. Submitting now.",
      tool: "submit",
      action: { flag: "FLAG{test_flag_123}" },
      observation: '{"correct":true}',
      durationMs: 800,
    },
  ],
};

test("TracePack builder creates canonical lossless archive structure", () => {
  const { files, manifest } = buildTracePackFiles({
    trajectory: SAMPLE_TRAJECTORY,
  });

  assert.equal(manifest.schema_version, "1.0.0");
  assert.equal(manifest.parser_version, "1.0.0");
  assert.equal(manifest.client.name, "Openrind Desktop");
  assert.equal(manifest.task.id, "flag-command");
  assert.equal(manifest.capture.sealed, true);
  assert.equal(manifest.capture.complete, true);

  const filePaths = files.map((f) => f.path);
  assert.ok(filePaths.includes("tracepack/manifest.json"));
  assert.ok(filePaths.includes("tracepack/conversation.jsonl"));
  assert.ok(filePaths.includes("tracepack/events.jsonl"));
  assert.ok(filePaths.includes("tracepack/otlp/traces.json"));
  assert.ok(filePaths.includes("tracepack/otlp/logs.json"));
  assert.ok(filePaths.includes("tracepack/artifacts/manifest.json"));
  assert.ok(filePaths.includes("tracepack/provenance/environment.json"));
  assert.ok(filePaths.includes("tracepack/receipts/run.json"));

  // Verify conversation.jsonl format
  const convFile = files.find((f) => f.path === "tracepack/conversation.jsonl");
  const turns = convFile.content.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(turns.length >= 4); // system, user, assistant, observation, assistant, observation
  assert.equal(turns[0].role, "system");
  assert.equal(turns[1].role, "user");
  assert.equal(turns[2].role, "assistant");
  assert.equal(turns[3].role, "user");

  // Verify events.jsonl contains independent judge verdict event
  const eventsFile = files.find((f) => f.path === "tracepack/events.jsonl");
  const events = eventsFile.content.trim().split("\n").map((line) => JSON.parse(line));
  const judgeEvent = events.find((e) => e.producer === "challenge-judge");
  assert.ok(judgeEvent);
  assert.equal(judgeEvent.provenance.origin, "challenge-server.mjs");
  assert.equal(judgeEvent.provenance.independent_verdict, true);

  // Verify OTLP trace export (standard lowerCamelCase OTLP JSON schema)
  const otlpFile = files.find((f) => f.path === "tracepack/otlp/traces.json");
  const otlp = JSON.parse(otlpFile.content);
  assert.ok(Array.isArray(otlp.resourceSpans));
  assert.equal(otlp.resourceSpans[0].resource.attributes[0].value.stringValue, "openrind-desktop");
  assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans[0].kind, 2);
  assert.equal(typeof otlp.resourceSpans[0].scopeSpans[0].spans[0].traceId, "string");
  assert.equal(typeof otlp.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano, "string");
});

test("createTracePackZip creates a valid ZIP buffer with PK signature", () => {
  const { buffer, manifest } = createTracePackZip({
    trajectory: SAMPLE_TRAJECTORY,
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 500);
  // Standard ZIP file signature: 0x50 0x4B 0x03 0x04 ('PK\x03\x04')
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);
  assert.equal(manifest.task.id, "flag-command");
});

test("SellTraces projector maintains invariant: no synthesized tool_calls", () => {
  const { sellTracesJson, projectionReport } = projectToSellTraces({
    trajectory: SAMPLE_TRAJECTORY,
    scrubPii: true,
  });

  assert.equal(sellTracesJson.source, "local_trace_index");
  assert.ok(sellTracesJson.sourceId.startsWith("flag-command:"));
  assert.equal(sellTracesJson.model, "openai/gpt-4o");
  assert.ok(sellTracesJson.originalHash);
  assert.ok(sellTracesJson.environment);
  assert.ok(Array.isArray(sellTracesJson.toolsAvailable));
  assert.ok(Array.isArray(sellTracesJson.messages));
  assert.ok(sellTracesJson.messages[0].tokenCount > 0);

  // Assistant messages must NOT be converted to fake provider tool_call blocks
  const assistantMsgs = sellTracesJson.messages.filter((m) => m.role === "assistant");
  assert.ok(assistantMsgs.length >= 2);
  for (const msg of assistantMsgs) {
    assert.equal(typeof msg.content, "string");
    // Content is JSON string
    const parsed = JSON.parse(msg.content);
    assert.ok(parsed.tool);
    assert.ok(parsed.thought);
    // Crucial check: tool_calls property must not be invented on the message
    assert.equal(msg.tool_calls, undefined);
  }

  // Projection report checks
  assert.equal(projectionReport.schema_version, "1.0.0");
  assert.equal(projectionReport.capture_complete, true);
  assert.ok(Array.isArray(projectionReport.omitted_events));
  const browserOmission = projectionReport.omitted_events.find((e) => e.type === "browser_low_level_actions");
  assert.ok(browserOmission);
  assert.ok(browserOmission.count >= 1);
  assert.ok(projectionReport.flattened_structures.some((s) => s.includes("verbatim inside assistant text")));
});

test("PII scanning and scrubbing detects and masks credentials, passwords and emails", () => {
  const sensitiveText = 'My key is sk-ant-api03-abcdef1234567890abcdef123456, email is dev@openrind.com, and "password": "super_secret_password_123"';
  const findings = scanPii(sensitiveText);
  assert.ok(findings.some((f) => f.name === "Anthropic API Key"));
  assert.ok(findings.some((f) => f.name === "Email Address"));
  assert.ok(findings.some((f) => f.name === "Generic Secret/Password"));

  const scrubbed = scrubPiiText(sensitiveText);
  assert.ok(!scrubbed.includes("sk-ant-"));
  assert.ok(!scrubbed.includes("dev@openrind.com"));
  assert.ok(!scrubbed.includes("super_secret_password_123"));
  assert.ok(scrubbed.includes("[REDACTED_ANTHROPIC_KEY]"));
  assert.ok(scrubbed.includes("[REDACTED_EMAIL]"));
  assert.ok(scrubbed.includes("[REDACTED_SECRET]"));
});

test("Observed model requests in agentEvents preserve real prompt canaries and align session ID", () => {
  const canarySystem = "CANARY_SYSTEM_PROMPT_REAL_TEST";
  const canaryUser = "CANARY_USER_PROMPT_REAL_TEST";
  const agentEvents = [
    {
      kind: "model_call",
      at: "2026-10-22T10:00:00.000Z",
      request: {
        messages: [
          { role: "system", content: canarySystem },
          { role: "user", content: canaryUser },
        ],
      },
      response: {
        choices: [{ message: { content: '{"thought":"ok","tool":"browser"}' } }],
      },
    },
  ];

  const trajectoryWithRun = {
    ...SAMPLE_TRAJECTORY,
    runId: "1234567890abcdef1234567890abcdef",
  };

  const { files, manifest } = buildTracePackFiles({
    trajectory: trajectoryWithRun,
    agentEvents,
  });

  const { sellTracesJson } = projectToSellTraces({
    trajectory: trajectoryWithRun,
    agentEvents,
  });

  // 1. Session ID parity check between TracePack and SellTraces
  assert.equal(manifest.session_id, sellTracesJson.sessionId);
  assert.equal(manifest.session_id, "flag-command:1234567890ab");

  // 2. Canary preservation in conversation.jsonl
  const convFile = files.find((f) => f.path === "tracepack/conversation.jsonl");
  const turns = convFile.content.trim().split("\n").map(JSON.parse);
  assert.equal(turns[0].content, canarySystem);
  assert.equal(turns[1].content, canaryUser);
  assert.ok(manifest.profiles.includes("model-context/v1"));

  // 3. Canary preservation in SellTraces messages
  assert.equal(sellTracesJson.messages[0].content, canarySystem);
  assert.equal(sellTracesJson.messages[1].content, canaryUser);

  // 4. Source records preserved
  assert.ok(files.some((f) => f.path === "tracepack/source-records/trajectory.json"));
  assert.ok(files.some((f) => f.path === "tracepack/source-records/agent-events.jsonl"));
});

test("Real trace fixture (flag-command-trajectory.json) processes cleanly", async () => {
  const fixturePath = join(
    import.meta.dirname,
    "../../../../../ctf-traces/flag-command-trajectory.json",
  );
  if (!existsSync(fixturePath)) return;

  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const { files, manifest } = buildTracePackFiles({ trajectory: raw });
  assert.ok(files.length >= 6);
  assert.equal(manifest.task.id, "flag-command");

  const { sellTracesJson, projectionReport } = projectToSellTraces({ trajectory: raw });
  assert.ok(sellTracesJson.sourceId.startsWith("flag-command:"));
  assert.ok(sellTracesJson.messages.length > 5);
  assert.equal(projectionReport.capture_complete, true);
});
