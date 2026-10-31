// Unified Identity and Provenance Model (Section 7.1)
import { createHash, randomBytes } from "node:crypto";

export function to32Hex(value) {
  if (typeof value === "string" && /^[0-9a-f]{32}$/i.test(value)) {
    return value.toLowerCase();
  }
  return createHash("sha256").update(String(value || randomBytes(16).toString("hex"))).digest("hex").slice(0, 32);
}

export function to16Hex(value) {
  if (typeof value === "string" && /^[0-9a-f]{16}$/i.test(value)) {
    return value.toLowerCase();
  }
  return createHash("sha256").update(String(value || randomBytes(8).toString("hex"))).digest("hex").slice(0, 16);
}

export function createRunIdentity({
  runId = null,
  taskId = "default",
  sessionId = null,
  clientId = "openrind-desktop",
  nativeSessionId = null,
} = {}) {
  const resolvedRunId = String(runId || `${taskId}-${new Date().toISOString()}-${randomBytes(4).toString("hex")}`);
  const traceId = to32Hex(resolvedRunId);
  const rootSpanId = to16Hex(`root-${traceId}`);
  const resolvedSessionId = String(sessionId || `${taskId}:${traceId.slice(0, 12)}`);

  return {
    run_id: resolvedRunId,
    trace_id: traceId,
    root_span_id: rootSpanId,
    session_id: resolvedSessionId,
    client_id: clientId,
    native_session_id: nativeSessionId || null,
  };
}
