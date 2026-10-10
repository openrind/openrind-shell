# Openrind Capture

General application telemetry over OTLP/HTTP protobuf. This package uses the
official OpenTelemetry JavaScript SDKs, serializers, and HTTP transport.
It does not install global providers or change an application's inference route.

## Status

This is a capture foundation with a managed diagnostic client, not activation
of the full [capture specification](../../../w8-haloop-openshell-fuse-integration-plan.md).
Desktop uses the diagnostic adapter for agent exit intervals and sampled FUSE
health. The supplied Haloop release has no managed OTLP route or receiver, so
normal customer launches report diagnostics as unavailable when the route
returns 404 or 501. The code is not
connected to browser payloads, file contents, or a judge.
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

### Runtime Diagnostic Adapter

`@openrind/capture/diagnostics` exports `createRuntimeDiagnostics({ configuration })`.
Managed configuration supplies `{ endpoint, project, sandboxName, headers, revoke }`.
`headers` is an async host-only credential callback. `revoke` invalidates the
current token through the private route on producer shutdown. A producer accepts only its
configured project and sandbox. The adapter records only scalar lifecycle
fields and a whitelist of FUSE-health fields.
It never sends arbitrary input/output or raw health error strings. The general
payload API below still preserves caller-supplied bytes.

For standalone developer tests, `createRuntimeDiagnostics({ env })` accepts
`OPENRIND_DIAGNOSTICS_OTLP_ENDPOINT` and optional
`OPENRIND_DIAGNOSTICS_OTLP_AUTHORIZATION`. Managed configuration ignores these
values. Desktop does not use this environment-configured path.

Desktop discovers a route on managed agent launch. It loads the SDK bundle and
starts health polling only after valid configuration. Concurrent
sessions share one poll per sandbox. Polls run every 30 seconds through native
exec, not through a watcher or a second database connection. The last session
exit stops polling. An adopted PTY releases its extra watch. Failed discovery
is retried on a later launch, not in a background retry loop.
`runtimeDiagnostics` in Haloop status reports export and
polling health separately from the existing private capture path.

These are best-effort diagnostics, not a capture profile. FUSE counters reset
per daemon and are approximate. Older daemons have no counters. The Collector
test uses synthetic diagnostic input; live Windows Desktop/FUSE export remains
unverified. See [operator setup](../../../BUILD.md#runtime-diagnostic-setup).

### Managed Route Contract

This is the implemented **client contract for the Haloop team**. It is not a
claim that the current Haloop image supports it. No gateway source is changed
here. The host sends this request through the existing private control path:

```http
POST /diagnostics/route
Content-Type: application/json

{"contract":"openrind-runtime-diagnostics/v1","sandboxName":"example-owner"}
```

The proposed response is HTTP 200 with this shape:

```json
{
  "contract": "openrind-runtime-diagnostics/v1",
  "protocol": "http/protobuf",
  "endpoint": "https://host-reachable-otlp.example",
  "project": "example-owner",
  "sandboxName": "example-owner",
  "signals": ["traces", "logs", "metrics"],
  "authorization": "Bearer example-token",
  "expiresAtMs": 1790000000000
}
```

The timestamp above is illustrative only. A real response must use the current
time and set expiry no more than five minutes later.

The endpoint is an origin, not a signal path. URL credentials, query parameters,
and fragments are rejected. Both scope fields must match the requested sandbox.
The token must be unexpired. The server must restrict it to diagnostic ingestion
for that scope and validate payload scope; a client-side field check is not
server authorization. The client rejects tokens with a lifetime over five
minutes and refreshes within 30 seconds of expiry.

On producer shutdown, the host sends this private request:

```http
POST /diagnostics/revoke
Content-Type: application/json

{"contract":"openrind-runtime-diagnostics/v1","sandboxName":"example-owner","project":"example-owner","authorization":"Bearer example-token"}
```

HTTP 200 or 204 confirms revocation. HTTP 404 or 501 means revocation is not
available. Other failures remain visible as `credentialRevocation` status.
Tokens must still expire within five minutes because shutdown has a two-second
drain limit and cannot guarantee server revocation during a gateway outage.

HTTP 404 or 501 means `receiver_unsupported`. HTTP 401 or 403 means
`route_unauthorized`. Malformed responses mean `route_invalid`. Other errors
mean `route_unavailable`. Discovery has a three-second request deadline and a
five-second initialization deadline. It never blocks the agent launch.

The credential callback renews within 30 seconds of expiry through the same
request. Concurrent renewals share one request. Renewal cannot change the
origin or project, and a failed renewal never uses an expired token. Export
has a five-second bound to allow renewal. Final drain has a two-second bound.
Secrets are absent from renderer status and diagnostic records.

`runtimeDiagnostics.routes` reports current producers. `recent` holds at most
32 closed-route status snapshots. `phase: "ready"` means initialized, not
delivered. Sampling failures, export failures, and durable acceptance remain
separate. A validated descriptor is not proof of persistence.

The Desktop build bundles the exporter. The controller imports that asset only
after route validation. The package supports Node 22.16, as embedded in Electron
35. The ASAR test checks dependency isolation and missing-bundle behavior. A
full packaged Windows launch and real FUSE-to-Haloop export still need testing.

### General Producer API

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
