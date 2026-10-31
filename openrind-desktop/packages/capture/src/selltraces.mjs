// Normalized SellTraces Projection and Privacy Scrubber (Section 7.5 & 13.4)
import { createHash } from "node:crypto";
import { createRunIdentity } from "./identity.mjs";

export const PROJECTION_SCHEMA_VERSION = "1.0.0";

export const PII_PATTERNS = [
  { name: "Anthropic API Key", regex: /sk-ant-[a-zA-Z0-9_\-]{20,}/g },
  { name: "OpenRouter API Key", regex: /sk-or-[a-zA-Z0-9_\-]{20,}/g },
  { name: "OpenAI API Key", regex: /sk-[a-zA-Z0-9_\-]{20,}/g },
  { name: "Bearer Token", regex: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi },
  { name: "Generic Secret/Password", regex: /(?:"?(?:password|secret|token|api_?key)"?\s*[:=]\s*)"([^"]+)"/gi },
  { name: "Email Address", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
];

export function scanPii(text) {
  if (typeof text !== "string" || !text) return [];
  const findings = [];
  for (const p of PII_PATTERNS) {
    const matches = text.match(p.regex);
    if (matches && matches.length > 0) {
      findings.push({ name: p.name, count: matches.length });
    }
  }
  return findings;
}

export function scrubPiiText(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  out = out.replace(/sk-ant-[a-zA-Z0-9_\-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]");
  out = out.replace(/sk-or-[a-zA-Z0-9_\-]{20,}/g, "[REDACTED_OPENROUTER_KEY]");
  out = out.replace(/sk-[a-zA-Z0-9_\-]{20,}/g, "[REDACTED_OPENAI_KEY]");
  out = out.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, "Bearer [REDACTED_TOKEN]");
  out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");
  out = out.replace(/(?:"?(?:password|secret|token|api_?key)"?\s*[:=]\s*)"([^"]+)"/gi, (match, val) => {
    return match.replace(`"${val}"`, '"[REDACTED_SECRET]"');
  });
  return out;
}

export function projectToSellTraces({
  trajectory = {},
  agentEvents = [],
  challengeEvents = [],
  scrubPii = true,
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

  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const hasCrash = Boolean(trajectory.error || trajectory.crashed || (steps && steps.some((s) => s.error && s.fatal)));
  const isComplete = !hasCrash && (
    trajectory.status === "completed" ||
    Boolean(trajectory.completedAt) ||
    trajectory.exitReason === "complete" ||
    (Array.isArray(agentEvents) && agentEvents.some((e) => e.kind === "agent_complete")) ||
    (steps.length > 0 && !trajectory.aborted && !trajectory.timedOut)
  );

  const messages = [];
  const piiFindingsMap = new Map();
  let position = 1;

  function trackPii(text) {
    const found = scanPii(text);
    for (const f of found) {
      piiFindingsMap.set(f.name, (piiFindingsMap.get(f.name) || 0) + f.count);
    }
    return scrubPii ? scrubPiiText(text) : text;
  }

  // Check for observed model requests
  const modelCalls = (Array.isArray(agentEvents) ? agentEvents : [])
    .filter((e) => (e.kind === "model_call" || e.kind === "model_request") && (e.request?.messages || e.messages));
  const firstModelCall = modelCalls[0];
  const observedReqMessages = firstModelCall?.request?.messages || firstModelCall?.messages;

  let recoveredFromSource = false;
  if (Array.isArray(observedReqMessages) && observedReqMessages.length > 0) {
    for (const msg of observedReqMessages) {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      messages.push({
        role: msg.role || "user",
        content: trackPii(text),
        position: position++,
        timestamp: msg.timestamp || firstModelCall.at || startedAt,
        provenance: "observed_model_request",
      });
    }
    recoveredFromSource = true;
  }

  if (messages.length === 0) {
    messages.push({
      role: "system",
      content: trackPii(`You are an Openrind agent. Target: ${task.title || taskId}. ${task.description || ""}`.trim()),
      position: position++,
      timestamp: startedAt,
      provenance: "derived_from_task",
    });

    messages.push({
      role: "user",
      content: trackPii(`Solve the task: ${task.title || taskId}.`.trim()),
      position: position++,
      timestamp: startedAt,
      provenance: "derived_from_task",
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepTime = step.at || startedAt;

    const assistantContent = step.thought
      ? JSON.stringify({
          thought: step.thought,
          tool: step.tool || "browser",
          action: step.action,
        })
      : (typeof step.action === "string" ? step.action : JSON.stringify(step.action || {}));

    messages.push({
      role: "assistant",
      content: trackPii(assistantContent),
      position: position++,
      timestamp: stepTime,
      step: step.number || i + 1,
    });

    if (step.observation !== undefined && step.observation !== null) {
      messages.push({
        role: "user",
        content: trackPii(String(step.observation)),
        position: position++,
        timestamp: stepTime,
        step: step.number || i + 1,
      });
    }
  }

  const piiFindings = Array.from(piiFindingsMap.entries()).map(([name, count]) => ({
    name,
    count,
  }));

  const traceObj = {
    trace_id: identity.trace_id,
    session_id: identity.session_id,
    source_id: identity.run_id,
    created_at: startedAt,
    model: trajectory.model || "unknown",
    messages,
    metadata: {
      client: "Openrind Desktop",
      task_id: taskId,
      complete: isComplete,
      recovered_from_source: recoveredFromSource,
    },
  };

  const sellTracesJson = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    traces: [traceObj],
  };

  const contentHash = createHash("sha256")
    .update(Buffer.from(JSON.stringify(sellTracesJson)))
    .digest("hex");

  const projectionReport = {
    schema: "openrind.selltraces.projection-report/v1",
    generated_at: new Date().toISOString(),
    trace_id: identity.trace_id,
    session_id: identity.session_id,
    content_hash: contentHash,
    complete: isComplete,
    recovered_from_source: recoveredFromSource,
    pii_redacted: scrubPii,
    pii_findings: piiFindings,
    total_messages: messages.length,
  };

  return { sellTracesJson, projectionReport, piiFindings };
}
