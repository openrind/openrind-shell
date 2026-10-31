// Canonical Lossless Openrind TracePack Packager.
//
// Retains raw execution evidence, conversation messages, OTLP-compliant spans,
// and content-addressed binary artifacts in a structured archive:
//
// tracepack/
//   manifest.json
//   conversation.jsonl
//   events.jsonl
//   otlp/
//     traces.json
//     logs.json
//   artifacts/
//     manifest.json
//     <sha256>
//   source-records/

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createZipBuffer } from "./harbor-exporter.mjs";

const TRACEPACK_SCHEMA_VERSION = "1.0.0";
const PARSER_VERSION = "1.0.0";

function sha256Hex(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

function stableTraceId(input) {
  if (typeof input === "string" && /^[0-9a-f]{32}$/i.test(input)) {
    return input.toLowerCase();
  }
  return createHash("sha256").update(String(input || randomBytes(16).toString("hex"))).digest("hex").slice(0, 32);
}

function stableSpanId(input) {
  if (typeof input === "string" && /^[0-9a-f]{16}$/i.test(input)) {
    return input.toLowerCase();
  }
  return createHash("sha256").update(String(input || randomBytes(8).toString("hex"))).digest("hex").slice(0, 16);
}

/**
 * Builds a canonical TracePack file list from trajectory, agent events, and challenge events.
 *
 * @param {object} [options={}]
 * @param {object} [options.trajectory={}] - The raw openrind-ctf-trajectory/v1 object.
 * @param {Array<object>} [options.agentEvents=[]] - Raw agent events (browser_setup, model_call, agent_step, etc.).
 * @param {Array<object>} [options.challengeEvents=[]] - Raw challenge server events (site proxy, judge, etc.).
 * @param {Array<object>} [options.haloopSpans=[]] - Optional Haloop model spans.
 * @returns {{ files: Array<{ path: string, content: string | Buffer }>, manifest: object }}
 */
export function buildTracePackFiles({
  trajectory = {},
  agentEvents = [],
  challengeEvents = [],
  haloopSpans = [],
} = {}) {
  const task = trajectory.task || {};
  const taskId = task.id || "challenge";
  const startedAt = trajectory.startedAt || new Date().toISOString();
  const runId = trajectory.runId || trajectory.id || `${taskId}-${startedAt}`;
  const traceId = stableTraceId(runId);
  const rootSpanId = stableSpanId(`root-${traceId}`);
  const sessionId = trajectory.sessionId || `${taskId}:${traceId.slice(0, 12)}`;

  const files = [];
  const artifactsMap = {};
  const conversationLines = [];
  const eventLines = [];
  const otlpSpans = [];

  let sequenceNumber = 1;

  // 1. Artifact Helper
  function recordArtifact(name, content, mediaType = "text/plain") {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const hash = sha256Hex(buf);
    if (!artifactsMap[hash]) {
      artifactsMap[hash] = {
        hash,
        size: buf.length,
        mediaType,
        originalName: name,
      };
      files.push({
        path: `tracepack/artifacts/${hash}`,
        content: buf,
      });
    }
    return hash;
  }

  // 2. Build Events & Conversation from Source Records / Steps
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];

  // Check if actual observed model requests are present in agentEvents
  const modelCalls = (Array.isArray(agentEvents) ? agentEvents : [])
    .filter(e => (e.kind === "model_call" || e.kind === "model_request") && (e.request?.messages || e.messages));
  const firstModelCall = modelCalls[0];
  const observedReqMessages = firstModelCall?.request?.messages || firstModelCall?.messages;

  let hasObservedModelContext = false;

  if (Array.isArray(observedReqMessages) && observedReqMessages.length > 0) {
    hasObservedModelContext = true;
    for (const msg of observedReqMessages) {
      if (msg.role === "system") {
        conversationLines.push(JSON.stringify({
          role: "system",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          timestamp: firstModelCall.at || startedAt,
          sequence: sequenceNumber++,
          provenance: "observed_model_request",
        }));
      } else if (msg.role === "user" && conversationLines.length <= 1) {
        conversationLines.push(JSON.stringify({
          role: "user",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          timestamp: firstModelCall.at || startedAt,
          sequence: sequenceNumber++,
          provenance: "observed_model_request",
        }));
      }
    }
  }

  // Fallback if no observed model request message turn was found
  if (conversationLines.length === 0) {
    conversationLines.push(JSON.stringify({
      role: "system",
      content: `You are an Openrind CTF browser agent. Target: ${task.title || taskId}. ${task.description || ""}`,
      timestamp: startedAt,
      sequence: sequenceNumber++,
      derived: true,
      provenance: "derived_from_task",
    }));

    conversationLines.push(JSON.stringify({
      role: "user",
      content: `Solve the challenge: ${task.title || taskId}.`,
      timestamp: startedAt,
      sequence: sequenceNumber++,
      derived: true,
      provenance: "derived_from_task",
    }));
  }

  // Process Agent Events if available; otherwise derive from trajectory steps
  if (Array.isArray(agentEvents) && agentEvents.length > 0) {
    for (const rawEvt of agentEvents) {
      const evtId = `evt-${sequenceNumber}`;
      const evtTime = rawEvt.at || startedAt;
      const producer = "agent";
      const origin = rawEvt.origin || "agent";
      const observer = rawEvt.observer || (rawEvt.kind?.startsWith("browser") ? "browser" : "agent");
      const relayedBy = rawEvt.kind?.startsWith("model") ? "inference-gateway" : null;

      let artifactRef = null;
      if (rawEvt.observation && String(rawEvt.observation).length > 2048) {
        artifactRef = recordArtifact(`observation-${sequenceNumber}.txt`, rawEvt.observation, "text/plain");
      }

      eventLines.push(JSON.stringify({
        id: evtId,
        sequence: sequenceNumber++,
        timestamp: evtTime,
        trace_id: traceId,
        parent_id: rootSpanId,
        producer,
        origin,
        observer,
        ...(relayedBy ? { relayed_by: relayedBy } : {}),
        kind: rawEvt.kind,
        details: {
          ...rawEvt,
          ...(artifactRef ? { observation_artifact: artifactRef } : {}),
        },
      }));
    }
  }

  // Populate conversation turns from trajectory steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepTime = step.at || startedAt;
    const stepSpanId = stableSpanId(`step-${i + 1}-${traceId}`);

    // Assistant response (Raw JSON text conforming to CTF schema)
    const assistantPayload = {
      thought: step.thought || "",
      tool: step.tool || "browser",
      action: step.action?.action || "none",
      selector: step.action?.selector || "",
      value: step.action?.value || "",
      flag: step.action?.flag || "",
    };
    const assistantText = JSON.stringify(assistantPayload);

    conversationLines.push(JSON.stringify({
      role: "assistant",
      content: assistantText,
      timestamp: stepTime,
      step: step.number || i + 1,
      durationMs: step.durationMs,
      sequence: sequenceNumber++,
    }));

    // User / Environment observation turn
    const obsText = String(step.observation ?? "");
    let obsArtifact = null;
    if (obsText.length > 2048) {
      obsArtifact = recordArtifact(`step-${i + 1}-obs.txt`, obsText, "text/plain");
    }

    // Preserve rawObservation separately if present and different from model-visible observation
    const rawObs = String(step.rawObservation ?? "");
    let rawObsArtifact = null;
    if (rawObs && rawObs !== obsText && rawObs.length > 2048) {
      rawObsArtifact = recordArtifact(`step-${i + 1}-raw-obs.txt`, rawObs, "text/plain");
    }

    // Check for screenshot binary files on disk to preserve them in the archive
    let screenshotArtifact = null;
    const screenshotPath = step.screenshot?.path || step.screenshot_path || step.screenshotPath;
    if (screenshotPath && existsSync(screenshotPath)) {
      try {
        const pngBuf = readFileSync(screenshotPath);
        screenshotArtifact = recordArtifact(basename(screenshotPath), pngBuf, "image/png");
      } catch {}
    }

    conversationLines.push(JSON.stringify({
      role: "user",
      content: obsText,
      timestamp: stepTime,
      step: step.number || i + 1,
      sequence: sequenceNumber++,
      ...(obsArtifact ? { artifact: obsArtifact } : {}),
      ...(rawObsArtifact ? { raw_artifact: rawObsArtifact } : {}),
      ...(screenshotArtifact ? { screenshot_artifact: screenshotArtifact } : {}),
    }));

    // If agentEvents wasn't provided, build eventLine from step
    if (!agentEvents || agentEvents.length === 0) {
      eventLines.push(JSON.stringify({
        id: `step-${i + 1}`,
        sequence: sequenceNumber++,
        timestamp: stepTime,
        trace_id: traceId,
        parent_id: rootSpanId,
        span_id: stepSpanId,
        producer: "agent",
        kind: "agent_step",
        tool: step.tool,
        action: step.action,
        durationMs: step.durationMs,
        ...(obsArtifact ? { observation_artifact: obsArtifact } : {}),
      }));
    }

    // OTLP Step Span (Standard OTLP JSON lowerCamelCase schema)
    const stepStartMs = new Date(stepTime).getTime();
    const stepDurationMs = Number(step.durationMs) || 100;
    otlpSpans.push({
      traceId,
      spanId: stepSpanId,
      parentSpanId: rootSpanId,
      name: `agent.step.${step.number || i + 1}`,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: String(BigInt(stepStartMs) * 1000000n),
      endTimeUnixNano: String(BigInt(stepStartMs + stepDurationMs) * 1000000n),
      attributes: [
        { key: "openrind.task.id", value: { stringValue: taskId } },
        { key: "openrind.step.number", value: { intValue: step.number || i + 1 } },
        { key: "openrind.step.tool", value: { stringValue: step.tool || "browser" } },
      ],
      status: { code: 1 }, // STATUS_CODE_OK
    });
  }

  // Integrate Haloop Model Spans if provided
  if (Array.isArray(haloopSpans) && haloopSpans.length > 0) {
    for (const hSpan of haloopSpans) {
      otlpSpans.push({
        traceId,
        spanId: hSpan.spanId || hSpan.span_id || stableSpanId(`haloop-${sequenceNumber++}`),
        parentSpanId: rootSpanId,
        name: hSpan.name || "haloop.model_call",
        kind: 3, // SPAN_KIND_CLIENT
        startTimeUnixNano: hSpan.startTimeUnixNano || String(BigInt(Date.now()) * 1000000n),
        endTimeUnixNano: hSpan.endTimeUnixNano || String(BigInt(Date.now() + 500) * 1000000n),
        attributes: Array.isArray(hSpan.attributes) ? hSpan.attributes : [],
        status: hSpan.status || { code: 1 },
      });
    }
  }

  // 3. Challenge Server & Judge Events (Independent Provenance)
  if (Array.isArray(challengeEvents) && challengeEvents.length > 0) {
    for (const chEvt of challengeEvents) {
      eventLines.push(JSON.stringify({
        id: `ch-${sequenceNumber}`,
        sequence: sequenceNumber++,
        timestamp: chEvt.at || startedAt,
        trace_id: traceId,
        parent_id: rootSpanId,
        producer: chEvt.kind === "judge" ? "challenge-judge" : "challenge-server",
        provenance: {
          origin: "challenge-server.mjs",
          independent_verdict: chEvt.kind === "judge",
        },
        kind: chEvt.kind,
        details: chEvt,
      }));
    }
  } else if (trajectory.judge) {
    // If challenge events not provided as separate file, emit official judge verdict event
    eventLines.push(JSON.stringify({
      id: `judge-${sequenceNumber}`,
      sequence: sequenceNumber++,
      timestamp: trajectory.judge.submittedAt || new Date().toISOString(),
      trace_id: traceId,
      parent_id: rootSpanId,
      producer: "challenge-judge",
      provenance: {
        origin: "challenge-server.mjs",
        independent_verdict: true,
      },
      kind: "judge_verdict",
      details: trajectory.judge,
    }));
  }

  // 4. Root OTLP Span (Standard OTLP JSON lowerCamelCase schema)
  const rootStartMs = new Date(startedAt).getTime();
  const rootSpan = {
    traceId,
    spanId: rootSpanId,
    name: `openrind.ctf.${taskId}`,
    kind: 2, // SPAN_KIND_SERVER
    startTimeUnixNano: String(BigInt(rootStartMs) * 1000000n),
    endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
    attributes: [
      { key: "openrind.task.id", value: { stringValue: taskId } },
      { key: "openrind.task.title", value: { stringValue: task.title || taskId } },
      { key: "openrind.model", value: { stringValue: trajectory.model || "unknown" } },
      { key: "openrind.solved", value: { boolValue: Boolean(trajectory.solved || trajectory.judge?.accepted) } },
      { key: "service.name", value: { stringValue: "openrind-ctf" } },
    ],
    status: { code: trajectory.solved || trajectory.judge?.accepted ? 1 : 2 },
  };

  const otlpTracesDocument = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "openrind-desktop" } },
            { key: "service.version", value: { stringValue: "0.14.0" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "com.openrind.ctf", version: "1.0.0" },
            spans: [rootSpan, ...otlpSpans],
          },
        ],
      },
    ],
  };

  // Determine true capture completeness (independent of judge verdict / task success)
  const hasCrash = Boolean(trajectory.error || trajectory.crashed || (steps && steps.some(s => s.error && s.fatal)));
  const isComplete = !hasCrash && (
    trajectory.status === "completed" ||
    Boolean(trajectory.completedAt) ||
    trajectory.exitReason === "complete" ||
    (Array.isArray(agentEvents) && agentEvents.some(e => e.kind === "agent_complete")) ||
    (steps.length > 0 && !trajectory.aborted && !trajectory.timedOut)
  );

  // Determine active producers that actually contributed evidence
  const activeProducers = new Set(["agent"]);
  if (Array.isArray(haloopSpans) && haloopSpans.length > 0) activeProducers.add("inference-gateway");
  if (Array.isArray(challengeEvents) && challengeEvents.length > 0) {
    activeProducers.add("challenge-server");
    if (challengeEvents.some(e => e.kind === "judge" || e.producer === "challenge-judge")) {
      activeProducers.add("challenge-judge");
    }
  } else if (trajectory.judge?.independent) {
    activeProducers.add("challenge-judge");
  }
  if (Array.isArray(agentEvents) && agentEvents.some(e => e.kind?.startsWith("browser_pod") || e.observer === "browser")) {
    activeProducers.add("browser");
  }

  // 5. Build Manifest
  const profiles = [
    "agent-execution/v1",
    "browser-ctf/v1",
    "task-verification/v1",
  ];
  if (hasObservedModelContext) {
    profiles.unshift("model-context/v1");
  }

  const manifest = {
    schema_version: TRACEPACK_SCHEMA_VERSION,
    parser_version: PARSER_VERSION,
    trace_id: traceId,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    client: {
      name: "Openrind Desktop",
      version: "0.14.0",
      runtime: "electron-win32",
    },
    task: {
      id: taskId,
      title: task.title || taskId,
      category: task.category || "web",
    },
    profiles,
    model: trajectory.model || "unknown",
    capture: {
      complete: isComplete,
      sealed: isComplete,
      dropped_events_count: 0,
      total_conversation_turns: conversationLines.length,
      total_events: eventLines.length,
      total_artifacts: Object.keys(artifactsMap).length,
    },
    producers: Array.from(activeProducers),
  };

  // 6. Compile File List
  files.push({
    path: "tracepack/manifest.json",
    content: JSON.stringify(manifest, null, 2),
  });

  files.push({
    path: "tracepack/conversation.jsonl",
    content: conversationLines.join("\n") + "\n",
  });

  files.push({
    path: "tracepack/events.jsonl",
    content: eventLines.join("\n") + "\n",
  });

  files.push({
    path: "tracepack/otlp/traces.json",
    content: JSON.stringify(otlpTracesDocument, null, 2),
  });

  files.push({
    path: "tracepack/otlp/logs.json",
    content: JSON.stringify({ resourceLogs: [] }, null, 2),
  });

  files.push({
    path: "tracepack/artifacts/manifest.json",
    content: JSON.stringify(artifactsMap, null, 2),
  });

  files.push({
    path: "tracepack/provenance/environment.json",
    content: JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        runtime: "electron-main",
        captured_at: new Date().toISOString(),
        task_id: taskId,
      },
      null,
      2
    ),
  });

  files.push({
    path: "tracepack/receipts/run.json",
    content: JSON.stringify(
      {
        run_id: traceId,
        trace_id: traceId,
        receipt_type: "local_export",
        status: isComplete ? "local_export_complete" : "local_export_incomplete",
        sealed_at: new Date().toISOString(),
        event_count: eventLines.length,
        artifact_count: Object.keys(artifactsMap).length,
      },
      null,
      2
    ),
  });

  // 7. Store Raw Source Records
  files.push({
    path: "tracepack/source-records/trajectory.json",
    content: JSON.stringify(trajectory, null, 2),
  });

  if (Array.isArray(agentEvents) && agentEvents.length > 0) {
    files.push({
      path: "tracepack/source-records/agent-events.jsonl",
      content: agentEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  }

  if (Array.isArray(challengeEvents) && challengeEvents.length > 0) {
    files.push({
      path: "tracepack/source-records/challenge-events.jsonl",
      content: challengeEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  }

  return { files, manifest };
}

/**
 * Generates a valid TracePack ZIP buffer from input trace data.
 * Pure Node.js; no external CLI binaries.
 */
export function createTracePackZip(options) {
  const { files, manifest } = buildTracePackFiles(options);
  const zipBuffer = createZipBuffer(files);
  return { buffer: zipBuffer, manifest };
}
