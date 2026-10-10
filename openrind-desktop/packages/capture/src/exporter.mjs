import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { ExportResultCode, suppressTracing } from "@opentelemetry/core";
import { createOtlpHttpExportDelegate } from "@opentelemetry/otlp-exporter-base/node-http";
import {
  ProtobufLogsSerializer, ProtobufTraceSerializer, ProtobufMetricsSerializer,
  LogsExporterMetricsHelper, TraceExporterMetricsHelper, MetricsExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";
import { getProxyForUrl } from "proxy-from-env";
import { captureHeaders, CAPTURE_LIMITS } from "./contracts.mjs";

const signals = {
  logs: [ProtobufLogsSerializer, LogsExporterMetricsHelper, "rejectedLogRecords"],
  traces: [ProtobufTraceSerializer, TraceExporterMetricsHelper, "rejectedSpans"],
  metrics: [ProtobufMetricsSerializer, MetricsExporterMetricsHelper, "rejectedDataPoints"],
};

async function readHeaders(provider, timeoutMillis) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => captureHeaders(typeof provider === "function" ? await provider() : provider)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Credential refresh timed out")), timeoutMillis); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Exporter-base is pinned. The public signal exporters do not expose partial
// success to callers, so wrap its official serializer instead of copying OTLP.
export function createSignalExporter({ signal, endpoint, headers, timeoutMillis, proxyUrl, report }) {
  const [serializer, helper, rejectedField] = signals[signal];
  const url = `${endpoint}/v1/${signal}`;
  let current;
  let agent;
  const delegate = createOtlpHttpExportDelegate({
    url,
    headers: () => readHeaders(headers, timeoutMillis),
    timeoutMillis,
    concurrencyLimit: 1,
    compression: "none",
    agentFactory: async (protocol) => {
      const proxy = proxyUrl === undefined ? getProxyForUrl(url) : proxyUrl;
      if (proxy) {
        const { HttpProxyAgent } = await import("http-proxy-agent");
        const { HttpsProxyAgent } = await import("https-proxy-agent");
        agent = protocol === "https:" ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy);
      } else {
        const { Agent } = await import(protocol === "https:" ? "node:https" : "node:http");
        agent = new Agent({ keepAlive: true });
      }
      return agent;
    },
  }, {
    serializeRequest: () => current.bytes,
    deserializeResponse(bytes) {
      current.responseSeen = true;
      try {
        const response = serializer.deserializeResponse(bytes);
        const partial = response.partialSuccess;
        const rejected = BigInt(partial?.[rejectedField] ?? 0);
        if (rejected < 0n) throw new Error("Invalid rejection count");
        if (rejected > 0n) {
          current.result = "partial_success";
        }
        // Do not send collector-provided text to a process-wide diagnostic logger.
        if (partial?.errorMessage) partial.errorMessage = "Collector reported a warning";
        return response;
      } catch {
        current.result = "invalid_response";
        return {};
      }
    },
  }, `openrind_otlp_${signal}`, helper, undefined);

  return {
    encode: (items) => serializer.serializeRequest(items),
    async send(packet) {
      if (current) throw new Error("Concurrent export is not supported by this queue");
      current = packet;
      try {
        return await context.with(suppressTracing(ROOT_CONTEXT), () => new Promise((resolve) => {
          delegate.export(packet.items, (result) => {
            const outcome = packet.result || (result.code === ExportResultCode.SUCCESS
              ? (packet.responseSeen ? "accepted" : "response_unknown") : "export_failed");
            report(signal, outcome);
            resolve(outcome);
          });
        }));
      } catch {
        report(signal, "export_failed");
        return "export_failed";
      } finally {
        current = undefined;
      }
    },
    async shutdown() { await delegate.shutdown(); agent?.destroy(); },
  };
}

export class ExportQueue {
  #pending = [];
  #draining;
  #closed = false;
  #bytes = 0;
  #count = 0;

  constructor(exporter, { maxBytes, maxRecords, onRejected }) {
    this.exporter = exporter;
    this.maxBytes = maxBytes;
    this.maxRecords = maxRecords;
    this.onRejected = onRejected;
  }

  get size() { return { bytes: this.#bytes, records: this.#count }; }

  enqueueMany(batches) {
    if (this.#closed) { this.onRejected("closed"); return false; }
    const packets = batches.map((items) => ({ items, bytes: this.exporter.encode(items) }));
    if (packets.some((packet) => !packet.bytes || packet.bytes.byteLength > CAPTURE_LIMITS.requestBytes)) {
      this.onRejected("request_limit"); return false;
    }
    const bytes = packets.reduce((sum, packet) => sum + packet.bytes.byteLength, 0);
    if (this.#bytes + bytes > this.maxBytes || this.#count + packets.length > this.maxRecords) {
      this.onRejected("queue_limit"); return false;
    }
    this.#bytes += bytes;
    this.#count += packets.length;
    this.#pending.push(...packets);
    this.#kick();
    return true;
  }

  #kick() {
    if (this.#draining) return;
    this.#draining = Promise.resolve().then(async () => {
      while (this.#pending.length) {
        const packet = this.#pending.shift();
        try { await this.exporter.send(packet); }
        finally {
          this.#bytes -= packet.bytes.byteLength;
          this.#count--;
        }
      }
    }).finally(() => {
      this.#draining = undefined;
      if (this.#pending.length) this.#kick();
    });
  }

  async flush() { while (this.#draining) await this.#draining; }

  async shutdown() {
    this.#closed = true;
    await this.flush();
    await this.exporter.shutdown();
  }
}
