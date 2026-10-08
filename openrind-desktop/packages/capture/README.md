# Openrind Capture

General application telemetry over OTLP/HTTP protobuf. This package uses the
official OpenTelemetry JavaScript SDKs, serializers, and HTTP transport.
It does not install global providers or change an application's inference route.

## Status

This is a standalone capture foundation, not activation of the full
[capture specification](../../../w8-haloop-openshell-fuse-integration-plan.md).
It is not connected to Desktop launches, browser relays, FUSE, or a judge.
It does not implement an autonomous agent or a training-data pipeline.

Implemented:

- Completed operation spans, byte-valued payload logs, and bounded-label health metrics.
- Explicit W3C parent context and resource/producer identity.
- 4 MiB payload chunks, per-part hashes, and a whole-payload manifest.
- Bounded queues with atomic admission of a payload and its manifest.
- Official HTTP retries with unchanged encoded request bytes.
- Visible partial rejection, malformed responses, uncertain responses, and export errors.
- Credential-header callbacks for renewal and HTTP(S) proxy support.

Not implemented: persistent retry storage, producer registration, credential
issuance, source seals, profile reconciliation, server-side repair, or durable
completion. A dropped export is visible locally but is not recovered after this
process exits. `flush()` and `shutdown()` always report
`persistentAcceptance: "unverified"`. Neither method can certify a run complete.

## API

```js
import { createCapture } from "@openrind/capture";

const capture = createCapture({
  endpoint: "http://127.0.0.1:4318",
  serviceName: "document-service",
  serviceVersion: "1.0.0",
});

const startMs = Date.now();
const result = "Example document result";
const operation = capture.recordOperation({
  name: "document.read",
  startMs,
  endMs: Date.now(),
  status: "ok",
});
const payload = capture.recordPayload({
  data: result,
  mediaType: "text/plain; charset=utf-8",
  type: "application.result",
  traceparent: operation.traceparent,
});

// Local admission is not OTLP acceptance or persistent acceptance.
if (!operation.accepted || !payload.accepted) {
  // Surface the loss to the application's capture-status handler.
}
const status = await capture.shutdown();
```

`recordOperation()` records a completed interval. It does not infer tool
execution or model behavior. It creates an ordinary OTel INTERNAL span.
`recordPayload()` accepts a UTF-8 string or byte array. It preserves that content
without a training-data filter. Raw data can contain sensitive application
content. Use an approved destination and access policy.

`traceparent`, `runId`, `instanceId`, and `streamId` are optional constructor
inputs. Instance and stream IDs default to new UUIDs. Caller-supplied run IDs
are correlation only. This library cannot authenticate those claims.

`headers` accepts a static map or an async function. The function runs on each
HTTP attempt and can obtain renewed credentials from the caller's approved
provisioning mechanism. Only `x-api-key`, `authorization`, and
`x-openrind-haloop-session` are accepted. Header values are never added to payloads
or status output. Refresh failure does not fall back to another credential.

HTTP(S) proxy selection uses `proxy-from-env`, including `NO_PROXY`. An explicit
`proxyUrl` overrides that selection. Use `proxyUrl: ""` only for an intentionally
direct host-local fixture. Do not use it to bypass a sandbox proxy. TLS uses
Node's normal certificate validation. There is no TLS-disable option.

## Limits and Failure Behavior

| Limit | Default |
|---|---|
| One payload | 64 MiB |
| One payload part | 4 MiB |
| One uncompressed protobuf request | 8 MiB |
| Encoded pending data, per signal queue | 128 MiB |
| Pending export batches, per signal queue | 4096 |
| Admitted evidence bytes per producer | 512 MiB |
| Metadata per record | 64 KiB, up to 48 caller attributes |
| Export timeout setting | 10 seconds |

`maxQueueBytes`, `maxQueueRecords`, and `maxSessionBytes` can lower the defaults.
They cannot raise them. The session budget counts encoded evidence, including
envelope overhead. The queue limits include in-flight requests. They are not a
bound on total JavaScript heap use; serialization also uses temporary buffers.

Oversized data returns `accepted: false`; it is not clipped. Rejected payload
groups leave sequence gaps and increment the local rejection count. No gap or
seal protocol is implemented yet. Do not claim the full spec's completeness
contract from these counters.

The exporter uses the SDK's bounded retry policy for transient failures. Failed
exports leave the memory queue and mark evidence health degraded. There is no
second application retry loop and no durable spool. The timeout is an SDK
transport setting, not a hard deadline for draining a queue of many requests.
Callers must await shutdown before terminating the process.

Partial success and an interrupted or malformed success response never count as
accepted batches. Do not replay a partially accepted batch from this library.
Repair needs a server-side record-ID check that is not implemented here.
Health metric failures remain separate from log/trace evidence health.

Status counters count export batches. `localStatus: "pending"` means no known
local evidence loss; it does not mean capture is complete. `degraded` remains
set after a lost or rejected evidence record. Optional metric errors remain
visible in their own counters.

## Why Exporter-Base Is Pinned

The signal exporters report partial success through process-wide diagnostics,
not their result callback. They can also report success when the response body
is malformed or interrupted. This package decorates the official serializers
to retain that distinction. It uses the upstream transport, retry policy, and
protobuf codecs; it does not copy those implementations.

`@opentelemetry/otlp-exporter-base` is an internal support package despite its
exported entrypoints. Its exact version is pinned. An upgrade must pass all unit
and real-collector tests. Keep process-wide OTel debug logging disabled when
captured content must not appear in diagnostic logs.

## Tests

From `openrind-desktop/`:

```bash
pnpm install --frozen-lockfile
pnpm --filter @openrind/capture test
pnpm --filter @openrind/capture test:collector
```

Unit tests use local HTTP fixtures for failures and policy checks. The collector
test runs a digest-pinned OpenTelemetry Collector 0.145.0 in local Linux Docker.
It needs no provider key, database, browser, or OpenShell image. It reconstructs
a 17 MiB payload from the collector's decoded output and checks hashes and trace
context. It removes only its own container and temporary files.

This proves standard collector interoperability. It does not prove the
OpenShell proxy route, Haloop ingestion, Haloop persistence, or application
instrumentation. Those remain separate integration work.
