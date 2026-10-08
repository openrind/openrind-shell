import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export const CAPTURE_LIMITS = Object.freeze({
  chunkBytes: 4 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024,
  payloadBytes: 64 * 1024 * 1024,
  sessionBytes: 512 * 1024 * 1024,
  queueBytes: 128 * 1024 * 1024,
  queueRecords: 4096,
  metadataBytes: 64 * 1024,
});

export function identifier(value, name) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

export function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

export function captureEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Invalid OTLP endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("OTLP endpoint must be an HTTP(S) origin without credentials");
  }
  return url.origin;
}

export function captureHeaders(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid OTLP headers");
  }
  const result = {};
  for (const [name, content] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (!["x-api-key", "authorization", "x-openrind-haloop-session"].includes(key) ||
        typeof content !== "string" || !content.length || content.length > 8192 ||
        /[\r\n\0]/.test(content) || Object.hasOwn(result, key)) {
      throw new TypeError("Invalid OTLP credential header");
    }
    result[key] = content;
  }
  return { ...result, "Content-Type": "application/x-protobuf" };
}

export function captureContext(traceparent) {
  if (traceparent === undefined) return ROOT_CONTEXT;
  if (typeof traceparent !== "string" ||
      !/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(traceparent)) {
    throw new TypeError("Invalid W3C traceparent");
  }
  const ctx = new W3CTraceContextPropagator().extract(ROOT_CONTEXT, { traceparent }, {
    get: (carrier, key) => carrier[key], keys: Object.keys,
  });
  if (!trace.getSpanContext(ctx)) throw new TypeError("Invalid W3C traceparent");
  return ctx;
}

export function captureAttributes(value = {}) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Attributes must be a plain object");
  }
  const entries = Object.entries(value);
  if (entries.length > 48) throw new TypeError("Too many capture attributes");
  const result = {};
  for (const [key, item] of entries) {
    if (!key.length || key.length > 128 || key.startsWith("openrind.") ||
        /(^|[._-])(authorization|cookie|password|secret|api[-_]?key|access_token|client_token|refresh_token|bearer_token)($|[._-])/i.test(key)) {
      throw new TypeError("Reserved or sensitive capture attribute");
    }
    if (typeof item !== "string" && typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item))) {
      throw new TypeError("Capture attributes must be finite scalar values");
    }
    Object.defineProperty(result, key, { value: item, enumerable: true });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > CAPTURE_LIMITS.metadataBytes) {
    throw new TypeError("Capture metadata exceeds its limit");
  }
  return result;
}
