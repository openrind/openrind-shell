// Canonical Lossless Openrind TracePack Packager (Shared Module)
import { createRunIdentity } from "./identity.mjs";
import { ArtifactStore } from "./artifacts.mjs";
import { reconstructConversationFromSource } from "./conversation.mjs";
import { buildOtlpSpan, buildOtlpTracesDocument, SPAN_KINDS, STATUS_CODES } from "./otlp.mjs";
import { createRunReceipt } from "./receipt.mjs";
import { PROFILES } from "./schema.mjs";

export const TRACEPACK_SCHEMA_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";

export function buildTracePackFiles({
  trajectory = {},
  agentEvents = [],
  challengeEvents = [],
  haloopSpans = [],
  artifacts = null,
} = {}) {
  const task = trajectory.task || {};
  const taskId = task.id || "task";
  const startedAt = trajectory.startedAt || new Date().toISOString();

  const identity = createRunIdentity({
    runId: trajectory.runId || trajectory.id,
    taskId,
    sessionId: trajectory.sessionId,
    nativeSessionId: trajectory.nativeSessionId || null,
  });

  const artifactStore = artifacts instanceof ArtifactStore ? artifacts : new ArtifactStore();
  const files = [];
  const eventLines = [];
  const otlpSpans = [];

  let sequenceNumber = 1;

  // 1. Observed model requests check
  const modelCalls = (Array.isArray(agentEvents) ? agentEvents : [])
    .filter((e) => (e.kind === "model_call" || e.kind === "model_request") && (e.request?.messages || e.messages));
  const firstModelCall = modelCalls[0];
  const observedReqMessages = firstModelCall?.request?.messages || firstModelCall?.messages;

  // 2. Reconstruct conversation
  const { turns: conversationTurns, source: conversationSource } = reconstructConversationFromSource({
    observedMessages: observedReqMessages,
    steps: Array.isArray(trajectory.steps) ? trajectory.steps : [],
    fallbackSystemPrompt: `You are an Openrind agent. Target: ${task.title || taskId}. ${task.description || ""}`.trim(),
    fallbackUserPrompt: `Solve the task: ${task.title || taskId}.`.trim(),
    startedAt,
  });

  const conversationLines = conversationTurns.map((t) => JSON.stringify(t));

  // 3. Process Agent Events
  if (Array.isArray(agentEvents) && agentEvents.length > 0) {
    for (const rawEvt of agentEvents) {
      const evtId = `evt-${sequenceNumber}`;
      const evtTime = rawEvt.at || startedAt;

      let artifactRef = null;
      if (rawEvt.observation && String(rawEvt.observation).length > 2048) {
        artifactRef = artifactStore.record(`observation-${sequenceNumber}.txt`, rawEvt.observation, "text/plain");
      }

      eventLines.push(
        JSON.stringify({
          id: evtId,
          sequence: sequenceNumber++,
          timestamp: evtTime,
          trace_id: identity.trace_id,
          parent_id: identity.root_span_id,
          producer: "agent",
          origin: rawEvt.origin || "agent",
          observer: rawEvt.observer || (rawEvt.kind?.startsWith("browser") ? "browser" : "agent"),
          executor: rawEvt.executor || null,
          ...(rawEvt.kind?.startsWith("model") ? { relayed_by: "inference-gateway" } : {}),
          kind: rawEvt.kind,
          details: {
            ...rawEvt,
            ...(artifactRef ? { observation_artifact: artifactRef } : {}),
          },
        }),
      );
    }
  }

  // 4. Map trajectory steps to OTLP Spans
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepTime = step.at || startedAt;
    const stepSpanId = identity.root_span_id.slice(0, 10) + String(i + 1).padStart(6, "0");

    const stepStartMs = new Date(stepTime).getTime();
    const stepDurationMs = Number(step.durationMs) || 100;

    otlpSpans.push(
      buildOtlpSpan({
        traceId: identity.trace_id,
        spanId: stepSpanId,
        parentSpanId: identity.root_span_id,
        name: `agent.step.${step.number || i + 1}`,
        kind: SPAN_KINDS.INTERNAL,
        startTimeMs: stepStartMs,
        endTimeMs: stepStartMs + stepDurationMs,
        attributes: [
          { key: "openrind.task.id", value: { stringValue: taskId } },
          { key: "openrind.step.number", value: { intValue: step.number || i + 1 } },
          { key: "openrind.step.tool", value: { stringValue: step.tool || "browser" } },
        ],
        status: { code: STATUS_CODES.OK },
      }),
    );
  }

  // 5. Integrate Haloop Model Spans if provided
  if (Array.isArray(haloopSpans) && haloopSpans.length > 0) {
    for (const hSpan of haloopSpans) {
      otlpSpans.push({
        traceId: identity.trace_id,
        spanId: hSpan.spanId || hSpan.span_id || `span_${sequenceNumber++}`,
        parentSpanId: identity.root_span_id,
        name: hSpan.name || "haloop.model_call",
        kind: SPAN_KINDS.CLIENT,
        startTimeUnixNano: hSpan.startTimeUnixNano || String(BigInt(Date.now()) * 1000000n),
        endTimeUnixNano: hSpan.endTimeUnixNano || String(BigInt(Date.now() + 500) * 1000000n),
        attributes: Array.isArray(hSpan.attributes) ? hSpan.attributes : [],
        status: hSpan.status || { code: STATUS_CODES.OK },
      });
    }
  }

  // 6. Build Root OTLP Span
  const rootStartMs = new Date(startedAt).getTime();
  const rootSpan = buildOtlpSpan({
    traceId: identity.trace_id,
    spanId: identity.root_span_id,
    name: `openrind.session.${taskId}`,
    kind: SPAN_KINDS.SERVER,
    startTimeMs: rootStartMs,
    endTimeMs: Date.now(),
    attributes: [
      { key: "openrind.task.id", value: { stringValue: taskId } },
      { key: "openrind.task.title", value: { stringValue: task.title || taskId } },
      { key: "openrind.model", value: { stringValue: trajectory.model || "unknown" } },
      { key: "service.name", value: { stringValue: "openrind-capture" } },
    ],
    status: { code: STATUS_CODES.OK },
  });

  const otlpTracesDocument = buildOtlpTracesDocument({
    serviceName: "openrind-desktop",
    serviceVersion: "0.14.0",
    scopeName: "com.openrind.capture",
    spans: [rootSpan, ...otlpSpans],
  });

  // 7. Calculate completeness & seal
  const hasCrash = Boolean(trajectory.error || trajectory.crashed || (steps && steps.some((s) => s.error && s.fatal)));
  const isComplete = !hasCrash && (
    trajectory.status === "completed" ||
    Boolean(trajectory.completedAt) ||
    trajectory.exitReason === "complete" ||
    (Array.isArray(agentEvents) && agentEvents.some((e) => e.kind === "agent_complete")) ||
    (steps.length > 0 && !trajectory.aborted && !trajectory.timedOut)
  );

  const receipt = createRunReceipt({
    runId: identity.run_id,
    receiptRevision: 1,
    state: isComplete ? "sealed_complete" : "sealed_partial",
    completeAtSeal: isComplete,
    currentlyAvailable: true,
    producerId: "agent",
    expectedFinalSequence: sequenceNumber - 1,
    sealVerified: true,
  });

  // 8. Profiles and Manifest
  const activeProfiles = [PROFILES.AGENT_EXECUTION, PROFILES.TASK_VERIFICATION];
  if (conversationSource === "observed_model_request") {
    activeProfiles.unshift(PROFILES.MODEL_CONTEXT);
  }
  if (task.category === "web" || steps.some((s) => s.tool === "browser")) {
    activeProfiles.push(PROFILES.BROWSER_CTF);
  }

  const manifest = {
    schema_version: TRACEPACK_SCHEMA_VERSION,
    parser_version: PARSER_VERSION,
    trace_id: identity.trace_id,
    session_id: identity.session_id,
    created_at: new Date().toISOString(),
    client: {
      name: "Openrind Desktop",
      version: "0.14.0",
      runtime: "electron",
    },
    task: {
      id: taskId,
      title: task.title || taskId,
      category: task.category || "general",
    },
    profiles: activeProfiles,
    model: trajectory.model || "unknown",
    capture: {
      complete: isComplete,
      sealed: isComplete,
      dropped_events_count: 0,
      total_conversation_turns: conversationLines.length,
      total_events: eventLines.length,
      total_artifacts: Object.keys(artifactStore.getManifest()).length,
    },
    producers: ["agent", ...(haloopSpans.length > 0 ? ["inference-gateway"] : [])],
  };

  // Compile output files
  files.push({ path: "tracepack/manifest.json", content: JSON.stringify(manifest, null, 2) });
  files.push({ path: "tracepack/conversation.jsonl", content: conversationLines.join("\n") + "\n" });
  files.push({ path: "tracepack/events.jsonl", content: eventLines.join("\n") + "\n" });
  files.push({ path: "tracepack/otlp/traces.json", content: JSON.stringify(otlpTracesDocument, null, 2) });
  files.push({ path: "tracepack/otlp/logs.json", content: JSON.stringify({ resourceLogs: [] }, null, 2) });
  files.push({ path: "tracepack/receipts/run.json", content: JSON.stringify(receipt, null, 2) });

  // Add all content-addressed artifacts
  files.push(...artifactStore.toZipFiles("tracepack/artifacts"));

  return { files, manifest, identity, receipt };
}
