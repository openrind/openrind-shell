/**
 * CTF run evidence emitter for the Haloop collector evidence API.
 *
 * Emits task.started, artifact.recorded (trajectory + verifier log), and
 * outcome.observed to POST /internal/capture/events, and uploads the raw
 * artifacts to POST /artifacts. Capture is best-effort: failures are logged
 * loudly and reported in the returned problems list, but never thrown, so a
 * collector outage cannot crash a CTF run.
 *
 * Configuration (env, first match wins):
 *   collector URL: OPENRIND_CTF_COLLECTOR_URL, HALOOP_COLLECTOR_URL,
 *     W8_COLLECTOR_URL, or derived from HALOOP_GATEWAY_URL (port 8788)
 *   producer token: W8_CAPTURE_PRODUCER_TOKEN, HALOOP_CAPTURE_TOKEN, ADMIN_TOKEN
 *   project: OPENRIND_CTF_PROJECT, OPENRIND_CAPTURE_PROJECT (default openrind-ctf)
 */

import { createHash } from "node:crypto";

const CAPTURE_SCHEMA_VERSION = 1;
const PRODUCER_VERSION = "openrind-ctf-evidence/1.0.0";
// The collector rejects artifact.recorded events whose inline content exceeds
// 1 MiB. Larger artifacts are still uploaded to /artifacts; the inline
// evidence event is skipped and reported instead of silently truncated.
const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sanitizeIdentifier(value, fallback) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9_.:@/-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || fallback).slice(0, 128);
}

export function resolveCtfCaptureConfig(env = process.env, overrides = {}) {
  let collectorUrl = (
    env.OPENRIND_CTF_COLLECTOR_URL ||
    env.HALOOP_COLLECTOR_URL ||
    env.W8_COLLECTOR_URL ||
    ""
  ).trim().replace(/\/+$/, "");

  if (!collectorUrl) {
    const gateway = (
      overrides.gatewayUrl ||
      env.HALOOP_GATEWAY_URL ||
      env.W8_GATEWAY_URL ||
      env.HALOOP_UPSTREAM_URL ||
      ""
    ).trim();
    if (gateway) {
      try {
        const u = new URL(gateway);
        u.port = "8788";
        u.pathname = "";
        u.search = "";
        u.hash = "";
        collectorUrl = u.origin;
      } catch {}
    }
  }

  const token = (
    env.W8_CAPTURE_PRODUCER_TOKEN ||
    env.HALOOP_CAPTURE_TOKEN ||
    overrides.adminToken ||
    env.ADMIN_TOKEN ||
    ""
  ).trim();
  const project = (
    env.OPENRIND_CTF_PROJECT ||
    env.OPENRIND_CAPTURE_PROJECT ||
    "openrind-ctf"
  ).trim();

  return { collectorUrl, token, project, enabled: Boolean(collectorUrl && token) };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return res;
}

function evidenceEnvelope({ project, sessionId, eventId, data }) {
  return {
    schema_version: CAPTURE_SCHEMA_VERSION,
    project,
    session_id: sessionId,
    event_id: eventId,
    occurred_at: new Date().toISOString(),
    producer_version: PRODUCER_VERSION,
    data,
  };
}

/**
 * Verify that a trajectory and its agent-events JSONL describe the same run.
 * Returns { ok, problems[] }; never throws.
 */
export function checkTrajectoryIntegrity(trajectory, agentEvents = []) {
  const problems = [];
  const sessionId = trajectory?.sessionId;
  const runId = trajectory?.runId;

  const eventSessionIds = new Set();
  const eventRunIds = new Set();
  const eventModels = new Set();
  for (const event of agentEvents) {
    if (!event || typeof event !== "object") continue;
    if (event.sessionId) eventSessionIds.add(event.sessionId);
    if (event.runId) eventRunIds.add(event.runId);
    if (event.kind === "model_call" && event.model) eventModels.add(event.model);
  }
  for (const value of eventSessionIds) {
    if (value !== sessionId) {
      problems.push(`agent-events sessionId "${value}" != trajectory sessionId "${sessionId}"`);
    }
  }
  for (const value of eventRunIds) {
    if (value !== runId) {
      problems.push(`agent-events runId "${value}" != trajectory runId "${runId}"`);
    }
  }
  if (trajectory?.model) {
    for (const value of eventModels) {
      if (value !== trajectory.model) {
        problems.push(`agent-events model "${value}" != trajectory model "${trajectory.model}"`);
      }
    }
  }

  let previousStep = 0;
  for (const step of trajectory?.steps || []) {
    if (typeof step?.number !== "number" || step.number <= previousStep) {
      problems.push(`non-monotonic step number ${step?.number} after ${previousStep}`);
    }
    previousStep = typeof step?.number === "number" ? step.number : previousStep;
  }

  const started = Date.parse(trajectory?.startedAt || "");
  const submitted = Date.parse(trajectory?.judge?.submittedAt || "");
  if (Number.isFinite(started) && Number.isFinite(submitted) && !(started < submitted)) {
    problems.push("startedAt is not strictly before judge.submittedAt");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Emit the evidence trail for one finished CTF run. Never throws.
 * Returns { emitted, problems[] }.
 */
export async function emitCtfRunEvidence({
  config,
  task,
  runId,
  sessionId,
  model,
  solved,
  stopped,
  trajectoryJson,
  challengeEventsJsonl,
  verifierName = "challenge-server.mjs",
  verifierVersion = "1",
  log = console.error,
}) {
  const problems = [];
  if (!config?.enabled) {
    return { emitted: false, problems };
  }

  const auth = { authorization: `Bearer ${config.token}` };
  const taskId = sanitizeIdentifier(task?.id, "ctf-task");
  const attemptId = sanitizeIdentifier(runId, `run-${Date.now()}`);
  const trajectoryArtifactId = sanitizeIdentifier(`traj-${taskId}-${attemptId}`, `traj-${Date.now()}`);
  const verifierLogArtifactId = sanitizeIdentifier(`vlog-${taskId}-${attemptId}`, `vlog-${Date.now()}`);
  const trajectorySha256 = sha256Hex(trajectoryJson);
  const verifierLogSha256 = sha256Hex(challengeEventsJsonl);

  // 1. Content-addressed artifact uploads (direct HTTP viewing).
  for (const artifact of [
    { artifact_id: trajectoryArtifactId, sha256: trajectorySha256, content: trajectoryJson, content_type: "application/json" },
    { artifact_id: verifierLogArtifactId, sha256: verifierLogSha256, content: challengeEventsJsonl, content_type: "application/x-ndjson" },
  ]) {
    try {
      await postJson(`${config.collectorUrl}/artifacts`, {
        artifact_id: artifact.artifact_id,
        sha256: artifact.sha256,
        content: Buffer.from(artifact.content, "utf8").toString("base64"),
        content_type: artifact.content_type,
      }, auth);
    } catch (err) {
      const problem = `artifact upload ${artifact.artifact_id} failed: ${err.message}`;
      problems.push(problem);
      log(`[CTF evidence] ${problem}`);
    }
  }

  // 2. Evidence events, in dependency order: task, artifacts, outcome.
  const events = [];
  events.push({
    eventId: sanitizeIdentifier(`evt-${attemptId}-task-started`, `evt-${Date.now()}-start`),
    data: {
      type: "task.started",
      task_id: taskId,
      attempt_id: attemptId,
      domain: "browser",
      instruction: `${task?.title || taskId}\n${task?.description || ""}`.trim().slice(0, 262144),
      harness: { name: "openrind-ctf-agent", version: PRODUCER_VERSION },
    },
  });

  for (const artifact of [
    { artifactId: trajectoryArtifactId, kind: "other", content: trajectoryJson, contentType: "application/json", sha256: trajectorySha256, boundary: "final" },
    { artifactId: verifierLogArtifactId, kind: "verifier_log", content: challengeEventsJsonl, contentType: "application/x-ndjson", sha256: verifierLogSha256, boundary: "observation" },
  ]) {
    if (Buffer.byteLength(artifact.content, "utf8") > MAX_INLINE_ARTIFACT_BYTES) {
      const problem = `artifact.recorded ${artifact.artifactId} skipped: content exceeds 1 MiB inline limit (uploaded to /artifacts only)`;
      problems.push(problem);
      log(`[CTF evidence] ${problem}`);
      continue;
    }
    events.push({
      eventId: sanitizeIdentifier(`evt-${attemptId}-${artifact.kind === "verifier_log" ? "vlog" : "traj"}`, `evt-${Date.now()}-art`),
      data: {
        type: "artifact.recorded",
        artifact_id: artifact.artifactId,
        kind: artifact.kind,
        content: artifact.content,
        content_type: artifact.contentType,
        sha256: artifact.sha256,
        boundary: artifact.boundary,
      },
    });
  }

  const verdict = stopped ? "unknown" : solved ? "pass" : "fail";
  const evidenceIds = [trajectoryArtifactId, verifierLogArtifactId];
  events.push({
    eventId: sanitizeIdentifier(`evt-${attemptId}-outcome`, `evt-${Date.now()}-outcome`),
    data: {
      type: "outcome.observed",
      task_id: taskId,
      attempt_id: attemptId,
      origin: "verifier",
      verdict,
      subject_sha256: trajectorySha256,
      verifier_name: verifierName,
      verifier_version: verifierVersion,
      evidence_artifact_ids: evidenceIds,
      ...(verdict === "unknown" ? {} : {
        reward: solved ? 1 : 0,
        reward_definition: "challenge judge flag acceptance (1 = flag accepted, 0 = run finished without acceptance)",
      }),
    },
  });

  for (const event of events) {
    try {
      await postJson(
        `${config.collectorUrl}/internal/capture/events`,
        evidenceEnvelope({ project: config.project, sessionId, eventId: event.eventId, data: event.data }),
        auth,
      );
    } catch (err) {
      const problem = `event ${event.data.type} (${event.eventId}) failed: ${err.message}`;
      problems.push(problem);
      log(`[CTF evidence] ${problem}`);
    }
  }

  if (problems.length === 0) {
    log(`[CTF evidence] recorded ${events.length} events + 2 artifacts for ${attemptId} (verdict: ${verdict})`);
  }
  return { emitted: true, problems };
}
