// Desktop-owned lifecycle for the required Openrind Haloop inference edge.
//
// The upstream provider key is written only to mode-0600 files in the dedicated
// OpenShell WSL distro and mounted into the managed Haloop services. Sandboxes
// receive a scoped client token through OpenShell's endpoint-bound provider;
// they never receive the upstream credential.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { exportHarborDatasetToZip } from "./harbor-exporter.mjs";
import { runtimeDiagnostics } from "./runtime-diagnostics.mjs";
import { resolveDiagnosticRoute } from "./diagnostic-route.mjs";
import {
  registerHaloopClientProfile,
  resolveHaloopClientProfileIdentity,
  revokeAllHaloopClientProfiles,
  revokeHaloopClientProfilesForSandbox,
  rotateHaloopClientProfile,
} from "./openrind-shell-credentials.mjs";
import { DISTRO_NAME, ensureDistroRunning, wslRun } from "./wsl.mjs";

export const HALOOP_IMAGE_CONTRACT = "openrind-haloop-v2";
export const HALOOP_CONTAINER_NAME = "openrind-desktop-haloop";
export const HALOOP_COLLECTOR_IMAGE_CONTRACT = "openrind-haloop-collector-v1";
export const HALOOP_COLLECTOR_CONTAINER_NAME = "openrind-desktop-haloop-collector";
export const HALOOP_NETWORK_NAME = "openrind-desktop-haloop";
export const HALOOP_EDGE_PORT = 8787;
export const HALOOP_SANDBOX_ENDPOINT =
  process.env.HALOOP_GATEWAY_URL?.trim() ||
  process.env.OPENRIND_DESKTOP_HALOOP_ENDPOINT?.trim() ||
  `http://136.112.93.84:${HALOOP_EDGE_PORT}`;
export const HALOOP_ROUTE_POLICY = "incumbent-only";
export const HALOOP_TEMPORARY_OPENROUTER_TEST_ENV =
  "OPENRIND_DESKTOP_HALOOP_TEST_OPENROUTER";
export const HALOOP_TEMPORARY_OPENROUTER_MODEL = "openrouter/free";

const HALOOP_TEMPORARY_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../../../../../");
const SOURCE_CHECKOUT = existsSync(path.join(REPOSITORY_ROOT, "Dockerfile.openrind-shell"));
export const HALOOP_IMAGE_VERSION = "w8-haloop-openrind-v6-durable-analysis";
export const HALOOP_PACKAGED_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-gateway:${HALOOP_IMAGE_VERSION}`;
export const HALOOP_PACKAGED_COLLECTOR_IMAGE =
  `ghcr.io/openrind/openrind-shell/haloop-collector:${HALOOP_IMAGE_VERSION}`;

export function resolveHaloopImageConfig({
  sourceCheckout = SOURCE_CHECKOUT,
  env = process.env,
} = {}) {
  const image = env.OPENRIND_DESKTOP_HALOOP_IMAGE?.trim() ||
    (sourceCheckout ? "haloop-gateway:local" : HALOOP_PACKAGED_IMAGE);
  const collectorImage = env.OPENRIND_DESKTOP_HALOOP_COLLECTOR_IMAGE?.trim() ||
    (sourceCheckout ? "haloop-collector:local" : HALOOP_PACKAGED_COLLECTOR_IMAGE);
  const pullPolicy = env.OPENRIND_DESKTOP_HALOOP_PULL_POLICY?.trim() ||
    (image.endsWith(":local") && collectorImage.endsWith(":local") ? "never" : "missing");
  if (!new Set(["never", "missing", "always"]).has(pullPolicy)) {
    throw new Error("OPENRIND_DESKTOP_HALOOP_PULL_POLICY must be never, missing, or always.");
  }
  return { image, collectorImage, pullPolicy };
}

const HALOOP_IMAGE_CONFIG = resolveHaloopImageConfig();
export const HALOOP_IMAGE = HALOOP_IMAGE_CONFIG.image;
export const HALOOP_COLLECTOR_IMAGE = HALOOP_IMAGE_CONFIG.collectorImage;
export const HALOOP_IMAGE_PULL_POLICY = HALOOP_IMAGE_CONFIG.pullPolicy;

const HALOOP_STATE_DIR = "/var/lib/openrind-desktop/haloop";
const HALOOP_COLLECTOR_DATA_DIR = `${HALOOP_STATE_DIR}/collector-data`;
const HALOOP_REPORTS_DIR = `${HALOOP_STATE_DIR}/reports`;
const HALOOP_ANALYSIS_ENV_FILE = `${HALOOP_STATE_DIR}/analysis.env`;
const HALOOP_COLLECTOR_CONTAINER_DATA_DIR = "/app/halo-loop/data";
const HALOOP_COLLECTOR_CONTAINER_REPORTS_DIR = "/app/halo-loop/reports";
const HALOOP_COLLECTOR_URL = `http://${HALOOP_COLLECTOR_CONTAINER_NAME}:8788`;
const HALOOP_PROFILES_FILE = `${HALOOP_STATE_DIR}/openrind-profiles.json`;
const HALOOP_READY_ROUTE_FILE = `${HALOOP_STATE_DIR}/ready-route.json`;
const HALOOP_CONTAINER_PROFILES_FILE = "/run/openrind/openrind-profiles.json";
const OPENSHELL_SANDBOX_NETWORK_NAME = "openshell-docker";
const PROFILE_HASH_LABEL = "com.openrind.desktop.haloop-profile-sha256";
const MANAGED_LABEL = "com.openrind.desktop.managed-haloop";
const MANAGED_NETWORK_LABEL = "com.openrind.desktop.managed-haloop-network";
const COLLECTOR_ANALYSIS_LABEL = "com.openrind.desktop.haloop-analysis-contract";
const COLLECTOR_ANALYSIS_CONTRACT = "openrind-halo-analysis-v2";
const COLLECTOR_ANALYSIS_CONFIG_HASH_LABEL =
  "com.openrind.desktop.haloop-analysis-config-sha256";
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_SECONDS = 45;
const IMAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const APP_SPAN_KINDS = new Set(["AGENT", "TOOL", "CHAIN"]);
const MAX_APP_SPANS_PER_BATCH = 64;
const MAX_APP_SPAN_BYTES = 64 * 1024;
const MAX_APP_BATCH_BYTES = 256 * 1024;
const MAX_APP_CAPTURE_BYTES_PER_TRACE = 4 * 1024 * 1024;
const MAX_COLLECTOR_RESPONSE_BYTES = 1024 * 1024;
const MAX_HALOOP_REPORT_BYTES = 512 * 1024;
const MAX_HALOOP_EVAL_PREVIEW_BYTES = 1024 * 1024;
const HALOOP_REPORT_RETENTION_DAYS = 30;
const HALOOP_REPORT_RETENTION_COUNT = 20;
const HALOOP_SESSION_ASSERTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HALOOP_CONTEXT_ID_PATTERN = /^[0-9a-f]{32}$/;
const HALOOP_RUN_ID_PATTERN = /^[0-9a-f]{12}$/;
const HALOOP_PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HALOOP_EVAL_ARTIFACT_PATTERN = /^eval-cases-[0-9a-f]{12}\.jsonl$/;
const HALOOP_ANALYSIS_PROMPT =
  "Diagnose recurring tool-use failures, invalid tool arguments, refusal loops, empty outputs, and wasted retries in these Openrind agent traces. Compare only models actually present in the trace data. Cite the exact trace_id and span_id for every finding, and treat citations as evidence rather than automatic failure labels.";

function requiredSecret(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is required for Haloop.`);
  }
  return normalized;
}

export function isTemporaryOpenRouterHaloopTestEnabled(env = process.env) {
  return String(env?.[HALOOP_TEMPORARY_OPENROUTER_TEST_ENV] ?? "").trim() === "1";
}

function resolveHaloopUpstream(anthropicApiKey, env = process.env, { optional = false } = {}) {
  const explicitOpenrouterTest = isTemporaryOpenRouterHaloopTestEnabled(env);
  const rawCandidate =
    (explicitOpenrouterTest ? env?.OPENROUTER_API_KEY : null) ||
    anthropicApiKey ||
    env?.OPENROUTER_API_KEY ||
    "";
  const normalized = String(rawCandidate ?? "").trim();
  const openrouterTest = explicitOpenrouterTest || normalized.startsWith("sk-or-v1-");
  const label = openrouterTest ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (optional && !normalized) {
    return { apiKey: "", mode: openrouterTest ? "openrouter-test" : "anthropic" };
  }
  const apiKey = requiredSecret(normalized, label);
  return {
    apiKey,
    mode: openrouterTest ? "openrouter-test" : "anthropic",
  };
}

export function resolveHaloopUpstreamApiKey(
  anthropicApiKey,
  { env = process.env, optional = false } = {},
) {
  return resolveHaloopUpstream(anthropicApiKey, env, { optional }).apiKey;
}

function buildHaloopAnalysisEnvironment(upstream) {
  if (upstream.mode === "openrouter-test") {
    return `OPENROUTER_API_KEY=${upstream.apiKey}\nHALO_MODEL=${HALOOP_TEMPORARY_OPENROUTER_MODEL}\n`;
  }
  return `ANTHROPIC_API_KEY=${upstream.apiKey}\n`;
}

function safeDiagnosticMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown Haloop error");
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
}

function stableHex(label, ...values) {
  const hash = createHash("sha256").update(label);
  for (const value of values) hash.update("\0").update(String(value));
  return hash.digest("hex");
}

export function haloopProjectForWorkspace(workspaceId, sandboxName) {
  if (sandboxName) {
    const s = String(sandboxName).trim();
    if (s) return s;
  }
  if (workspaceId) {
    const w = String(workspaceId).trim();
    if (w) return w;
  }
  return "default";
}

function deriveHaloopSessionHmacKey(profile) {
  return stableHex(
    "openrind-haloop-session-key-v1",
    requiredSecret(profile.clientToken, "Haloop client token"),
  );
}

export function buildHaloopCaptureIdentity(profile, contextId) {
  const canonicalContextId = String(contextId ?? "").trim();
  if (!HALOOP_CONTEXT_ID_PATTERN.test(canonicalContextId)) {
    throw new Error("A canonical Haloop conversation context id is required.");
  }
  const project = (profile.sandboxName && String(profile.sandboxName).trim()) || haloopProjectForWorkspace(profile.workspaceId);
  return {
    profileId: requiredSecret(profile.id, "Haloop profile id"),
    project,
    traceId: stableHex(
      "openrind-haloop-trace-v2",
      profile.id,
      canonicalContextId,
    ).slice(0, 32),
    rootSpanId: stableHex(
      "openrind-haloop-root-v2",
      profile.id,
      canonicalContextId,
    ).slice(0, 16),
    sessionId: `${requiredSecret(profile.agentId, "Haloop agent id")}:${canonicalContextId}`,
  };
}

export function issueHaloopConversationContext(profile, options = {}) {
  const suppliedContextId = String(options.contextId ?? "").trim();
  const agentSessionId = String(options.agentSessionId ?? "").trim();
  if (agentSessionId.length > 4_096) {
    throw new Error("The agent session id is too long for Haloop.");
  }
  const contextId = suppliedContextId || (agentSessionId
    ? createHmac(
        "sha256",
        Buffer.from(deriveHaloopSessionHmacKey(profile), "hex"),
      )
        .update("openrind-haloop-conversation-v1\0", "utf8")
        .update(agentSessionId, "utf8")
        .digest("hex")
        .slice(0, 32)
    : randomBytes(16).toString("hex"));
  if (!HALOOP_CONTEXT_ID_PATTERN.test(contextId)) {
    throw new Error("The Haloop conversation context id is invalid.");
  }
  const issuedAtMs = Number(options.issuedAtMs ?? Date.now());
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
    throw new Error("The Haloop conversation issue time is invalid.");
  }
  const expiresAtMs = issuedAtMs + HALOOP_SESSION_ASSERTION_TTL_MS;
  const profileId = requiredSecret(profile.id, "Haloop profile id");
  const signed = `v1\n${profileId}\n${contextId}\n${issuedAtMs}\n${expiresAtMs}`;
  const signature = createHmac(
    "sha256",
    Buffer.from(deriveHaloopSessionHmacKey(profile), "hex"),
  ).update(signed, "utf8").digest("hex");
  return {
    contextId,
    assertion: `v1.${contextId}.${issuedAtMs}.${expiresAtMs}.${signature}`,
    expiresAtMs,
    capture: buildHaloopCaptureIdentity(profile, contextId),
  };
}

export function buildHaloopProfilesDocument(
  profiles,
  anthropicApiKey,
  { env = process.env } = {},
) {
  const upstream = resolveHaloopUpstream(anthropicApiKey, env);
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error("At least one scoped Haloop client profile is required.");
  }
  return {
    version: 1,
    profiles: profiles.map((profile) => {
      const project = (profile.sandboxName && String(profile.sandboxName).trim()) || haloopProjectForWorkspace(profile.workspaceId);
      return {
        id: profile.id,
        client_token_sha256: createHash("sha256")
          .update(requiredSecret(profile.clientToken, "Haloop client token"), "utf8")
          .digest("hex"),
        config: {
          provider: "anthropic",
          api_key: upstream.apiKey,
          // TEMPORARY OPENROUTER TEST WORKAROUND: remove these two fields and
          // the matching env-gated resolver after the live integration proof.
          ...(upstream.mode === "openrouter-test"
            ? {
                custom_host: HALOOP_TEMPORARY_OPENROUTER_BASE_URL,
                override_params: { model: HALOOP_TEMPORARY_OPENROUTER_MODEL },
              }
            : {}),
          input_guardrails: [
            {
              "halo.mark": { collectorURL: HALOOP_COLLECTOR_URL },
              async: false,
              deny: false,
            },
          ],
          output_guardrails: [
            {
              "halo.export": {
                collectorURL: HALOOP_COLLECTOR_URL,
                defaultProject: project,
              },
              async: false,
              deny: false,
            },
          ],
        },
        project,
        session_hmac_key: deriveHaloopSessionHmacKey(profile),
        session_id_prefix: requiredSecret(profile.agentId, "Haloop agent id"),
      };
    }),
  };
}

function clippedString(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeCaptureValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return clippedString(value, 4_096);
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => sanitizeCaptureValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [rawKey, entry] of Object.entries(value).slice(0, 64)) {
      const key = clippedString(rawKey, 128);
      if (!key) continue;
      if (/(?:authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = sanitizeCaptureValue(entry, depth + 1);
      }
    }
    return output;
  }
  return clippedString(value, 4_096);
}

export function buildTrustedHaloopAppSpan(capture, event) {
  if (!capture || !TRACE_ID_PATTERN.test(String(capture.traceId ?? ""))) {
    throw new Error("A trusted canonical Haloop trace identity is required.");
  }
  if (!SPAN_ID_PATTERN.test(String(capture.rootSpanId ?? ""))) {
    throw new Error("A trusted canonical Haloop root span identity is required.");
  }
  const kind = String(event?.kind ?? "").toUpperCase();
  if (!APP_SPAN_KINDS.has(kind)) {
    throw new Error("Desktop capture accepts AGENT, TOOL, and CHAIN spans only.");
  }
  const eventId = clippedString(event?.eventId, 256);
  if (!eventId) throw new Error("A stable Desktop capture eventId is required.");
  const name = clippedString(event?.name || kind.toLowerCase(), 256);
  const startMs = Number(event?.startMs);
  const endMs = Number(event?.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error("Desktop capture startMs/endMs must be a valid ordered interval.");
  }
  const parentSpanId =
    event.parentSpanId === ""
      ? ""
      : String(event.parentSpanId || capture.rootSpanId);
  if (parentSpanId && !SPAN_ID_PATTERN.test(parentSpanId)) {
    throw new Error("Desktop capture parentSpanId must be canonical.");
  }
  const attributes = {};
  for (const [key, value] of Object.entries(event.attributes || {}).slice(0, 64)) {
    if (/^openrind\.[a-z0-9_.-]{1,96}$/i.test(key)) {
      attributes[key] = sanitizeCaptureValue(value);
    }
  }
  const payload = {
    kind,
    name,
    project: capture.project,
    trace_id: capture.traceId,
    span_id:
      eventId === "route-root"
        ? capture.rootSpanId
        : stableHex("desktop-span", capture.profileId, eventId).slice(0, 16),
    parent_span_id: parentSpanId,
    session_id: capture.sessionId,
    start: startMs / 1_000,
    end: endMs / 1_000,
    ok: event.ok !== false,
    status_message: clippedString(event.statusMessage, 500),
    service_name: "openrind-desktop",
    attributes,
  };
  if (event.input !== undefined) payload.input = sanitizeCaptureValue(event.input);
  if (event.output !== undefined) payload.output = sanitizeCaptureValue(event.output);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_APP_SPAN_BYTES) {
    throw new Error(`A Desktop capture span exceeds ${MAX_APP_SPAN_BYTES} bytes.`);
  }
  return payload;
}

export function buildHaloopAgentLifecycleEvent(agent, event) {
  const agentId = String(agent ?? "").trim();
  if (agentId !== "claude" && agentId !== "openclaw" && agentId !== "openhands") {
    throw new Error("OPENRIND_SHELL_AGENT must be claude, openclaw, or openhands for Haloop lifecycle capture.");
  }
  const cause = String(event?.terminationCause || "process-exit");
  const lifecycle =
    cause === "desktop-close"
      ? "cancelled"
      : cause === "sandbox-delete"
        ? "sandbox-deleted"
        : cause === "app-shutdown"
          ? "app-shutdown"
          : event?.exitCode === 0
            ? "completed"
            : "crashed";
  const statusMessage =
    lifecycle === "completed"
      ? ""
      : lifecycle === "cancelled"
        ? "Agent session was cancelled by Desktop."
        : lifecycle === "sandbox-deleted"
          ? "Agent session ended because its sandbox was deleted."
          : lifecycle === "app-shutdown"
            ? "Agent session ended during Desktop shutdown."
            : `Agent process exited with code ${event?.exitCode ?? "unknown"}.`;
  return {
    kind: "AGENT",
    eventId: `pty:${requiredSecret(event?.id, "PTY lifecycle id")}`,
    name: `${agentId}.session`,
    startMs: event?.openedAt,
    endMs: event?.endedAt,
    ok: lifecycle === "completed",
    statusMessage,
    attributes: {
      "openrind.agent.id": agentId,
      "openrind.lifecycle": lifecycle,
      "openrind.termination.cause": cause,
      "openrind.exit.code": event?.exitCode,
      "openrind.exit.signal": event?.signal,
      "openrind.close.requested_at_ms": event?.closeRequestedAt,
    },
  };
}

async function postPrivateCollectorSpans(run, spans) {
  const serialized = JSON.stringify(spans);
  if (Buffer.byteLength(serialized, "utf8") > MAX_APP_BATCH_BYTES) {
    throw new Error(`A Desktop capture batch exceeds ${MAX_APP_BATCH_BYTES} bytes.`);
  }
  const postScript = [
    "import sys,urllib.request",
    `b=sys.stdin.buffer.read(${MAX_APP_BATCH_BYTES + 1})`,
    `assert len(b)<=${MAX_APP_BATCH_BYTES},'capture batch too large'`,
    "q=urllib.request.Request('http://127.0.0.1:8788/spans',data=b,headers={'content-type':'application/json'},method='POST')",
    "r=urllib.request.urlopen(q,timeout=10)",
    "sys.stdout.write(r.read().decode('utf-8'))",
  ].join(";");
  const result = await run(
    dockerArgs(
      "exec",
      "-i",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "python",
      "-c",
      postScript,
    ),
    { stdin: serialized, timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `The private Haloop collector rejected Desktop capture: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error("The private Haloop collector returned an invalid capture response.");
  }
  if (!Array.isArray(response.errors) || response.errors.length > 0) {
    throw new Error("The private Haloop collector reported an invalid Desktop span.");
  }
  return {
    written: Number(response.written) || 0,
    duplicates: Number(response.duplicates) || 0,
  };
}

async function requestPrivateCollector(run, { method = "GET", requestPath, body = null, timeoutMs = undefined }) {
  const normalizedMethod = String(method).toUpperCase();
  if (!new Set(["GET", "POST"]).has(normalizedMethod)) {
    throw new Error("The private Haloop collector request method is invalid.");
  }
  const allowedRequest =
    (normalizedMethod === "GET" &&
      /^\/(?:stats\?project=[A-Za-z0-9._-]+|halo\/runs(?:\/[0-9a-f]{12}(?:\?report=true)?)?|evals\/artifacts(?:\/[0-9a-f]{12}\/preview)?\?project=[A-Za-z0-9._-]+)$/.test(
        requestPath,
      )) ||
    (normalizedMethod === "POST" &&
      /^\/(?:halo\/analyze|evals\/extract|diagnostics\/(?:route|revoke))$/.test(requestPath));
  if (!allowedRequest) {
    throw new Error("The private Haloop collector request path is invalid.");
  }
  const requestScript = [
    "import json,sys,urllib.error,urllib.request",
    `limit=${MAX_COLLECTOR_RESPONSE_BYTES}`,
    "request=json.load(sys.stdin)",
    "payload=None if request['body'] is None else json.dumps(request['body'],separators=(',',':')).encode('utf-8')",
    "headers={'content-type':'application/json'} if payload is not None else {}",
    "query=urllib.request.Request('http://127.0.0.1:8788'+request['path'],data=payload,headers=headers,method=request['method'])",
    `try:\n response=urllib.request.urlopen(query,timeout=${timeoutMs === 3000 ? 2 : 15})\nexcept urllib.error.HTTPError as error:\n response=error`,
    "raw=response.read(limit+1)",
    "assert len(raw)<=limit,'collector response too large'",
    "decoded={} if request['path'].startswith('/diagnostics/') and response.status!=200 else json.loads(raw.decode('utf-8'))",
    "sys.stdout.write(json.dumps({'status':response.status,'body':decoded},separators=(',',':'))) ",
  ].join("\n");
  const result = await run(
    dockerArgs(
      "exec",
      "-i",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "python",
      "-c",
      requestScript,
    ),
    {
      stdin: JSON.stringify({ method: normalizedMethod, path: requestPath, body }),
      timeout: timeoutMs === 3000 ? 3000 : normalizedMethod === "POST" ? 30_000 : 20_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `The private Haloop collector request failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  try {
    const response = JSON.parse(result.stdout);
    if (!Number.isInteger(response.status) || !response.body || typeof response.body !== "object") {
      throw new Error("invalid response envelope");
    }
    return response;
  } catch {
    throw new Error("The private Haloop collector returned an invalid control response.");
  }
}

async function validateHaloopTraceProject(run, project) {
  if (!HALOOP_PROJECT_PATTERN.test(project)) {
    throw new Error("The active Haloop trace project is invalid.");
  }
  const validationScript = [
    "import contextlib,io,json,os,sys",
    "from services.collector.store import TraceStore",
    "from services.collector.trace_validation import verify",
    "project=json.load(sys.stdin)['project']",
    "path=TraceStore(os.environ['W8_DATA_DIR']).trace_path(project)",
    "result={'valid':False,'spans':0,'reason':'missing'}",
    "if path.is_file() and not path.is_symlink():\n try:\n  with contextlib.redirect_stdout(io.StringIO()): count=verify(str(path))\n  result={'valid':count>0,'spans':count,'reason':None if count>0 else 'empty'}\n except (AssertionError,ValueError,KeyError,json.JSONDecodeError):\n  result={'valid':False,'spans':0,'reason':'invalid'}",
    "sys.stdout.write(json.dumps(result,separators=(',',':')))",
  ].join("\n");
  const result = await run(
    dockerArgs(
      "exec",
      "-i",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "python",
      "-c",
      validationScript,
    ),
    { stdin: JSON.stringify({ project }), timeout: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Haloop trace validation could not run: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  try {
    const validation = JSON.parse(result.stdout);
    return {
      valid: validation.valid === true,
      spans: Number(validation.spans) || 0,
      reason: typeof validation.reason === "string" ? validation.reason : null,
    };
  } catch {
    throw new Error("Haloop trace validation returned an invalid result.");
  }
}

async function validateHaloopReportCitations(run, project, report) {
  if (!HALOOP_PROJECT_PATTERN.test(project)) {
    throw new Error("The active Haloop trace project is invalid.");
  }
  if (typeof report !== "string" || Buffer.byteLength(report, "utf8") > MAX_HALOOP_REPORT_BYTES) {
    throw new Error("The HALO report exceeds the safe Desktop display limit.");
  }
  const validationScript = [
    "import json,os,re,sys",
    "from services.collector.store import TraceStore",
    "request=json.load(sys.stdin)",
    "path=TraceStore(os.environ['W8_DATA_DIR']).trace_path(request['project'])",
    "allowed_traces=set(); allowed_spans=set()",
    "with path.open('rt',encoding='utf-8') as handle:\n for raw in handle:\n  if raw.strip():\n   span=json.loads(raw)\n   allowed_traces.add(str(span.get('trace_id') or '').lower())\n   allowed_spans.add(str(span.get('span_id') or '').lower())",
    "cited_traces={value.lower() for value in re.findall(r'(?i)\\btrace[_ -]?id\\b[^0-9a-f]{0,16}([0-9a-f]{32})\\b',request['report'])}",
    "cited_spans={value.lower() for value in re.findall(r'(?i)\\bspan[_ -]?id\\b[^0-9a-f]{0,16}([0-9a-f]{16})\\b',request['report'])}",
    "missing_traces=cited_traces-allowed_traces; missing_spans=cited_spans-allowed_spans",
    "result={'valid':bool(cited_traces) and not missing_traces and not missing_spans,'trace_citations':len(cited_traces),'span_citations':len(cited_spans),'missing':len(missing_traces)+len(missing_spans)}",
    "sys.stdout.write(json.dumps(result,separators=(',',':')))",
  ].join("\n");
  const result = await run(
    dockerArgs(
      "exec",
      "-i",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "python",
      "-c",
      validationScript,
    ),
    { stdin: JSON.stringify({ project, report }), timeout: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `HALO citation validation could not run: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  try {
    const validation = JSON.parse(result.stdout);
    return {
      valid: validation.valid === true,
      traceCitations: Number(validation.trace_citations) || 0,
      spanCitations: Number(validation.span_citations) || 0,
      missing: Number(validation.missing) || 0,
    };
  } catch {
    throw new Error("HALO citation validation returned an invalid result.");
  }
}

function normalizeHaloopEvalArtifact(payload, project, runId) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.project !== project ||
    payload.halo_run_id !== runId ||
    !HALOOP_EVAL_ARTIFACT_PATTERN.test(payload.artifact_id) ||
    !Number.isInteger(payload.cases) ||
    payload.cases < 1 ||
    payload.cases > 5000 ||
    payload.replay_surface !== "chat-completions" ||
    payload.contains_sensitive_content !== true
  ) {
    throw new Error("The private Haloop collector returned an invalid eval artifact summary.");
  }
  const identities = (value) =>
    Array.isArray(value)
      ? value
          .filter((entry) => typeof entry === "string" && entry.length > 0)
          .slice(0, 32)
          .map((entry) => safeDiagnosticMessage(entry).slice(0, 128))
      : [];
  const byTag = {};
  if (payload.by_tag && typeof payload.by_tag === "object" && !Array.isArray(payload.by_tag)) {
    for (const [key, value] of Object.entries(payload.by_tag).slice(0, 64)) {
      if (/^[a-z0-9:_-]{1,64}$/i.test(key) && Number.isInteger(value) && value >= 0) {
        byTag[key] = value;
      }
    }
  }
  return {
    artifactId: payload.artifact_id,
    haloRunId: runId,
    createdAt: Number(payload.created_at) || null,
    cases: payload.cases,
    byTag,
    sourceProviders: identities(payload.source_providers),
    sourceModels: identities(payload.source_models),
    sourceSurfaces: identities(payload.source_surfaces),
    replaySurface: "chat-completions",
    containsSensitiveContent: true,
  };
}

function normalizeHaloopEvalPreview(payload, project, runId, artifact) {
  const cases = Array.isArray(payload?.cases) ? payload.cases : null;
  const encodedCases = cases ? JSON.stringify(cases) : "";
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.project !== project ||
    payload.halo_run_id !== runId ||
    payload.artifact_id !== artifact.artifactId ||
    payload.total_cases !== artifact.cases ||
    !Number.isInteger(payload.shown_cases) ||
    payload.shown_cases < 1 ||
    payload.shown_cases > 100 ||
    payload.shown_cases !== cases?.length ||
    payload.truncated !== (payload.shown_cases < payload.total_cases) ||
    payload.contains_sensitive_content !== true ||
    Buffer.byteLength(encodedCases, "utf8") > MAX_HALOOP_EVAL_PREVIEW_BYTES ||
    cases.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
  ) {
    throw new Error("The private Haloop collector returned an invalid eval preview.");
  }
  return {
    artifactId: artifact.artifactId,
    haloRunId: runId,
    totalCases: artifact.cases,
    shownCases: payload.shown_cases,
    truncated: payload.truncated,
    containsSensitiveContent: true,
    cases: JSON.parse(encodedCases),
  };
}

async function copyPrivateCollectorEvalArtifact(run, { artifactId, destinationPath }) {
  if (!HALOOP_EVAL_ARTIFACT_PATTERN.test(artifactId)) {
    throw new Error("The Haloop eval artifact identity is invalid.");
  }
  const normalizedDestination = String(destinationPath ?? "");
  if (
    normalizedDestination.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(normalizedDestination) ||
    !/^\/mnt\/[a-z]\/.+/i.test(normalizedDestination) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(normalizedDestination)
  ) {
    throw new Error("The selected eval download destination is invalid.");
  }
  const result = await run(
    dockerArgs(
      "cp",
      `${HALOOP_COLLECTOR_CONTAINER_NAME}:${HALOOP_COLLECTOR_CONTAINER_REPORTS_DIR}/${artifactId}`,
      normalizedDestination,
    ),
    { timeout: 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error("The private Haloop eval artifact could not be downloaded.");
  }
}

async function pruneHaloopReports(run) {
  const retentionScript = [
    "import json,os,time",
    "from pathlib import Path",
    `days=${HALOOP_REPORT_RETENTION_DAYS}; keep=${HALOOP_REPORT_RETENTION_COUNT}`,
    "root=Path(os.environ['W8_REPORTS_DIR']).resolve()",
    "files=sorted((path for pattern in ('halo-report-*.md','eval-cases-*.jsonl') for path in root.glob(pattern) if path.is_file() and not path.is_symlink()),key=lambda path:path.stat().st_mtime,reverse=True)",
    "cutoff=time.time()-days*86400; removed=0",
    "for index,path in enumerate(files):\n if index>=keep or path.stat().st_mtime<cutoff:\n  path.unlink(); removed+=1",
    "print(json.dumps({'removed':removed},separators=(',',':')))",
  ].join("\n");
  const result = await run(
    dockerArgs("exec", HALOOP_COLLECTOR_CONTAINER_NAME, "python", "-c", retentionScript),
    { timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error("HALO report retention cleanup failed; analysis was not started.");
  }
}

function dockerArgs(...args) {
  return ["-d", DISTRO_NAME, "--", "docker", ...args];
}

async function inspectImage(run, image, contractLabel) {
  return run(
    dockerArgs(
      "image",
      "inspect",
      image,
      "--format",
      `{{ index .Config.Labels "${contractLabel}" }}|{{ index .Config.Labels "com.openrind.desktop.haloop-version" }}|{{.Id}}`,
    ),
    { timeout: 20_000 },
  );
}

async function requireImage(run, { image, contract, contractLabel, service }) {
  let result = await inspectImage(run, image, contractLabel);
  if (
    HALOOP_IMAGE_PULL_POLICY === "always" ||
    (result.exitCode !== 0 && HALOOP_IMAGE_PULL_POLICY === "missing")
  ) {
    const pulled = await run(
      dockerArgs("image", "pull", image),
      { timeout: 5 * 60_000 },
    );
    if (pulled.exitCode !== 0) {
      throw new Error(
        `Could not pull the pinned Haloop ${service} image ${image}: ${(pulled.stderr || pulled.stdout).trim() || `exit ${pulled.exitCode}`}`,
      );
    }
    result = await inspectImage(run, image, contractLabel);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `The required Haloop ${service} image ${image} is not present in the dedicated OpenShell WSL Docker daemon. Build the source-checkout images or make the pinned production image available, then retry.`,
    );
  }
  const [actualContract, version, imageId] = result.stdout.trim().split("|");
  if (actualContract !== contract) {
    throw new Error(
      `The Haloop ${service} image ${image} is incompatible (expected contract ${contract}). Rebuild the pinned Haloop images, then retry.`,
    );
  }
  if (!version || !IMAGE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `The Haloop ${service} image ${image} has an invalid diagnostic version label. Rebuild the pinned Haloop images, then retry.`,
    );
  }
  return { contract: actualContract, version, imageId };
}

async function requireHaloopImages(run) {
  const gateway = await requireImage(run, {
    image: HALOOP_IMAGE,
    contract: HALOOP_IMAGE_CONTRACT,
    contractLabel: "com.openrind.desktop.haloop-contract",
    service: "gateway",
  });
  const collector = await requireImage(run, {
    image: HALOOP_COLLECTOR_IMAGE,
    contract: HALOOP_COLLECTOR_IMAGE_CONTRACT,
    contractLabel: "com.openrind.desktop.haloop-collector-contract",
    service: "collector",
  });
  if (gateway.version !== collector.version) {
    throw new Error(
      `The Haloop gateway and collector image versions do not match (${gateway.version} versus ${collector.version}). Rebuild both pinned images together, then retry.`,
    );
  }
  if (
    HALOOP_IMAGE === HALOOP_PACKAGED_IMAGE &&
    HALOOP_COLLECTOR_IMAGE === HALOOP_PACKAGED_COLLECTOR_IMAGE &&
    gateway.version !== HALOOP_IMAGE_VERSION
  ) {
    throw new Error(
      `The packaged Haloop images report ${gateway.version}; expected the pinned version ${HALOOP_IMAGE_VERSION}.`,
    );
  }
  return { gateway, collector };
}

async function stageProfiles(run, serialized) {
  const script = [
    "set -euo pipefail",
    "umask 077",
    `install -d -m 0700 ${HALOOP_STATE_DIR}`,
    `install -d -o 10001 -g 10001 -m 0700 ${HALOOP_COLLECTOR_DATA_DIR}`,
    `install -d -o 10001 -g 10001 -m 0700 ${HALOOP_REPORTS_DIR}`,
    `install -m 0600 /dev/stdin ${HALOOP_PROFILES_FILE}.tmp`,
    `mv -f ${HALOOP_PROFILES_FILE}.tmp ${HALOOP_PROFILES_FILE}`,
  ].join("\n");
  const result = await run(
    ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
    { stdin: serialized, timeout: 20_000, user: "root" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not stage the Haloop route-profile registry: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function stageAnalysisEnvironment(run, serialized) {
  const script = [
    "set -euo pipefail",
    "umask 077",
    `install -d -m 0700 ${HALOOP_STATE_DIR}`,
    `install -m 0600 /dev/stdin ${HALOOP_ANALYSIS_ENV_FILE}.tmp`,
    `mv -f ${HALOOP_ANALYSIS_ENV_FILE}.tmp ${HALOOP_ANALYSIS_ENV_FILE}`,
  ].join("\n");
  const result = await run(
    ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
    { stdin: serialized, timeout: 20_000, user: "root" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not stage the private HALO analysis credential: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function inspectContainer(run, name) {
  const result = await run(
    dockerArgs(
      "container",
      "inspect",
      name,
      "--format",
      `{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{ index .Config.Labels "${PROFILE_HASH_LABEL}" }}|{{.Image}}|{{ index .Config.Labels "${MANAGED_LABEL}" }}|{{ index .Config.Labels "${COLLECTOR_ANALYSIS_LABEL}" }}|{{ index .Config.Labels "${COLLECTOR_ANALYSIS_CONFIG_HASH_LABEL}" }}`,
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  const [running, health, profileHash, imageId, managed, analysisContract, analysisConfigHash] =
    result.stdout.trim().split("|");
  return {
    running: running === "true",
    health,
    profileHash,
    imageId,
    managed: managed === "true",
    analysisContract: analysisContract || null,
    analysisConfigHash: analysisConfigHash || null,
  };
}

async function removeManagedContainer(run, name, service) {
  const result = await run(
    dockerArgs("container", "rm", "--force", name),
    { timeout: 60_000 },
  );
  if (result.exitCode !== 0 && !/no such container/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(
      `Could not replace the managed Haloop ${service} container: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function inspectNetwork(run) {
  const result = await run(
    dockerArgs(
      "network",
      "inspect",
      HALOOP_NETWORK_NAME,
      "--format",
      `{{ index .Labels "${MANAGED_NETWORK_LABEL}" }}`,
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  return { managed: result.stdout.trim() === "true" };
}

async function ensureManagedNetwork(run) {
  const network = await inspectNetwork(run);
  if (network && !network.managed) {
    throw new Error(
      `A Docker network named ${HALOOP_NETWORK_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
    );
  }
  if (network) return;
  const result = await run(
    dockerArgs(
      "network",
      "create",
      "--label",
      `${MANAGED_NETWORK_LABEL}=true`,
      HALOOP_NETWORK_NAME,
    ),
    { timeout: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not create the private Haloop service network: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function resolveOpenShellBridgeAddress(run) {
  const result = await run(
    dockerArgs(
      "network",
      "inspect",
      OPENSHELL_SANDBOX_NETWORK_NAME,
      "--format",
      "{{json .IPAM.Config}}",
    ),
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not inspect the OpenShell sandbox network used by host.openshell.internal: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
  let configs;
  try {
    configs = JSON.parse(result.stdout.trim());
  } catch {
    configs = null;
  }
  const address = Array.isArray(configs)
    ? configs
        .map((config) => String(config?.Gateway ?? "").trim())
        .find((gateway) => {
          const octets = gateway.split(".");
          return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
        })
    : "";
  if (!address) {
    throw new Error(
      `The OpenShell sandbox network ${OPENSHELL_SANDBOX_NETWORK_NAME} does not expose the IPv4 bridge address required by host.openshell.internal.`,
    );
  }
  return address;
}

async function removeManagedNetwork(run) {
  const result = await run(
    dockerArgs("network", "rm", HALOOP_NETWORK_NAME),
    { timeout: 20_000 },
  );
  if (result.exitCode !== 0 && !/no such network|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(
      `Could not remove the private Haloop service network: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function createCollectorContainer(run, analysisConfigHash) {
  const result = await run(
    dockerArgs(
      "run",
      "--detach",
      "--name",
      HALOOP_COLLECTOR_CONTAINER_NAME,
      "--pull",
      HALOOP_IMAGE_PULL_POLICY,
      "--restart",
      "unless-stopped",
      "--init",
      "--network",
      HALOOP_NETWORK_NAME,
      "--memory",
      "1g",
      "--stop-timeout",
      String(SHUTDOWN_TIMEOUT_SECONDS),
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${COLLECTOR_ANALYSIS_LABEL}=${COLLECTOR_ANALYSIS_CONTRACT}`,
      "--label",
      `${COLLECTOR_ANALYSIS_CONFIG_HASH_LABEL}=${analysisConfigHash}`,
      "--mount",
      `type=bind,source=${HALOOP_COLLECTOR_DATA_DIR},target=${HALOOP_COLLECTOR_CONTAINER_DATA_DIR}`,
      "--mount",
      `type=bind,source=${HALOOP_REPORTS_DIR},target=${HALOOP_COLLECTOR_CONTAINER_REPORTS_DIR}`,
      "--env-file",
      HALOOP_ANALYSIS_ENV_FILE,
      "--env",
      `W8_DATA_DIR=${HALOOP_COLLECTOR_CONTAINER_DATA_DIR}`,
      "--env",
      `W8_REPORTS_DIR=${HALOOP_COLLECTOR_CONTAINER_REPORTS_DIR}`,
      "--env",
      "W8_DEFAULT_PROJECT=openrind-desktop",
      "--env",
      "W8_KEEP_RAW=0",
      HALOOP_COLLECTOR_IMAGE,
    ),
    // Docker's CLI opens --env-file before it contacts the daemon. The
    // analysis credential is deliberately root-owned and mode 0600, so run
    // only this container-creation command as root instead of weakening the
    // credential file or its parent directory permissions.
    { timeout: 60_000, user: "root" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not start the private Haloop collector: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
    );
  }
}

async function createGatewayContainer(run, profileHash) {
  const publishAddress = await resolveOpenShellBridgeAddress(run);
  const result = await run(
    dockerArgs(
      "run",
      "--detach",
      "--name",
      HALOOP_CONTAINER_NAME,
      "--pull",
      HALOOP_IMAGE_PULL_POLICY,
      "--restart",
      "unless-stopped",
      "--init",
      "--network",
      HALOOP_NETWORK_NAME,
      "--memory",
      "2g",
      "--stop-timeout",
      String(SHUTDOWN_TIMEOUT_SECONDS),
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${PROFILE_HASH_LABEL}=${profileHash}`,
      "--publish",
      `${publishAddress}:${HALOOP_EDGE_PORT}:${HALOOP_EDGE_PORT}`,
      "--mount",
      `type=bind,source=${HALOOP_PROFILES_FILE},target=${HALOOP_CONTAINER_PROFILES_FILE},readonly`,
      "--env",
      `W8_OPENRIND_PROFILES_FILE=${HALOOP_CONTAINER_PROFILES_FILE}`,
      "--env",
      "W8_EDGE_HOST=0.0.0.0",
      "--env",
      `W8_EDGE_PORT=${HALOOP_EDGE_PORT}`,
      "--env",
      "W8_CORE_HOST=127.0.0.1",
      "--env",
      "W8_CORE_PORT=8786",
      "--env",
      "W8_CORE_URL=http://127.0.0.1:8786",
      "--env",
      "W8_SHUTDOWN_TIMEOUT_MS=30000",
      HALOOP_IMAGE,
    ),
    { timeout: 60_000 },
  );
  if (result.exitCode === 0) return;
  const detail = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
  if (/port is already allocated|address already in use|bind.*8787/i.test(detail)) {
    throw new Error(
      `Haloop cannot start because port ${HALOOP_EDGE_PORT} is already in use. Stop the conflicting service and retry; Openrind Desktop will not select a different endpoint.`,
    );
  }
  throw new Error(`Could not start the managed Haloop container: ${detail}`);
}

async function waitForHealthyContainer(run, name, service) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastHealth = "unknown";
  while (Date.now() < deadline) {
    const info = await inspectContainer(run, name);
    lastHealth = info?.health || (info?.running ? "starting" : "stopped");
    if (info?.running && info.health === "healthy") return info;
    if (info && !info.running) break;
    await delay(500);
  }
  throw new Error(
    `The managed Haloop ${service} did not become healthy within ${STARTUP_TIMEOUT_MS / 1000} seconds (last state: ${lastHealth}).`,
  );
}

async function requireCollectorFromGateway(run) {
  const probe = [
    `fetch('${HALOOP_COLLECTOR_URL}/healthz')`,
    ".then(async r=>{const j=await r.json().catch(()=>null);if(!r.ok||j?.status!=='ok'){console.error('unexpected collector response');process.exit(1)}})",
    ".catch(e=>{console.error(e.message);process.exit(1)})",
  ].join("");
  const result = await run(
    dockerArgs("exec", HALOOP_CONTAINER_NAME, "node", "-e", probe),
    { timeout: 15_000 },
  );
  if (result.exitCode === 0) return;
  throw new Error(
    "The Haloop gateway cannot reach its private collector. Sandbox creation is blocked.",
  );
}

async function requireAuthenticatedEdge(run) {
  // Check the edge agents actually use, not an unrelated healthy local container.
  const endpoint = new URL(HALOOP_SANDBOX_ENDPOINT);
  if (endpoint.hostname === "host.openshell.internal") endpoint.hostname = "127.0.0.1";
  endpoint.pathname = "/v1/messages";
  const probe = [
    `fetch(${JSON.stringify(endpoint.href)},`,
    "{method:'POST',headers:{'content-type':'application/json'},body:'{\"model\":\"claude-3-5-sonnet-20241022\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'})",
    ".then(r=>{if(r.status!==401 && r.status!==403 && r.status!==400){console.error('unexpected status '+r.status);process.exit(1)}})",
    ".catch(e=>{console.error(e.message);process.exit(1)})",
  ].join("");
  const result = await run(
    dockerArgs("exec", HALOOP_CONTAINER_NAME, "node", "-e", probe),
    { timeout: 15_000 },
  );
  if (result.exitCode === 0) return;
  throw new Error(
    `The configured Haloop edge at ${endpoint.origin} failed its authentication check. Configure Desktop scoped client profiles and signed-session validation on that gateway before launching a sandbox.`,
  );
}

export function createHaloopRuntimeManager({
  run = wslRun,
  ensureDistro = ensureDistroRunning,
  registerProfile = registerHaloopClientProfile,
  revokeAllProfiles = revokeAllHaloopClientProfiles,
  revokeProfiles = revokeHaloopClientProfilesForSandbox,
  rotateProfile = rotateHaloopClientProfile,
  postSpans = postPrivateCollectorSpans,
  collectorRequest = requestPrivateCollector,
  validateTraceProject = validateHaloopTraceProject,
  validateReportCitations = validateHaloopReportCitations,
  pruneReports = pruneHaloopReports,
  copyEvalArtifact = copyPrivateCollectorEvalArtifact,
  env = process.env,
} = {}) {
  let queue = Promise.resolve();
  let managedThisProcess = false;
  let lastReadyRoute = null;

  async function persistReadyRoute(route) {
    const result = await run(["-d", DISTRO_NAME, "--", "sh", "-c",
      `umask 077; cat > ${HALOOP_READY_ROUTE_FILE}.tmp && mv ${HALOOP_READY_ROUTE_FILE}.tmp ${HALOOP_READY_ROUTE_FILE}`],
      { stdin: JSON.stringify(route), timeout: 10_000, user: "root" });
    if (result.exitCode !== 0) throw new Error("Could not persist the ready Haloop route.");
  }

  async function recoverReadyRoute(gateway) {
    if (lastReadyRoute || !gateway?.managed) return;
    const result = await run(["-d", DISTRO_NAME, "--", "cat", HALOOP_READY_ROUTE_FILE],
      { timeout: 10_000, user: "root" }).catch(() => null);
    try {
      const route = JSON.parse(result?.stdout || "null");
      if (!route || route.gatewayProfileHash !== gateway.profileHash) return;
      const identity = resolveHaloopClientProfileIdentity(route);
      if (identity.id !== route.profileId || identity.providerName !== route.providerName) return;
      lastReadyRoute = route;
      lastAnalysisProject = (route.sandboxName && String(route.sandboxName).trim()) || haloopProjectForWorkspace(route.workspaceId);
      managedThisProcess = true;
    } catch { /* Missing or stale metadata must not invent an active route. */ }
  }
  // Analysis artifacts outlive the renderer route and may outlive the main
  // process. Keep their project separate from the currently serving route;
  // a fresh process can recover it from the collector's durable run index.
  let lastAnalysisProject = null;
  // Completed historical runs stay durable, but the live panel selects only a
  // run explicitly started by this Desktop process. An unfinished run may be
  // recovered after a process restart so it remains observable, never started.
  const selectedAnalysisRunIds = new Map();
  let lastConnectionError = null;
  const capturedBytesByTrace = new Map();
  const analysisAudits = new Map();

  function publicRouteIdentity(route) {
    if (!route) return null;
    return {
      profileId: route.profileId,
      providerName: route.providerName,
      sandboxName: route.sandboxName,
      workspaceId: route.workspaceId,
      agentId: route.agentId,
    };
  }
  const captureStatus = {
    written: 0,
    duplicates: 0,
    dropped: 0,
    redacted: 0,
    incomplete: 0,
    lastError: null,
    lastAttemptAt: null,
  };

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function serialize(operation) {
    const current = queue.then(() => operation(), () => operation());
    queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async function writeTrustedSpans(capture, events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("At least one trusted Desktop capture event is required.");
    }
    if (events.length > MAX_APP_SPANS_PER_BATCH) {
      throw new Error(`A Desktop capture batch exceeds ${MAX_APP_SPANS_PER_BATCH} spans.`);
    }
    const spans = events.map((event) => buildTrustedHaloopAppSpan(capture, event));
    const encoded = JSON.stringify(spans);
    const bytes = Buffer.byteLength(encoded, "utf8");
    const redacted = (encoded.match(/\[(?:REDACTED|TRUNCATED)\]/g) || []).length;
    const captured = capturedBytesByTrace.get(capture.traceId) || 0;
    if (captured + bytes > MAX_APP_CAPTURE_BYTES_PER_TRACE) {
      throw new Error(
        `Desktop capture reached its ${MAX_APP_CAPTURE_BYTES_PER_TRACE}-byte trace limit.`,
      );
    }
    const result = await postSpans(run, spans);
    capturedBytesByTrace.set(
      capture.traceId,
      captured + (result.written > 0 ? bytes : 0),
    );
    captureStatus.written += result.written;
    captureStatus.duplicates += result.duplicates;
    captureStatus.redacted += redacted;
    captureStatus.lastError = null;
    captureStatus.lastAttemptAt = Date.now();
    return result;
  }

  function recordApplicationSpans(capture, events) {
    return serialize(async () => {
      try {
        const result = await writeTrustedSpans(capture, events);
        return { ok: true, ...result };
      } catch (error) {
        captureStatus.dropped += Array.isArray(events) ? events.length : 1;
        captureStatus.incomplete += Array.isArray(events) ? events.length : 1;
        captureStatus.lastError = safeDiagnosticMessage(error);
        captureStatus.lastAttemptAt = Date.now();
        // Capture is deliberately fail-open after a route has begun serving.
        return { ok: false, written: 0, duplicates: 0, error: captureStatus.lastError };
      }
    });
  }

  async function discoverAnalysisProject() {
    if (lastReadyRoute?.sandboxName && String(lastReadyRoute.sandboxName).trim()) {
      lastAnalysisProject = String(lastReadyRoute.sandboxName).trim();
      return lastAnalysisProject;
    }
    if (lastReadyRoute?.workspaceId) {
      lastAnalysisProject = haloopProjectForWorkspace(lastReadyRoute.workspaceId);
      return lastAnalysisProject;
    }
    if (HALOOP_PROJECT_PATTERN.test(String(lastAnalysisProject ?? ""))) {
      return lastAnalysisProject;
    }
    let response;
    try {
      response = await collectorRequest(run, { requestPath: "/halo/runs" });
    } catch {
      return null;
    }
    if (response.status !== 200 || !Array.isArray(response.body?.runs)) return null;
    const recovered = response.body.runs
      .filter((entry) => HALOOP_PROJECT_PATTERN.test(String(entry?.project ?? "")))
      .sort((left, right) =>
        (Number(right?.finished_at) || Number(right?.started_at) || 0) -
        (Number(left?.finished_at) || Number(left?.started_at) || 0),
      )[0]?.project;
    if (!recovered) return null;
    lastAnalysisProject = recovered;
    return recovered;
  }

  async function requireAnalysisCollector() {
    const project = await discoverAnalysisProject();
    if (!project) {
      throw new Error(
        "Haloop has no active trace project. Launch a Claude or OpenClaw sandbox first.",
      );
    }
    const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
    if (!collector?.managed || !collector.running || collector.health !== "healthy") {
      throw new Error(
        "The private Haloop collector must be healthy before trace analysis can run.",
      );
    }
    if (collector.analysisContract !== COLLECTOR_ANALYSIS_CONTRACT) {
      throw new Error(
        "The private Haloop collector is not analysis-ready. Restart Haloop, then retry.",
      );
    }
    return { project };
  }

  async function readAuditedAnalysisReport(project, runId) {
    if (!HALOOP_RUN_ID_PATTERN.test(runId)) {
      throw new Error("The HALO analysis run identity is invalid.");
    }
    const response = await collectorRequest(run, {
      requestPath: `/halo/runs/${runId}?report=true`,
    });
    if (response.status !== 200) {
      throw new Error("The requested HALO analysis report is unavailable.");
    }
    const payload = response.body;
    if (payload.project !== project || payload.run_id !== runId || payload.status !== "done") {
      throw new Error("The HALO analysis report does not belong to the active trace project.");
    }
    if (typeof payload.report !== "string") {
      throw new Error("The HALO analysis report is not ready yet.");
    }
    const citations = await validateReportCitations(run, project, payload.report);
    if (!citations.valid) {
      throw new Error(
        citations.missing > 0
          ? "The HALO report cited trace evidence outside the active project, so Desktop blocked it."
          : "The HALO report did not contain a verifiable trace_id, so Desktop blocked it.",
      );
    }
    return { runId, report: payload.report, citations };
  }

  async function analysisSnapshot() {
    const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
    const routeProject = (lastReadyRoute?.sandboxName && String(lastReadyRoute.sandboxName).trim())
      || (lastReadyRoute?.workspaceId ? haloopProjectForWorkspace(lastReadyRoute.workspaceId) : lastAnalysisProject);
    if (
      !collector?.managed ||
      !collector.running ||
      collector.health !== "healthy" ||
      collector.analysisContract !== COLLECTOR_ANALYSIS_CONTRACT
    ) {
      return {
        state: "unavailable",
        project: HALOOP_PROJECT_PATTERN.test(String(routeProject ?? ""))
          ? routeProject
          : null,
        detail: "Restart Haloop to make the private collector ready for analysis.",
        stats: null,
        run: null,
        evalArtifact: null,
        retention: {
          days: HALOOP_REPORT_RETENTION_DAYS,
          reports: HALOOP_REPORT_RETENTION_COUNT,
        },
      };
    }

    const project = await discoverAnalysisProject();
    if (!project) {
      return {
        state: "unavailable",
        project: null,
        detail: "Launch a Claude or OpenClaw sandbox to create a trace project.",
        stats: null,
        run: null,
        evalArtifact: null,
        retention: {
          days: HALOOP_REPORT_RETENTION_DAYS,
          reports: HALOOP_REPORT_RETENTION_COUNT,
        },
      };
    }

    const statsResponse = await collectorRequest(run, {
      requestPath: `/stats?project=${project}`,
    });
    if (statsResponse.status !== 200) {
      throw new Error("The private Haloop collector could not summarize the active trace project.");
    }
    const rawStats = statsResponse.body;
    const stats = {
      spans: Number(rawStats.spans) || 0,
      errors: Number(rawStats.errors) || 0,
      byObservationKind:
        rawStats.by_observation_kind && typeof rawStats.by_observation_kind === "object"
          ? rawStats.by_observation_kind
          : {},
      byModel:
        rawStats.by_model && typeof rawStats.by_model === "object" ? rawStats.by_model : {},
    };
    const runsResponse = await collectorRequest(run, { requestPath: "/halo/runs" });
    if (runsResponse.status !== 200 || !Array.isArray(runsResponse.body.runs)) {
      throw new Error("The private Haloop collector could not list HALO analysis runs.");
    }
    const projectRuns = runsResponse.body.runs.filter(
      (entry) => entry && entry.project === project && HALOOP_RUN_ID_PATTERN.test(entry.run_id),
    );
    let selectedRunId = selectedAnalysisRunIds.get(project) ?? null;
    if (!selectedRunId) {
      const unfinished = projectRuns.find(
        (entry) => entry.status === "created" || entry.status === "running",
      );
      if (unfinished) {
        selectedRunId = unfinished.run_id;
        selectedAnalysisRunIds.set(project, selectedRunId);
      }
    }
    const latest = projectRuns.find((entry) => entry.run_id === selectedRunId);
    if (!latest) {
      return {
        state: stats.spans > 0 ? "ready" : "no-traces",
        project,
        detail:
          stats.spans > 0
            ? "Validated trace analysis is ready to run."
            : "No captured spans are available yet. Use Claude or OpenClaw, then refresh.",
        stats,
        run: null,
        evalArtifact: null,
        retention: {
          days: HALOOP_REPORT_RETENTION_DAYS,
          reports: HALOOP_REPORT_RETENTION_COUNT,
        },
      };
    }

    const knownRunStates = new Set(["created", "running", "done", "error"]);
    let state = latest.status === "created"
      ? "queued"
      : knownRunStates.has(latest.status)
        ? latest.status
        : "error";
    let detail =
      state === "queued" || state === "running"
        ? "HALO is analyzing the validated trace project. This can take several minutes."
        : state === "done"
          ? "HALO analysis completed."
          : "HALO analysis failed. Inspect the managed collector logs for sanitized diagnostics.";
    let citations = analysisAudits.get(latest.run_id) ?? null;
    if (state === "done" && latest.report_available === true && !citations) {
      try {
        const audited = await readAuditedAnalysisReport(project, latest.run_id);
        citations = audited.citations;
        analysisAudits.set(latest.run_id, citations);
        detail = "HALO analysis completed and all report citations match the active trace project.";
      } catch (error) {
        state = "error";
        detail = safeDiagnosticMessage(error);
        citations = { valid: false, traceCitations: 0, spanCitations: 0, missing: 0 };
      }
    }
    let evalArtifact = null;
    if (state === "done" && citations?.valid) {
      const artifactsResponse = await collectorRequest(run, {
        requestPath: `/evals/artifacts?project=${project}`,
      });
      if (
        artifactsResponse.status !== 200 ||
        !Array.isArray(artifactsResponse.body.artifacts)
      ) {
        throw new Error("The private Haloop collector could not list eval artifacts.");
      }
      const matchingArtifact = artifactsResponse.body.artifacts.find(
        (artifact) => artifact?.halo_run_id === latest.run_id,
      );
      if (matchingArtifact) {
        evalArtifact = normalizeHaloopEvalArtifact(matchingArtifact, project, latest.run_id);
      }
    }
    return {
      state,
      project,
      detail,
      stats,
      run: {
        runId: latest.run_id,
        status: latest.status,
        provider: String(latest.provider ?? "unknown").slice(0, 64),
        model: String(latest.model ?? "unknown").slice(0, 128),
        startedAt: Number(latest.started_at) || null,
        finishedAt: Number(latest.finished_at) || null,
        reportAvailable: latest.report_available === true,
        citations,
        error: typeof latest.error === "string" ? safeDiagnosticMessage(latest.error) : null,
      },
      evalArtifact,
      retention: {
        days: HALOOP_REPORT_RETENTION_DAYS,
        reports: HALOOP_REPORT_RETENTION_COUNT,
      },
    };
  }

  function traceCaptureStatus() {
    return serialize(async () => {
      const project = (lastReadyRoute?.sandboxName && String(lastReadyRoute.sandboxName).trim())
        || (lastReadyRoute?.workspaceId ? haloopProjectForWorkspace(lastReadyRoute.workspaceId) : lastAnalysisProject);
      const base = { project: project ?? null, stats: null, run: null, evalArtifact: null,
        retention: { days: HALOOP_REPORT_RETENTION_DAYS, reports: HALOOP_REPORT_RETENTION_COUNT } };
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      if (!collector?.managed || !collector.running || collector.health !== "healthy" || !project) {
        return { ...base, state: "unavailable", detail: "Launch a sandbox to capture traces." };
      }
      const result = await collectorRequest(run, { requestPath: `/stats?project=${project}` });
      if (result.status !== 200) throw new Error("Could not read captured trace counts.");
      const raw = result.body;
      const stats = { spans: Number(raw.spans) || 0, errors: Number(raw.errors) || 0,
        byObservationKind: raw.by_observation_kind ?? {}, byModel: raw.by_model ?? {} };
      return { ...base, stats, state: stats.spans ? "ready" : "no-traces",
        detail: "Desktop captures traces. Analysis and Harbor generation belong to the w8-haloop web app." };
    });
  }

  function exportTraces(project, destinationPath) {
    return serialize(async () => {
      const expected = (lastReadyRoute?.sandboxName && String(lastReadyRoute.sandboxName).trim())
        || (lastReadyRoute?.workspaceId ? haloopProjectForWorkspace(lastReadyRoute.workspaceId) : lastAnalysisProject);
      if (!HALOOP_PROJECT_PATTERN.test(String(project)) || project !== expected) {
        throw new Error("The active trace project changed. Refresh and retry.");
      }
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      if (!collector?.managed || !collector.running) throw new Error("The private trace collector is unavailable.");
      const destination = String(destinationPath ?? "");
      if (!/^\/mnt\/[a-z]\/.+/i.test(destination) || destination.length > 4096 ||
          /[\u0000-\u001f\u007f]/.test(destination) || /(?:^|\/)\.\.(?:\/|$)/.test(destination)) {
        throw new Error("The selected trace download destination is invalid.");
      }
      // Docker copies only the server-derived project path. Never accept a source path from the renderer.
      const source = `${HALOOP_COLLECTOR_CONTAINER_DATA_DIR}/traces/${project}.traces.jsonl`;
      const result = await run(dockerArgs("cp", `${HALOOP_COLLECTOR_CONTAINER_NAME}:${source}`, destination), { timeout: 60_000 });
      if (result.exitCode !== 0) throw new Error("The captured traces could not be downloaded.");
    });
  }

  function analysisStatus() {
    return serialize(() => analysisSnapshot());
  }

  function startAnalysis() {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      const existing = await collectorRequest(run, { requestPath: "/halo/runs" });
      if (existing.status !== 200 || !Array.isArray(existing.body?.runs)) {
        throw new Error("The private Haloop collector could not list HALO analysis runs.");
      }
      const activeRun = Array.isArray(existing.body.runs)
        ? existing.body.runs.find(
            (entry) =>
              entry?.project === project &&
              (entry.status === "created" || entry.status === "running"),
          )
        : null;
      if (activeRun) {
        throw new Error("HALO analysis is already running for the active trace project.");
      }
      const validation = await validateTraceProject(run, project);
      if (!validation.valid) {
        if (validation.reason === "missing" || validation.reason === "empty") {
          throw new Error(
            "No valid Haloop trace is available yet. Use Claude or OpenClaw, then retry analysis.",
          );
        }
        throw new Error(
          "The active Haloop trace failed contract validation. Analysis was not started.",
        );
      }
      await pruneReports(run);
      const response = await collectorRequest(run, {
        method: "POST",
        requestPath: "/halo/analyze",
        body: {
          project,
          prompt: HALOOP_ANALYSIS_PROMPT,
          max_depth: 1,
          max_turns: 12,
          max_parallel: 3,
        },
      });
      if (response.status !== 202 || !HALOOP_RUN_ID_PATTERN.test(response.body.run_id)) {
        const reason = typeof response.body?.error === "string"
          ? safeDiagnosticMessage(response.body.error)
          : "The private collector rejected the analysis request.";
        throw new Error(reason);
      }
      selectedAnalysisRunIds.set(project, response.body.run_id);
      analysisAudits.delete(response.body.run_id);
      return analysisSnapshot();
    });
  }

  function loadAnalysisReport(runId) {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      return readAuditedAnalysisReport(project, String(runId ?? "").trim());
    });
  }

  function generateEvalCases(runId) {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      const normalizedRunId = String(runId ?? "").trim();
      if (!HALOOP_RUN_ID_PATTERN.test(normalizedRunId)) {
        throw new Error("The HALO analysis run identity is invalid.");
      }
      // Re-read and re-audit the report immediately before creating a sensitive
      // eval artifact. The collector receives no renderer-controlled paths.
      await readAuditedAnalysisReport(project, normalizedRunId);
      const response = await collectorRequest(run, {
        method: "POST",
        requestPath: "/evals/extract",
        body: { project, run_id: normalizedRunId },
      });
      if (response.status !== 201) {
        const reason = typeof response.body?.error === "string"
          ? safeDiagnosticMessage(response.body.error)
          : "The private collector rejected the eval extraction request.";
        throw new Error(reason);
      }
      return normalizeHaloopEvalArtifact(response.body, project, normalizedRunId);
    });
  }

  async function readValidatedEvalPreview(project, runId) {
    const normalizedRunId = String(runId ?? "").trim();
    if (!HALOOP_RUN_ID_PATTERN.test(normalizedRunId)) {
      throw new Error("The HALO analysis run identity is invalid.");
    }
    // Re-audit the report and resolve the artifact from collector-owned state;
    // neither an artifact filename nor trace content comes from the renderer.
    await readAuditedAnalysisReport(project, normalizedRunId);
    const artifactsResponse = await collectorRequest(run, {
      requestPath: `/evals/artifacts?project=${project}`,
    });
    const matchingArtifact = Array.isArray(artifactsResponse.body?.artifacts)
      ? artifactsResponse.body.artifacts.find(
          (candidate) => candidate?.halo_run_id === normalizedRunId,
        )
      : null;
    if (artifactsResponse.status !== 200 || !matchingArtifact) {
      throw new Error("The requested Haloop eval artifact is unavailable.");
    }
    const artifact = normalizeHaloopEvalArtifact(matchingArtifact, project, normalizedRunId);
    const previewResponse = await collectorRequest(run, {
      requestPath: `/evals/artifacts/${normalizedRunId}/preview?project=${project}`,
    });
    if (previewResponse.status !== 200) {
      const reason = typeof previewResponse.body?.error === "string"
        ? safeDiagnosticMessage(previewResponse.body.error)
        : "The private collector rejected the eval preview request.";
      throw new Error(reason);
    }
    return {
      artifact,
      preview: normalizeHaloopEvalPreview(
        previewResponse.body,
        project,
        normalizedRunId,
        artifact,
      ),
    };
  }

  function loadEvalCases(runId) {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      const { preview } = await readValidatedEvalPreview(project, runId);
      return preview;
    });
  }

  function exportEvalCases(runId, destinationPath) {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      const { artifact } = await readValidatedEvalPreview(project, runId);
      await copyEvalArtifact(run, {
        artifactId: artifact.artifactId,
        destinationPath,
      });
      return artifact;
    });
  }

  function exportHarborDataset(runId, destinationPath) {
    return serialize(async () => {
      const { project } = await requireAnalysisCollector();
      const { artifact, preview } = await readValidatedEvalPreview(project, runId);
      const normalizedDestination = String(destinationPath ?? "");
      if (
        normalizedDestination.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(normalizedDestination) ||
        /(?:^|\/)\.\.(?:\/|$)/.test(normalizedDestination)
      ) {
        throw new Error("The selected Harbor export destination is invalid.");
      }
      return exportHarborDatasetToZip(preview.cases, artifact, normalizedDestination);
    });
  }

  async function ensureOperation(options = {}) {
      const upstream = resolveHaloopUpstream(options.anthropicApiKey, env);
      await ensureDistro();
      options.onProgress?.({
        phase: "haloop",
        message: "Checking the required Haloop inference edge…",
      });
      const images = await requireHaloopImages(run);
      const registration = await registerProfile({
        deferCommit: true,
        sandboxName: options.sandboxName,
        workspaceId: options.workspaceId,
        agentId: options.agentId,
      });
      if (!registration.current) {
        throw new Error("The scoped Haloop client profile could not be registered.");
      }
      const document = buildHaloopProfilesDocument(registration.profiles, options.anthropicApiKey, {
        env,
      });
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      const profileHash = createHash("sha256").update(serialized).digest("hex");
      const analysisEnvironment = "W8_DESKTOP_CAPTURE_ONLY=1\n";
      const analysisConfigHash = createHash("sha256")
        .update(analysisEnvironment)
        .digest("hex");
      const previousRoute = lastReadyRoute;
      const transactionId = randomBytes(8).toString("hex");
      const heldContainers = [];
      const stateFiles = [HALOOP_PROFILES_FILE, HALOOP_ANALYSIS_ENV_FILE, HALOOP_READY_ROUTE_FILE];
      async function checkedRun(args, options = {}) {
        const result = await run(args, { timeout: 60_000, ...options });
        if (result.exitCode !== 0) throw new Error("Could not safely update or restore Haloop runtime state.");
        return result;
      }
      await checkedRun(["-d", DISTRO_NAME, "--", "sh", "-c",
        "set -eu; " + stateFiles.map((file) => `if [ -f ${file} ]; then cp -p ${file} ${file}.${transactionId}; fi`).join("; ")], { user: "root" });
      async function holdContainer(name, info) {
        const backup = `${name}-${transactionId}`;
        await checkedRun(dockerArgs("container", "rename", name, backup));
        heldContainers.push({ name, backup, running: info.running });
        await checkedRun(dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), backup));
      }

      let gatewayStartedThisOperation = false;
      let collectorStartedThisOperation = false;
      let analysisEnvironmentStagedThisOperation = false;
      try {
        await stageProfiles(run, serialized);
        await ensureManagedNetwork(run);
        let collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
        let gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
        if (collector && !collector.managed) {
          throw new Error(
            `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
          );
        }
        if (gateway && !gateway.managed) {
          throw new Error(
            `A container named ${HALOOP_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Remove or rename it, then retry.`,
          );
        }
        if (
          collector &&
          (
            collector.imageId !== images.collector.imageId ||
            collector.analysisContract !== COLLECTOR_ANALYSIS_CONTRACT ||
            collector.analysisConfigHash !== analysisConfigHash ||
            options.forceRestart === true ||
            !collector.running
          )
        ) {
          options.onProgress?.({
            phase: "haloop",
            message: "Applying the capture-only private Haloop collector…",
          });
          await holdContainer(HALOOP_COLLECTOR_CONTAINER_NAME, collector);
          collector = null;
        }
        if (!collector) {
          await stageAnalysisEnvironment(run, analysisEnvironment);
          analysisEnvironmentStagedThisOperation = true;
          await createCollectorContainer(run, analysisConfigHash);
          collectorStartedThisOperation = true;
        }
        await waitForHealthyContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");

        const reusableGateway =
          options.forceRestart !== true && gateway?.profileHash === profileHash && gateway?.imageId === images.gateway.imageId;
        if (!reusableGateway && gateway) {
          options.onProgress?.({
            phase: "haloop",
            message: "Applying the updated Haloop route-profile registry…",
          });
          await holdContainer(HALOOP_CONTAINER_NAME, gateway);
          gateway = null;
        }
        if (!gateway) {
          await createGatewayContainer(run, profileHash);
          gatewayStartedThisOperation = true;
        } else if (!gateway.running) {
          const started = await run(
            dockerArgs("container", "start", HALOOP_CONTAINER_NAME),
            { timeout: 60_000 },
          );
          if (started.exitCode !== 0) {
            throw new Error(
              `Could not restart the managed Haloop container: ${(started.stderr || started.stdout).trim() || `exit ${started.exitCode}`}`,
            );
          }
          gatewayStartedThisOperation = true;
        }

        await waitForHealthyContainer(run, HALOOP_CONTAINER_NAME, "gateway");
        await requireCollectorFromGateway(run);
        await requireAuthenticatedEdge(run);
        const conversation = options.issueConversation === true
          ? issueHaloopConversationContext(registration.current, {
              agentSessionId: options.agentSessionId,
              contextId: options.haloopContextId,
            })
          : null;
        if (conversation) {
          const readyAt = Date.now();
          await writeTrustedSpans(conversation.capture, [
            {
              kind: "AGENT",
              eventId: "route-root",
              name: "openrind.agent.route",
              parentSpanId: "",
              startMs: readyAt,
              endMs: readyAt,
              attributes: {
                "openrind.agent.id": options.agentId,
                "openrind.lifecycle": "ready",
              },
            },
          ]);
        }
        managedThisProcess = true;
        options.onProgress?.({
          phase: "haloop",
          message: upstream.mode === "openrouter-test"
            ? `Haloop ${images.gateway.version} is healthy on the temporary OpenRouter test upstream.`
            : `Haloop ${images.gateway.version} routing and private trace capture are healthy.`,
        });
        const result = {
          endpoint: HALOOP_SANDBOX_ENDPOINT,
          routePolicy: HALOOP_ROUTE_POLICY,
          providerName: registration.current.providerName,
          clientToken: registration.current.clientToken,
          profileId: registration.current.id,
          version: images.gateway.version,
          upstreamMode: upstream.mode,
          ...(conversation
            ? {
                capture: conversation.capture,
                haloopContextId: conversation.contextId,
                sessionAssertion: conversation.assertion,
                sessionAssertionExpiresAt: conversation.expiresAtMs,
              }
            : {}),
        };
        lastReadyRoute = {
          gatewayProfileHash: profileHash,
          profileId: registration.current.id,
          providerName: registration.current.providerName,
          sandboxName: options.sandboxName,
          workspaceId: options.workspaceId,
          agentId: options.agentId,
          upstreamMode: upstream.mode,
          analysisConfigHash,
        };
        await persistReadyRoute(lastReadyRoute);
        await registration.commit?.();
        // Only discard the rollback resources after all readiness checks and persistence.
        for (const held of heldContainers) {
          await run(dockerArgs("container", "rm", held.backup), { timeout: 60_000 }).catch(() => undefined);
        }
        await run(["-d", DISTRO_NAME, "--", "rm", "-f", ...stateFiles.map((file) => `${file}.${transactionId}`)],
          { timeout: 10_000, user: "root" }).catch(() => undefined);
        lastAnalysisProject = (options.sandboxName && String(options.sandboxName).trim()) || haloopProjectForWorkspace(options.workspaceId);
        lastConnectionError = null;
        return result;
      } catch (error) {
        lastReadyRoute = previousRoute;
        if (gatewayStartedThisOperation) {
          await run(
            dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_CONTAINER_NAME),
            { timeout: 60_000 },
          ).catch(() => undefined);
        }
        if (collectorStartedThisOperation) {
          await run(
            dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_COLLECTOR_CONTAINER_NAME),
            { timeout: 60_000 },
          ).catch(() => undefined);
        }
        try {
          await checkedRun(["-d", DISTRO_NAME, "--", "sh", "-c",
            "set -eu; " + stateFiles.map((file) => `if [ -f ${file}.${transactionId} ]; then mv -f ${file}.${transactionId} ${file}; else rm -f ${file}; fi`).join("; ")], { user: "root" });
          for (const held of heldContainers.reverse()) {
            const candidate = await inspectContainer(run, held.name);
            if (candidate) await removeManagedContainer(run, held.name, "replacement");
            await checkedRun(dockerArgs("container", "rename", held.backup, held.name));
            if (held.running) await checkedRun(dockerArgs("container", "start", held.name));
          }
        } catch {
          throw new Error("Haloop update failed and rollback needs attention. The previous containers were retained for recovery.", { cause: error });
        }
        throw error;
      }
  }

  function ensure(options = {}) {
    const operation = serialize(() => ensureOperation(options));
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function status() {
    return serialize(async () => {
      const checkedAt = Date.now();
      let images;
      try {
        images = await requireHaloopImages(run);
      } catch (error) {
        return {
          required: true,
          routePolicy: HALOOP_ROUTE_POLICY,
          upstreamMode: isTemporaryOpenRouterHaloopTestEnabled(env)
            ? "openrouter-test"
            : "anthropic",
          state: "unavailable",
          endpoint: HALOOP_SANDBOX_ENDPOINT,
          version: null,
          health: null,
          collectorHealth: null,
          activeRoute: null,
          detail: safeDiagnosticMessage(error),
          lastConnectionError,
          spanCapture: { ...captureStatus },
          runtimeDiagnostics: runtimeDiagnostics.status(),
          checkedAt,
        };
      }

      const network = await inspectNetwork(run);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      await recoverReadyRoute(gateway);
      let state = "stopped";
      let detail = "Haloop routing and private trace capture will start automatically before a Claude or OpenClaw sandbox connects.";
      if (network && !network.managed) {
        state = "blocked";
        detail = `The reserved Docker network ${HALOOP_NETWORK_NAME} is owned by another process.`;
      } else if (gateway && !gateway.managed) {
        state = "blocked";
        detail = `The reserved container name ${HALOOP_CONTAINER_NAME} is owned by another process.`;
      } else if (collector && !collector.managed) {
        state = "blocked";
        detail = `The reserved container name ${HALOOP_COLLECTOR_CONTAINER_NAME} is owned by another process.`;
      } else if (gateway && gateway.imageId !== images.gateway.imageId) {
        state = "degraded";
        detail = "The Haloop gateway does not match the required Desktop image.";
      } else if (collector && collector.imageId !== images.collector.imageId) {
        state = "degraded";
        detail = "The private Haloop collector does not match the required Desktop image.";
      } else if (collector && collector.analysisContract !== COLLECTOR_ANALYSIS_CONTRACT) {
        state = "degraded";
        detail = "The private Haloop collector must be restarted to enable validated trace analysis.";
      } else if (
        gateway?.running &&
        gateway.health === "healthy" &&
        collector?.running &&
        collector.health === "healthy"
      ) {
        state = "ready";
        detail = "Haloop routing and private trace capture are healthy.";
      } else if (
        (gateway?.running && gateway.health === "starting") ||
        (collector?.running && collector.health === "starting")
      ) {
        state = "starting";
        detail = "Haloop routing or private trace capture is starting and is not ready for sandbox traffic yet.";
      } else if (gateway?.running || collector?.running) {
        state = "degraded";
        detail = `Haloop is incomplete (gateway: ${gateway?.health || "stopped"}; collector: ${collector?.health || "stopped"}).`;
      }

      return {
        required: true,
        routePolicy: HALOOP_ROUTE_POLICY,
        upstreamMode: lastReadyRoute?.upstreamMode ??
          (isTemporaryOpenRouterHaloopTestEnabled(env) ? "openrouter-test" : "anthropic"),
        state,
        endpoint: HALOOP_SANDBOX_ENDPOINT,
        version: images.gateway.version,
        health: gateway?.health ?? null,
        collectorHealth: collector?.health ?? null,
        activeRoute: lastReadyRoute
          ? {
              profileId: lastReadyRoute.profileId,
              providerName: lastReadyRoute.providerName,
              sandboxName: lastReadyRoute.sandboxName,
              agentId: lastReadyRoute.agentId,
            }
          : null,
        detail,
        lastConnectionError,
        spanCapture: { ...captureStatus },
        runtimeDiagnostics: runtimeDiagnostics.status(),
        checkedAt,
      };
    });
  }

  function stop() {
    return serialize(async () => {
      if (!managedThisProcess) return;
      const stopErrors = [];
      const stoppedGateway = await run(
        dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_CONTAINER_NAME),
        { timeout: 60_000 },
      ).catch(() => null);
      if (stoppedGateway && stoppedGateway.exitCode !== 0 && !/no such container/i.test(`${stoppedGateway.stderr}\n${stoppedGateway.stdout}`)) {
        stopErrors.push("gateway");
      }
      const stoppedCollector = await run(
        dockerArgs("container", "stop", "--time", String(SHUTDOWN_TIMEOUT_SECONDS), HALOOP_COLLECTOR_CONTAINER_NAME),
        { timeout: 60_000 },
      ).catch(() => null);
      if (stoppedCollector && stoppedCollector.exitCode !== 0 && !/no such container/i.test(`${stoppedCollector.stderr}\n${stoppedCollector.stdout}`)) {
        stopErrors.push("collector");
      }
      await run(
        [
          "-d",
          DISTRO_NAME,
          "--",
          "rm",
          "-f",
          HALOOP_PROFILES_FILE,
          HALOOP_ANALYSIS_ENV_FILE,
        ],
        { timeout: 10_000, user: "root" },
      ).catch(() => undefined);
      lastReadyRoute = null;
      capturedBytesByTrace.clear();
      analysisAudits.clear();
      if (stopErrors.length > 0) {
        throw new Error(
          `The managed Haloop ${stopErrors.join(" and ")} service${stopErrors.length === 1 ? "" : "s"} did not stop cleanly.`,
        );
      }
    });
  }

  async function restart(options = {}) {
    await status();
    const upstreamKey = resolveHaloopUpstreamApiKey(options.anthropicApiKey, { env });
    const route = lastReadyRoute ? { ...lastReadyRoute } : null;
    if (!route) {
      throw new Error(
        "Haloop has no active Desktop route to restart. Launch a Claude or OpenClaw sandbox first.",
      );
    }
    return ensure({
      forceRestart: true,
      anthropicApiKey: upstreamKey,
      sandboxName: route.sandboxName,
      workspaceId: route.workspaceId,
      agentId: route.agentId,
      onProgress: options.onProgress,
    });
  }

  function activeRoute() {
    return publicRouteIdentity(lastReadyRoute);
  }

  function activateExistingRoute(options = {}) {
    return serialize(async () => {
      const identity = resolveHaloopClientProfileIdentity(options);
      lastReadyRoute = {
        gatewayProfileHash: lastReadyRoute?.gatewayProfileHash ?? null,
        profileId: identity.id,
        providerName: identity.providerName,
        sandboxName: identity.sandboxName,
        workspaceId: identity.workspaceId,
        agentId: identity.agentId,
        upstreamMode: lastReadyRoute?.upstreamMode ??
          (isTemporaryOpenRouterHaloopTestEnabled(env) ? "openrouter-test" : "anthropic"),
        analysisConfigHash: lastReadyRoute?.analysisConfigHash ?? null,
      };
      lastAnalysisProject = (identity.sandboxName && String(identity.sandboxName).trim()) || haloopProjectForWorkspace(identity.workspaceId);
      if (lastReadyRoute.gatewayProfileHash) await persistReadyRoute(lastReadyRoute);
      lastConnectionError = null;
      return publicRouteIdentity(lastReadyRoute);
    });
  }

  function restoreIncumbent(options = {}) {
    const operation = serialize(async () => {
      const upstreamKey = resolveHaloopUpstreamApiKey(options.anthropicApiKey, { env });
      const route = lastReadyRoute ? { ...lastReadyRoute } : null;
      if (!route) {
        throw new Error(
          "Haloop has no active Desktop route to restore. Launch a Claude or OpenClaw sandbox first.",
        );
      }
      const expectedProfileId = String(options.expectedProfileId ?? "").trim();
      const expectedSandboxName = String(options.expectedSandboxName ?? "").trim();
      if (!expectedProfileId || !expectedSandboxName) {
        throw new Error("The exact active Haloop route identity is required for incumbent rollback.");
      }
      if (
        expectedProfileId !== route.profileId ||
        expectedSandboxName !== route.sandboxName
      ) {
        throw new Error(
          "The active Haloop route changed before incumbent rollback began. Refresh the route status and retry.",
        );
      }

      await ensureDistro();
      const images = await requireHaloopImages(run);
      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Incumbent rollback is blocked.`,
        );
      }
      if (!network) {
        throw new Error(
          "The managed Haloop network is unavailable. Restart Haloop before restoring the incumbent route.",
        );
      }
      if (
        !collector ||
        !collector.running ||
        collector.health !== "healthy" ||
        collector.imageId !== images.collector.imageId
      ) {
        throw new Error(
          "The private Haloop collector must be healthy before incumbent rollback. Restart Haloop, then retry.",
        );
      }

      await options.beforeRollback?.(publicRouteIdentity(route));
      options.onProgress?.({
        phase: "haloop",
        message: "Restoring the approved incumbent-only Haloop route…",
      });
      if (gateway) {
        await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
      }
      const result = await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
        onProgress: options.onProgress,
      });
      if (result.profileId !== route.profileId) {
        throw new Error("The incumbent-only Haloop route identity changed during rollback.");
      }
      return {
        ...result,
        routePolicy: HALOOP_ROUTE_POLICY,
        sessionsPreserved: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function rotate(options = {}) {
    const operation = serialize(async () => {
      const upstreamKey = resolveHaloopUpstreamApiKey(options.anthropicApiKey, { env });
      const route = lastReadyRoute ? { ...lastReadyRoute } : null;
      if (!route) {
        throw new Error(
          "Haloop has no active Desktop route to rotate. Launch a Claude or OpenClaw sandbox first.",
        );
      }
      const expectedProfileId = String(options.expectedProfileId ?? "").trim();
      const expectedSandboxName = String(options.expectedSandboxName ?? "").trim();
      if (!expectedProfileId || !expectedSandboxName) {
        throw new Error("The exact active Haloop route identity is required for token rotation.");
      }
      if (
        expectedProfileId !== route.profileId ||
        expectedSandboxName !== route.sandboxName
      ) {
        throw new Error(
          "The active Haloop route changed before token rotation began. Refresh the route status and retry.",
        );
      }

      await ensureDistro();
      await requireHaloopImages(run);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} already exists but is not managed by Openrind Desktop. Token rotation is blocked.`,
        );
      }

      // End tracked agent processes before invalidating their assertion key.
      // The callback runs inside the same runtime queue as every registry
      // mutation, so no old credential is served after it completes.
      const affectedSessions = Number(
        await options.beforeRotate?.(publicRouteIdentity(route)),
      ) || 0;
      if (gateway) {
        await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
      }

      const registration = await rotateProfile({
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
      });
      if (!registration.current || registration.current.id !== route.profileId) {
        throw new Error("The scoped Haloop client token could not be rotated safely.");
      }

      const result = await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: route.sandboxName,
        workspaceId: route.workspaceId,
        agentId: route.agentId,
        onProgress: options.onProgress,
      });
      return { ...result, affectedSessions, relaunchRequired: true };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function revokeSandbox(options = {}) {
    const operation = serialize(async () => {
      const sandboxName = String(options.sandboxName ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(sandboxName)) {
        throw new Error("A valid sandbox name is required for Haloop revocation.");
      }
      const upstreamKey = resolveHaloopUpstreamApiKey(options.anthropicApiKey, {
        env,
        optional: true,
      });
      await ensureDistro();

      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
        );
      }

      const activeTargetRoute = lastReadyRoute?.sandboxName === sandboxName
        ? { ...lastReadyRoute }
        : null;
      const affectedSessions = Number(await options.beforeRevoke?.({ sandboxName })) || 0;
      const revocation = await revokeProfiles({
        sandboxName,
        beforePersist: async ({ revoked = [] } = {}) => {
          const providerNames = [
            ...new Set([
              ...revoked.map((profile) => profile.providerName),
              ...(activeTargetRoute?.providerName ? [activeTargetRoute.providerName] : []),
            ]),
          ];
          if (revoked.length === 0 && !activeTargetRoute) return;
          // Withdraw the edge before deleting its encrypted source token. This
          // closes the only serving window for both tracked and stolen clients.
          const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
          if (gateway && !gateway.managed) {
            throw new Error(
              `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Token revocation is blocked.`,
            );
          }
          if (gateway) {
            await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
          }
          await options.beforeCredentialsRemoved?.({
            sandboxName,
            providerNames,
          });
        },
      });

      const remainingProfiles = Array.isArray(revocation.profiles)
        ? revocation.profiles
        : [];
      const unreadableProfiles = Number(revocation.unreadableProfiles) || 0;
      const revokedProfiles = Array.isArray(revocation.revoked)
        ? revocation.revoked.length
        : 0;
      if (revokedProfiles === 0 && !activeTargetRoute) {
        return {
          revokedProfiles: 0,
          remainingProfiles: remainingProfiles.length + unreadableProfiles,
          affectedSessions,
          routeReady: Boolean(lastReadyRoute),
        };
      }
      if (activeTargetRoute) lastReadyRoute = null;

      if (!upstreamKey || remainingProfiles.length === 0) {
        const currentCollector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
        if (currentCollector?.managed) {
          await removeManagedContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");
        }
        await run(
          [
            "-d",
            DISTRO_NAME,
            "--",
            "rm",
            "-f",
            HALOOP_PROFILES_FILE,
            HALOOP_ANALYSIS_ENV_FILE,
          ],
          { timeout: 10_000, user: "root" },
        ).catch(() => undefined);
        managedThisProcess = false;
        lastReadyRoute = null;
        return {
          revokedProfiles,
          remainingProfiles: remainingProfiles.length + unreadableProfiles,
          affectedSessions,
          routeReady: false,
        };
      }

      const previousRoute = lastReadyRoute;
      const survivor = previousRoute
        ? remainingProfiles.find((profile) => profile.id === previousRoute.profileId)
        : null;
      const selected = survivor ?? remainingProfiles[0];
      await ensureOperation({
        anthropicApiKey: upstreamKey,
        sandboxName: selected.sandboxName,
        workspaceId: selected.workspaceId,
        agentId: selected.agentId,
        onProgress: options.onProgress,
      });
      return {
        revokedProfiles,
        remainingProfiles: remainingProfiles.length + unreadableProfiles,
        affectedSessions,
        routeReady: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  function revokeIntegration(options = {}) {
    const operation = serialize(async () => {
      await ensureDistro();
      const network = await inspectNetwork(run);
      const collector = await inspectContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME);
      const gateway = await inspectContainer(run, HALOOP_CONTAINER_NAME);
      if (network && !network.managed) {
        throw new Error(
          `The reserved Docker network ${HALOOP_NETWORK_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }
      if (collector && !collector.managed) {
        throw new Error(
          `A container named ${HALOOP_COLLECTOR_CONTAINER_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }
      if (gateway && !gateway.managed) {
        throw new Error(
          `A container named ${HALOOP_CONTAINER_NAME} is not managed by Openrind Desktop. Integration revocation is blocked.`,
        );
      }

      const activeRoute = lastReadyRoute ? { ...lastReadyRoute } : null;
      const affectedSessions = Number(await options.beforeRevoke?.()) || 0;
      const revocation = await revokeAllProfiles({
        beforePersist: async ({ revoked = [] } = {}) => {
          const providerNames = [
            ...new Set([
              ...revoked.map((profile) => profile.providerName),
              ...(activeRoute?.providerName ? [activeRoute.providerName] : []),
            ]),
          ];
          // The public edge is the only place a scoped client token can be
          // served. Withdraw it before providers or encrypted source records.
          if (gateway) {
            await removeManagedContainer(run, HALOOP_CONTAINER_NAME, "gateway");
          }
          await options.beforeCredentialsRemoved?.({ providerNames });
        },
      });

      // Encrypted client identities are gone and the edge is already down, so
      // this route must not be reported as recoverable even if later container
      // or network cleanup needs an operator retry.
      managedThisProcess = false;
      lastReadyRoute = null;

      if (collector) {
        await removeManagedContainer(run, HALOOP_COLLECTOR_CONTAINER_NAME, "collector");
      }
      const removedRegistry = await run(
        [
          "-d",
          DISTRO_NAME,
          "--",
          "rm",
          "-f",
          HALOOP_PROFILES_FILE,
          HALOOP_ANALYSIS_ENV_FILE,
          HALOOP_READY_ROUTE_FILE,
        ],
        { timeout: 10_000, user: "root" },
      );
      if (removedRegistry.exitCode !== 0) {
        throw new Error(
          `Could not remove the Haloop route-profile registry: ${(removedRegistry.stderr || removedRegistry.stdout).trim() || `exit ${removedRegistry.exitCode}`}`,
        );
      }
      if (network) await removeManagedNetwork(run);

      const revokedProfiles = Array.isArray(revocation.revoked)
        ? revocation.revoked.length
        : 0;
      managedThisProcess = false;
      lastConnectionError = null;
      capturedBytesByTrace.clear();
      analysisAudits.clear();
      return {
        revokedProfiles,
        affectedSessions,
        routeReady: false,
        runtimeRemoved: true,
      };
    });
    return operation.catch((error) => {
      lastConnectionError = safeDiagnosticMessage(error);
      throw error;
    });
  }

  return {
    activateExistingRoute,
    activeRoute,
    analysisStatus,
    traceCaptureStatus,
    exportTraces,
    ensure,
    exportEvalCases,
    exportHarborDataset,
    generateEvalCases,
    loadAnalysisReport,
    loadEvalCases,
    recordApplicationSpans,
    restart,
    restoreIncumbent,
    revokeIntegration,
    revokeSandbox,
    rotate,
    startAnalysis,
    status,
    stop,
  };
}

const runtimeManager = createHaloopRuntimeManager();

export function ensureHaloopRuntime(options) {
  return runtimeManager.ensure(options);
}

export function activateExistingHaloopRoute(options) {
  return runtimeManager.activateExistingRoute(options);
}

export function getHaloopRuntimeStatus() {
  return runtimeManager.status();
}

export function getHaloopCaptureStatus() {
  return runtimeManager.traceCaptureStatus();
}

export function exportHaloopTraces(project, destinationPath) {
  return runtimeManager.exportTraces(project, destinationPath);
}

export function getHaloopAnalysisStatus() {
  return runtimeManager.analysisStatus();
}

export function generateHaloopEvalCases(runId) {
  return runtimeManager.generateEvalCases(runId);
}

export function exportHaloopEvalCases(runId, destinationPath) {
  return runtimeManager.exportEvalCases(runId, destinationPath);
}

export function exportHaloopHarborDataset(runId, destinationPath) {
  return runtimeManager.exportHarborDataset(runId, destinationPath);
}

export function startHaloopAnalysis() {
  return runtimeManager.startAnalysis();
}

export function loadHaloopAnalysisReport(runId) {
  return runtimeManager.loadAnalysisReport(runId);
}

export function loadHaloopEvalCases(runId) {
  return runtimeManager.loadEvalCases(runId);
}

export function recordHaloopApplicationSpans(capture, events) {
  return runtimeManager.recordApplicationSpans(capture, events);
}

// Host-only. Never expose the returned credential callback through renderer IPC.
export function getHaloopDiagnosticRoute(sandboxName) {
  return resolveDiagnosticRoute({ sandboxName,
    requestRoute: request => requestPrivateCollector(wslRun, request) });
}

export function restartHaloopRuntime(options) {
  return runtimeManager.restart(options);
}

export function getHaloopRuntimeActiveRoute() {
  return runtimeManager.activeRoute();
}

export function restoreHaloopIncumbentRoute(options) {
  return runtimeManager.restoreIncumbent(options);
}

export function rotateHaloopRuntime(options) {
  return runtimeManager.rotate(options);
}

export function revokeHaloopSandboxProfiles(options) {
  return runtimeManager.revokeSandbox(options);
}

export function revokeHaloopIntegration(options) {
  return runtimeManager.revokeIntegration(options);
}

export function stopHaloopRuntime() {
  return runtimeManager.stop();
}

export const __testing = {
  COLLECTOR_ANALYSIS_CONTRACT,
  COLLECTOR_ANALYSIS_LABEL,
  HALOOP_ANALYSIS_ENV_FILE,
  HALOOP_CONTAINER_PROFILES_FILE,
  HALOOP_COLLECTOR_DATA_DIR,
  HALOOP_REPORTS_DIR,
  HALOOP_COLLECTOR_URL,
  HALOOP_PROFILES_FILE,
  MANAGED_NETWORK_LABEL,
  OPENSHELL_SANDBOX_NETWORK_NAME,
  PROFILE_HASH_LABEL,
  STARTUP_TIMEOUT_MS,
  inspectContainer,
  requestPrivateCollector,
  requireAuthenticatedEdge,
  resolveOpenShellBridgeAddress,
  validateHaloopReportCitations,
  validateHaloopTraceProject,
};
