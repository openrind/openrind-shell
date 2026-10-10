import { createHash } from "node:crypto";
import { createCapture } from "./index.mjs";

const states = new Set(["initializing", "writable", "fenced"]);
const agents = new Set(["claude", "openclaw", "openhands"]);
const lifecycles = new Set(["completed", "crashed", "cancelled", "sandbox-deleted", "app-shutdown"]);
const countFields = ["requestsStarted", "requestsCompleted", "requestErrors", "requestDurationMicros"];

// This diagnostic profile accepts no payloads, paths, commands, model output,
// or arbitrary attributes. It is not the evidence-capture profile.
export function createRuntimeDiagnostics({ env = process.env, configuration, createProducer = createCapture } = {}) {
  let capture;
  let issue = null;
  let credentialRevocation = configuration?.revoke ? "pending" : "not_applicable";
  let rejected = 0;
  let closed = false;
  let shutdownTask;
  const endpoint = configuration ? configuration.endpoint : env.OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT?.trim();
  const project = configuration?.project;
  const sandboxName = configuration?.sandboxName;
  if (endpoint) {
    try {
      if (configuration && (!/^[A-Za-z0-9._-]{1,128}$/.test(project) ||
        !/^[A-Za-z0-9_.-]{1,19}$/.test(sandboxName) || typeof configuration.headers !== "function" ||
        typeof configuration.revoke !== "function")) {
        throw new Error("Invalid managed diagnostic scope");
      }
      capture = createProducer({ endpoint, serviceName: "openrind-runtime-diagnostics", serviceVersion: "1",
        headers: configuration?.headers ?? (() => env.OPENRIND_DIAGNOSTICS_OTLP_AUTHORIZATION
          ? { authorization: env.OPENRIND_DIAGNOSTICS_OTLP_AUTHORIZATION } : {}),
        maxQueueBytes: 1024 * 1024, maxQueueRecords: 64,
        // Managed credential renewal can take up to three seconds.
        timeoutMillis: configuration ? 5000 : 1000 });
    } catch { issue = "configuration_error"; }
  }

  function status() {
    return { enabled: Boolean(capture), configured: Boolean(endpoint), closed,
      rejected, issue, credentialRevocation, persistentAcceptance: "unverified", capture: capture?.status() ?? null };
  }

  function record(build) {
    if (!capture || closed) return false;
    try {
      const record = build();
      // The shared capture API reserves the openrind.* namespace for generated fields.
      if (project) record.attributes["project.id"] = project;
      const accepted = capture.recordOperation(record).accepted;
      if (!accepted) { rejected++; issue = "record_rejected"; }
      return accepted;
    }
    catch { rejected++; issue = "invalid_diagnostic_record"; return false; }
  }

  function filesystemHealth(name, health, now = Date.now()) {
    return record(() => {
      if (typeof name !== "string" || !name || name.length > 256 || (sandboxName && name !== sandboxName) ||
          !states.has(health?.state) || !Number.isSafeInteger(health.dirtyBytes) || health.dirtyBytes < 0) {
        throw new Error("Invalid health sample");
      }
      const attributes = {
        "diagnostic.source": "same_uid_fuse_health",
        "sandbox.id_hash": createHash("sha256").update(name).digest("hex"),
        "filesystem.state": health.state,
        "filesystem.dirty_bytes": health.dirtyBytes,
        "filesystem.writeback_error": Boolean(health.lastWritebackError),
      };
      const counters = health.diagnostics;
      if (counters?.version === 1) {
        if (!/^[a-f0-9-]{36}$/.test(counters.instanceId)) throw new Error("Invalid instance ID");
        attributes["filesystem.instance_id"] = counters.instanceId;
        for (const key of countFields) {
          if (!Number.isSafeInteger(counters[key]) || counters[key] < 0) throw new Error("Invalid counter");
          attributes[`filesystem.${key}`] = counters[key];
        }
      }
      attributes["filesystem.counters_available"] = counters?.version === 1;
      return { name: "filesystem.health", startMs: now, endMs: now,
        status: health.state === "writable" && !health.lastWritebackError ? "ok" : "error", attributes };
    });
  }

  function agentLifecycle(identity, event) {
    return record(() => {
      const agent = event?.attributes?.["openrind.agent.id"];
      const lifecycle = event?.attributes?.["openrind.lifecycle"];
      if ((project && identity?.project !== project) || !agents.has(agent) || !lifecycles.has(lifecycle) ||
          !/^[a-f0-9]{32}$/.test(identity?.traceId) || !/^[a-f0-9]{16}$/.test(identity?.rootSpanId)) {
        throw new Error("Invalid lifecycle sample");
      }
      return { name: "agent.session", startMs: event.startMs, endMs: event.endMs,
        traceparent: `00-${identity.traceId}-${identity.rootSpanId}-01`,
        status: lifecycle === "completed" ? "ok" : "error",
        attributes: { "diagnostic.source": "desktop_lifecycle", "agent.id": agent, "agent.lifecycle": lifecycle } };
    });
  }

  async function flush() {
    if (capture) {
      try { await capture.flush(); } catch { issue = "export_error"; }
    }
    return status();
  }

  function shutdown() {
    if (!shutdownTask) {
      closed = true;
      shutdownTask = (async () => {
        try { await capture?.shutdown(); } catch { issue = "export_error"; }
        if (configuration?.revoke) {
          try { credentialRevocation = await configuration.revoke(); }
          catch { credentialRevocation = "unavailable"; }
        }
        return status();
      })();
    }
    return shutdownTask;
  }

  return Object.freeze({ status, filesystemHealth, agentLifecycle, flush, shutdown });
}
