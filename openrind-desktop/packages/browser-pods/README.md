# Experimental Browser Pods

This package implements the experimental Kernel and configured Hyperbrowser paths in
[BROWSER-PODS.md](../../../BROWSER-PODS.md). It is not a completed browser product.
Normal Desktop launch does not enable it. Development setup is in
[BUILD.md](../../../BUILD.md#experimental-browser-pods).

## First Run

For a new Linux checkout, follow
[Real Linux Browser Test](../../../BUILD.md#real-linux-browser-test). It installs
the host dependency, builds the native runtime and both images, and runs the
isolated fixture. It needs no provider keys or database. Require exit code 0,
17 checks, a screenshot, and no cleanup error. It removes its own sandboxes.

For normal Claude use, follow the root
[Desktop guide](../../../README.md#start-claude-in-desktop). Browser pods are not
enabled by that flow. `openrind-browser` is an in-owner action skill, not a host
installer. Use `openrind-dev` for this package's setup and tests.

The agent-browser path uses its built-in `kernel` provider with
`KERNEL_ENDPOINT=http://127.0.0.1:19300`. Our API creates real Chromium pods; it
does not contact Kernel cloud. The compatibility key is non-secret. Native
OpenShell provider injection supplies the separate real broker credential.

## Implemented

- A private SQLite registry with one broker lock, owner quotas, create intent,
  deadlines, cleanup-pending state, leases, and restart cleanup. Indexed lookups
  avoid scanning history. Bounded maintenance removes terminal rows and audit
  entries after 24 hours; unresolved resources keep their quota.
- Recovery admits new work within the remaining quota. Failed cleanup uses
  bounded backoff. An offline operator command resolves an uncertain create only
  after explicit confirmation that no pending native create can still complete.
- `POST /browsers` and `DELETE /browsers/{id}` for the pinned agent-browser Kernel
  provider. Unsupported routes return errors. No request falls back to a vendor.
- Hyperbrowser SDK `0.91.0` create/get/list/stop routes through the same session
  core. A trusted owner can select `argide-0.91-browser-pods-v1` to accept the
  documented Argide options with explicit no-op warnings. This is not full vendor parity.
- Streaming multipart uploads into an opaque pod-local path, plus explicit ZIP
  archives of completed files in `/tmp/downloads`. The helper relays bytes without
  parsing CDP or translating paths. Stop revokes transfers and archive access.
- A fixed owner helper at `127.0.0.1:19300`. Its broker connections require the
  OpenShell HTTP CONNECT proxy. There is no direct-dial fallback or file translation.
- Native OpenShell create, exec, and `forward service` calls. No supervisor,
  gateway, TLS, or FUSE source was changed for browser pods.
- A separate headless Chromium image, a detached pod agent, control leases,
  browser-instance checks, and confirmed process-group stop with deletion fallback.
  Transient lease errors have an eight-second no-success window. Definite browser
  or forward loss still revokes immediately. The pod has its own 15-second lease.
- Primary image recipes for agent-browser v0.38.2, release checksums, license,
  native upload/download/`wait --download` denial policy, helper, and the `openrind-browser` skill.
  A launcher supplies Kernel defaults before it executes the unchanged binary.
  OpenShell exec/SSH sessions clear image environment variables.
- Removal of the old automatic Desktop MCP launch hook. The new Claude wrapper
  ignores the retired managed descriptor and credentials. User MCP configuration
  and Control Chrome are unchanged. The FUSE contract remains v29.

## Not Ready

The following are release gates, not optional follow-up tests:

- Full Desktop activation with a real Claude skill session and FUSE screenshot
  persistence. The passing Linux fixture below has a browser-only owner image.
- Cold-start and health-probe tail latency under concurrent load. The current
  SQLite path is synchronous; it must not delay the client's three-second probe.
- Whole-process memory and file limits. The current relay limits each assembled
  message to 64 MiB and queued sends to 128 MiB. Partial messages inside `ws`
  receivers are not included in that shared budget. Do not claim a 128 MiB total
  process-memory bound.
- Direct in-process ForwardTcp with pooled tokens, plus capacity and failure
  tests. The current adapter uses two unauthenticated host-loopback CLI listeners.
  Any host process can reach CDP without broker ownership checks. This Stage 0
  path requires a trusted single-user host. WSL-to-Windows reachability is not
  tested. The CLI issues a token per accepted connection, not two pooled tokens.
- A complete host activation/retirement transaction, owner-runtime identity
  checks, and Windows/WSL installation. Static host configuration is for Stage 0
  only. The broker currently learns owner loss from the helper, not a separate
  gateway lifecycle watch.
- Safe updates for existing containers. Removing the source launch hook does not
  patch old images. Do not replace a live FUSE owner or bump its contract to work
  around this. The in-place retirement installer is still required.
- Full application and general website coverage for Argide. The configured
  actual-module test and one real widget/model task pass. They do not prove the
  optional Auth0 dashboard, RAG, login, or unchanged application compatibility.
- Artifact capacity under concurrent load and explicit durable FUSE export.
  Files remain browser-local until a client fetches bytes. Browser data is
  ephemeral. There is no viewer or sidebar.
- Sustained-load and large-history registry tests. Unit tests cover retention and
  operator resolution, not their performance under load. An unobserved timed-out
  create retains quota. A single empty inventory result is not proof that
  allocation cannot arrive later.

## Test Evidence

Unit tests cover session transitions, ownership, quota, late creates, stop
acknowledgement, restart cleanup, Kernel fields, proxy-only routing, relay
backpressure, configuration checks, and Claude/FUSE regression behavior. They also
check that slow deletion does not block other lease requests or access revocation,
and that malformed control and CDP replies fail without an uncaught exception.
They cover uncertain recovery, cleanup backoff, registry migration/retention,
operator confirmation, lease grace, and client cancellation without killing create.

`test/live/transport.test.mjs` uses real TCP and WebSockets with a fake CDP peer.
It checks the route, a 17 MiB payload, close codes, helper replacement, and the
two-second DELETE deadline with an unresponsive stop handler. It does not test Chromium or native
OpenShell credential injection. It fails rather than silently skips if the runner
cannot bind a port.

`test/live/owner-smoke.sh` runs the installed binary inside an explicitly enabled
FUSE owner. It saves screenshot evidence on `/sandbox/work`. It is a smoke test,
not the full Stage 0 acceptance suite.

On 2026-10-06, all 68 browser-pod unit tests, all 8 pod file/startup tests,
all 279 Desktop OpenShell tests,
Electron typecheck, and the real TCP/WebSocket test passed. The transport test
relayed its 17 MiB payload through the helper and broker with a fake CDP peer.

`test/live/openshell-e2e.mjs` also passed against a real isolated Docker gateway,
the vendored supervisor, Chromium 154.0.8037.92, and the unchanged agent-browser
v0.38.2 Linux x64 release. Its 17 checks cover runtime provider attachment,
HTTP/WebSocket credential injection, navigation, snapshots, screenshots,
click/fill, session reuse, destination denial, client file-action denial,
browser-crash replacement, client DELETE, and confirmed registry cleanup. They
also pause the pod control forward for 3.5 seconds without losing the browser,
and send a 17 MiB CDP request and response through the real OpenShell proxy.
Seccomp, Landlock, executable identity checks, and the website allowlist remain on.

One run created and navigated in 4.4 seconds. Ten later commands took 91-106 ms
each, including native exec. These are samples, not concurrent-load p95/p99 claims.
The owner has no FUSE, Claude, Haloop, or Desktop UI. Screenshot evidence is saved
on its temporary disk and copied to the host. This does not prove FUSE persistence
or Argide compatibility. The remaining release gates above still apply.

The test found and fixed missing Docker build-context files, overlong pod names,
missing OpenShell network tools in the pod image, and missing client settings in
exec sessions. An unoptimized SHA-256 build of the supervisor also caused cold
Chromium identity checks to outlast navigation timeouts. The passing run optimized
the `sha2` dependency, without changing security checks. See BUILD.md for the
exact build command and evidence files.

`test:hyperbrowser` extends the native test with the pinned SDK and Playwright
inside the owner. It tests the documented option profile, list/get, retained
state after a 61-second disconnect, a 2 MiB multipart upload, browser-side hash
verification through CDP, a real browser-local download, ZIP hashes/content,
and idempotent stop with archive revocation. It requires both images rebuilt
from this checkout. See BUILD's **Hyperbrowser SDK Test**.

The combined test passed on 2026-10-06 with all 26 checks and no cleanup
errors. It used Hyperbrowser SDK `0.91.0` and Playwright `1.59.1` on Linux x64
under WSL2. The run used the default Docker context and an isolated native
OpenShell gateway. No vendor, LLM, or database key was needed. The test changed
the SDK's base URL; it did not intercept Hyperbrowser's domain or run Argide.
That SDK-only fixture remains distinct from the actual application tests below.

### Actual Argide

The supplied kit returned on 2026-10-06. `--argide` now imports its real compiled
backend-core bundle inside the owner. The combined 23-check run passed create,
initialization, its VNC parser, a 61-second reconnect, exact 2 MiB upload bytes,
and stop. The build verifies the original source hash and changes only the
Hyperbrowser `baseUrl` constructor option. It uses the original SDK and Playwright
dependencies. It does not reimplement those functions in the fixture.

`--argide --argide-widget` also passed all 28 combined checks. It used the original
backend image, Mongo replica set, Redis, Qdrant, Gemini `gemini-2.5-flash`, and the
original widget in OpenShell Chromium. The model dispatched
`capture_screen_for_action`, `batch_fill_form`, and `perform_action`. The page
showed the expected submitted values, and the backend emitted `chat.finish`.
The driver supplied only the chat request and test-page approvals.

See [Actual Argide Tests](test/live/argide/README.md) for pins and repeatable steps.
The backend runs in host Docker, not inside the owner. Its model calls do not
go through the owner's OpenShell policy. The widget's website/API traffic does.
Early widget attempts failed during hot policy setup. The fixture now includes
its narrow website rule in the initial pod policy, before provider create.
No website-policy bypass was added. Auth0/dashboard, RAG, real website logins,
load, and Desktop/FUSE results remain unverified.

The file API caps each upload or ZIP at 256 MiB, with at most 256 stored objects
and one active file transfer per session. The service reserves space within a
512 MiB spool budget. Archive preparation also counts source bytes. The pod's
1 GiB `/tmp` tmpfs is the hard limit shared with the browser profile and downloads.
Arbitrary CDP-selected download directories are not part of the archive API.
Completed ZIPs are immutable API objects; a changed inode, timestamp, or hash
causes an error, not a successful archive stream. A failed archive is not retried
silently for an unchanged file snapshot.

Chromium startup waits for tentative IPv6 addresses and route changes to settle,
with a five-second limit. Live tests found that a late address change could cancel
the first navigation with `ERR_NETWORK_CHANGED`. This check changes no network
permission and does not retry website actions. `BROWSER_POD_DIAGNOSTICS=1` on the
host enables private Chromium net logs for diagnosis. Those logs can contain
website data; do not publish them.

## Operation Rules

Run one broker per gateway under a dedicated host account. Its gateway/Docker
access is trusted host authority, not a sandbox permission. Keep its configuration,
SQLite database, and service token private. Database or lock failures prevent
startup. Pending native cleanup does not prevent startup; it keeps its quota and
retries with backoff. See [Resolve Uncertain Creates](../../../BUILD.md#resolve-uncertain-creates)
for the offline operator procedure. Never infer permanent absence from one empty
inventory response.

Use an operator-supplied, pre-pulled browser image digest. Set the native Docker
driver's `image_pull_policy` to `Never`, and use the same Docker daemon for the
broker and gateway. Local preflight alone cannot prevent a gateway image pull.
The broker accepts a website allowlist and requires explicit acceptance of
Chromium's `--no-sandbox` mode. Do not grant pod access to the broker or gateway.

Only the host writes helper configuration and provider grants. All processes in
one owner sandbox share its browser authority. The helper port is not a separate
user security boundary. CDP gives full control of that owner's browser.

Stop revokes access immediately. Kernel returns 204 only after confirmed browser
stop. Hyperbrowser returns 200 with `success: true` under the same stop condition.
Container deletion can continue, but quota remains reserved. An uncertain stop
returns an error. Gateway, broker, helper, or browser failure can end the session.
Do not replay a website mutation to recover it.

A new control registration from the same owner generation replaces a stale
socket. Closing that stale socket does not revoke the replacement. Losing the
current helper still ends its sessions. Normal WebSocket close codes and reasons
pass through the relay; abnormal disconnections terminate it.
