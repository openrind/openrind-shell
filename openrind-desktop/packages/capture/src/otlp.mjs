// Standard OTLP JSON encoder conforming to OTLP JSON Specification (Section 7.3)

export const SPAN_KINDS = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
};

export const STATUS_CODES = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

export function toUnixNanoString(timeMs) {
  const ms = typeof timeMs === "number" ? timeMs : new Date(timeMs || Date.now()).getTime();
  return String(BigInt(ms) * 1000000n);
}

export function formatOtlpAttribute(key, value) {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: value } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  if (Array.isArray(value)) {
    return {
      key,
      value: {
        arrayValue: {
          values: value.map((v) => formatOtlpAttribute("", v).value),
        },
      },
    };
  }
  return { key, value: { stringValue: JSON.stringify(value ?? "") } };
}

export function buildOtlpSpan({
  traceId,
  spanId,
  parentSpanId = null,
  name,
  kind = SPAN_KINDS.INTERNAL,
  startTimeMs,
  endTimeMs,
  attributes = [],
  status = { code: STATUS_CODES.OK },
}) {
  const startNano = toUnixNanoString(startTimeMs);
  const endNano = toUnixNanoString(endTimeMs || (startTimeMs ? startTimeMs + 100 : Date.now()));

  const formattedAttributes = Array.isArray(attributes)
    ? attributes.map((attr) => (attr.value ? attr : formatOtlpAttribute(attr.key, attr.val)))
    : Object.entries(attributes).map(([k, v]) => formatOtlpAttribute(k, v));

  const span = {
    traceId,
    spanId,
    name,
    kind,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: formattedAttributes,
    status: typeof status === "object" ? status : { code: status },
  };

  if (parentSpanId) {
    span.parentSpanId = parentSpanId;
  }

  return span;
}

export function buildOtlpTracesDocument({
  serviceName = "openrind-desktop",
  serviceVersion = "0.14.0",
  scopeName = "com.openrind.capture",
  scopeVersion = "1.0.0",
  spans = [],
}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "service.version", value: { stringValue: serviceVersion } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: scopeName, version: scopeVersion },
            spans,
          },
        ],
      },
    ],
  };
}
