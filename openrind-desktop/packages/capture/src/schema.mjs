// Canonical Evidence Record Schema (Section 13.3) and Component Profiles
import { randomBytes } from "node:crypto";

export const CANONICAL_SCHEMA_VERSION = "openrind-evidence/v1";

export const PROFILES = {
  AGENT_EXECUTION: "agent-execution/v1",
  BROWSER_CTF: "browser-ctf/v1",
  MODEL_CONTEXT: "model-context/v1",
  TASK_VERIFICATION: "task-verification/v1",
};

export const PRODUCER_IDS = {
  AGENT: "agent",
  BROWSER: "browser",
  CHALLENGE_SERVER: "challenge-server",
  CHALLENGE_JUDGE: "challenge-judge",
  INFERENCE_GATEWAY: "inference-gateway",
  CLIENT: "client",
};

export const EXECUTOR_TYPES = {
  AGENT_BROWSER: "agent_browser",
  HOST_HTTP_ADAPTER: "host_http_adapter",
  MOCK_DOM_EVAL: "mock_dom_eval",
  NATIVE_BASH: "native_bash",
};

export function createEvidenceRecord({
  eventId,
  runId,
  traceId,
  spanId,
  parentSpanId = null,
  sessionId,
  producerId = PRODUCER_IDS.AGENT,
  producerInstanceId = "default",
  sequence = 1,
  kind = "event",
  observedAtUnixNs = String(BigInt(Date.now()) * 1000000n),
  origin = "observed",
  executor = null,
  attribution = null,
  payload = {},
  capture = {},
}) {
  if (!runId || !traceId || !spanId) {
    throw new Error("createEvidenceRecord requires runId, traceId, and spanId");
  }

  return {
    schema: CANONICAL_SCHEMA_VERSION,
    event_id: eventId || `evt_${randomBytes(8).toString("hex")}`,
    run_id: runId,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    session_id: sessionId || `session_${traceId.slice(0, 12)}`,
    producer_id: producerId,
    producer_instance_id: producerInstanceId,
    sequence: Number(sequence),
    kind,
    observed_at_unix_ns: String(observedAtUnixNs),
    origin: origin === "observed" || origin === "derived" || origin === "unobserved" || origin === "synthesized"
      ? origin
      : "observed",
    ...(executor ? { executor } : {}),
    attribution: {
      method: attribution?.method || "direct",
      tool_call_id: attribution?.tool_call_id || null,
      action_id: attribution?.action_id || null,
    },
    payload: {
      name: payload.name || kind,
      status: payload.status || "ok",
      raw_result_ref: payload.raw_result_ref || null,
      model_observation_ref: payload.model_observation_ref || null,
      ...payload,
    },
    capture: {
      policy_id: capture.policy_id || "default",
      source_truncated: Boolean(capture.source_truncated),
      source_loss: Boolean(capture.source_loss),
      transformation_refs: Array.isArray(capture.transformation_refs) ? capture.transformation_refs : [],
      ...capture,
    },
  };
}

export function validateEvidenceRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.schema !== CANONICAL_SCHEMA_VERSION) return false;
  if (!record.event_id || !record.run_id || !record.trace_id || !record.span_id) return false;
  if (typeof record.sequence !== "number" || isNaN(record.sequence)) return false;
  if (!record.observed_at_unix_ns || typeof record.observed_at_unix_ns !== "string") return false;
  return true;
}
