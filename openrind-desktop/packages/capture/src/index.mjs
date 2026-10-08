import { createHash, randomUUID } from "node:crypto";
import { SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { AlwaysOnSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  CAPTURE_LIMITS, boundedInteger, captureAttributes, captureContext,
  captureEndpoint, captureHeaders, identifier,
} from "./contracts.mjs";
import { createSignalExporter, ExportQueue } from "./exporter.mjs";

export { CAPTURE_LIMITS } from "./contracts.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const statusCodes = { unset: SpanStatusCode.UNSET, ok: SpanStatusCode.OK, error: SpanStatusCode.ERROR };

class OnDemandMetricReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

/** General application telemetry. No global providers, auto-instrumentation,
 * durable-store claims, or changes to the caller's inference route. */
export function createCapture(options) {
  const endpoint = captureEndpoint(options.endpoint);
  const serviceName = identifier(options.serviceName, "service name");
  const serviceVersion = identifier(options.serviceVersion, "service version");
  const instanceId = identifier(options.instanceId ?? randomUUID(), "instance ID");
  const streamId = identifier(options.streamId ?? randomUUID(), "stream ID");
  const runId = options.runId === undefined ? undefined : identifier(options.runId, "run ID");
  const parentContext = captureContext(options.traceparent);
  const maxQueueBytes = boundedInteger(options.maxQueueBytes ?? CAPTURE_LIMITS.queueBytes,
    "queue byte limit", CAPTURE_LIMITS.queueBytes);
  const maxQueueRecords = boundedInteger(options.maxQueueRecords ?? CAPTURE_LIMITS.queueRecords,
    "queue record limit", CAPTURE_LIMITS.queueRecords);
  const maxSessionBytes = boundedInteger(options.maxSessionBytes ?? CAPTURE_LIMITS.sessionBytes,
    "session byte limit", CAPTURE_LIMITS.sessionBytes);
  const timeoutMillis = boundedInteger(options.timeoutMillis ?? 10_000, "export timeout", 60_000);
  if (options.proxyUrl !== undefined && typeof options.proxyUrl !== "string") {
    throw new TypeError("Invalid proxy URL");
  }
  // Validate static headers now; a function is re-read for each export attempt.
  if (typeof options.headers !== "function") captureHeaders(options.headers);
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": serviceVersion,
    "service.instance.id": instanceId,
    "openrind.capture.schema_version": 1,
  });
  const state = {
    accepted: { logs: 0, traces: 0, metrics: 0 },
    partial: { logs: 0, traces: 0, metrics: 0 },
    failed: { logs: 0, traces: 0, metrics: 0 },
    rejected: 0,
    evidenceBytes: 0,
    lastIssue: null,
  };
  let closed = false;
  let sequence = 0;
  let stagedLogs;
  let lastSpanAccepted;
  let flushTail = Promise.resolve();
  let shutdownTask;
  const reject = (reason) => {
    state.rejected++;
    state.lastIssue = reason;
    return false;
  };
  const report = (signal, outcome) => {
    if (outcome === "accepted") state.accepted[signal]++;
    else {
      if (outcome === "partial_success") state.partial[signal]++;
      else state.failed[signal]++;
      state.lastIssue = outcome;
    }
  };
  const queues = Object.fromEntries(["logs", "traces", "metrics"].map((signal) => {
    const exporter = createSignalExporter({ signal, endpoint, headers: options.headers,
      proxyUrl: options.proxyUrl, timeoutMillis, report });
    return [signal, new ExportQueue(exporter, {
      maxBytes: maxQueueBytes, maxRecords: maxQueueRecords,
      onRejected: signal === "metrics" ? (reason) => report(signal, reason) : reject,
    })];
  }));
  const admitEvidence = (signal, batches) => {
    const bytes = batches.reduce((sum, items) => sum + queues[signal].exporter.encode(items).byteLength, 0);
    if (state.evidenceBytes + bytes > maxSessionBytes) return reject("session_limit");
    const accepted = queues[signal].enqueueMany(batches);
    if (accepted) state.evidenceBytes += bytes;
    return accepted;
  };
  const loggerProvider = new LoggerProvider({ resource,
    logRecordLimits: { attributeCountLimit: 128, attributeValueLengthLimit: Infinity },
    loggerConfigurator: () => ({ disabled: false, minimumSeverity: 0, traceBased: false }),
    processors: [{
      onEmit(record) { stagedLogs.push(record); },
      forceFlush: () => queues.logs.flush(),
      shutdown: () => queues.logs.shutdown(),
    }],
  });
  const tracerProvider = new BasicTracerProvider({ resource, sampler: new AlwaysOnSampler(),
    spanLimits: { attributeCountLimit: 128, attributeValueLengthLimit: Infinity },
    spanProcessors: [{
      onStart() {},
      onEnd(span) { lastSpanAccepted = admitEvidence("traces", [[span]]); },
      forceFlush: () => queues.traces.flush(),
      shutdown: () => queues.traces.shutdown(),
    }],
  });
  const reader = new OnDemandMetricReader({ cardinalitySelector: () => 16 });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  const meter = meterProvider.getMeter("openrind.capture", "1");
  const counter = meter.createCounter("openrind.capture.records", {
    description: "Locally admitted capture records; not a durable-storage count",
  });
  const logger = loggerProvider.getLogger("openrind.capture", "1");
  const tracer = tracerProvider.getTracer("openrind.capture", "1");

  function attributes(type) {
    return {
      "openrind.capture.schema_version": 1,
      "openrind.producer.instance_id": instanceId,
      "openrind.evidence.stream_id": streamId,
      "openrind.evidence.id": `${instanceId}/${streamId}/${++sequence}`,
      "openrind.evidence.sequence": sequence,
      "openrind.evidence.type": type,
      ...(runId ? { "openrind.run.id": runId } : {}),
    };
  }

  function assertOpen() {
    if (closed) throw new Error("Capture producer is closed");
  }

  function status() {
    const issues = state.rejected + state.partial.logs + state.partial.traces +
      state.failed.logs + state.failed.traces;
    return structuredClone({
      ...state,
      producer: { instanceId, streamId },
      queue: Object.fromEntries(Object.entries(queues).map(([signal, queue]) => [signal, queue.size])),
      localStatus: issues ? "degraded" : "pending",
      persistentAcceptance: "unverified",
      closed,
    });
  }

  function recordPayload({ data, mediaType = "application/octet-stream", type = "application.payload",
    source = "application", attributes: extra = {}, traceparent } = {}) {
    assertOpen();
    const attrs = captureAttributes(extra);
    identifier(type, "evidence type");
    identifier(source, "evidence source");
    if (typeof mediaType !== "string" || !mediaType.length || mediaType.length > 256 ||
        /[\r\n\0]/.test(mediaType)) throw new TypeError("Invalid media type");
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new TypeError("Payload must be a string or byte array");
    }
    const ctx = traceparent === undefined ? parentContext : captureContext(traceparent);
    const length = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (length > CAPTURE_LIMITS.payloadBytes) {
      reject("payload_limit");
      return { accepted: false, reason: "payload_limit" };
    }
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const payloadId = randomUUID();
    const partCount = Math.max(1, Math.ceil(length / CAPTURE_LIMITS.chunkBytes));
    const sha256 = hash(bytes);
    const payloadAttrs = { ...attrs,
      "openrind.payload.id": payloadId, "openrind.payload.media_type": mediaType,
      "openrind.evidence.source": source,
    };
    stagedLogs = [];
    try {
      for (let index = 0; index < partCount; index++) {
        const part = bytes.subarray(index * CAPTURE_LIMITS.chunkBytes, (index + 1) * CAPTURE_LIMITS.chunkBytes);
        logger.emit({ context: ctx, body: part, attributes: { ...payloadAttrs, ...attributes(type),
          "openrind.payload.part_index": index, "openrind.payload.part_sha256": hash(part),
        } });
      }
      logger.emit({ context: ctx,
        body: { payloadId, partCount, bytes: length, sha256, status: "observed" },
        attributes: { ...payloadAttrs, ...attributes("payload.manifest") },
      });
      const accepted = admitEvidence("logs", stagedLogs.map((record) => [record]));
      if (accepted) counter.add(stagedLogs.length, { signal: "logs" });
      return { accepted, payloadId, partCount, bytes: length, sha256,
        ...(accepted ? {} : { reason: state.lastIssue }) };
    } finally { stagedLogs = undefined; }
  }

  function recordOperation({ name, startMs, endMs = Date.now(), status: outcome = "unset",
    attributes: extra = {}, traceparent } = {}) {
    assertOpen();
    identifier(name, "operation name");
    if (!Number.isSafeInteger(startMs) || startMs < 0 || !Number.isSafeInteger(endMs) || endMs < startMs) {
      throw new TypeError("Invalid operation interval");
    }
    if (!Object.hasOwn(statusCodes, outcome)) throw new TypeError("Invalid operation status");
    const attrs = captureAttributes(extra);
    const ctx = traceparent === undefined ? parentContext : captureContext(traceparent);
    const span = tracer.startSpan(name, { startTime: startMs, kind: SpanKind.INTERNAL,
      attributes: { ...attrs, ...attributes("operation") } }, ctx);
    span.setStatus({ code: statusCodes[outcome] });
    span.end(endMs);
    const spanContext = span.spanContext();
    if (lastSpanAccepted) counter.add(1, { signal: "traces" });
    return { accepted: lastSpanAccepted, traceId: spanContext.traceId, spanId: spanContext.spanId,
      traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01` };
  }

  function flush() {
    if (shutdownTask) return shutdownTask;
    flushTail = flushTail.then(async () => {
      await queues.logs.flush();
      await queues.traces.flush();
      const collected = await reader.collect();
      if (collected.errors.length) report("metrics", "collection_failed");
      queues.metrics.enqueueMany([collected.resourceMetrics]);
      await queues.metrics.flush();
      return status();
    });
    return flushTail;
  }

  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true;
    const flushed = flush();
    shutdownTask = (async () => {
      try { await flushed; }
      finally {
        await loggerProvider.shutdown();
        await tracerProvider.shutdown();
        await meterProvider.shutdown();
        await queues.metrics.shutdown();
      }
      return status();
    })();
    return shutdownTask;
  }

  return Object.freeze({ recordPayload, recordOperation, flush, shutdown, status });
}
