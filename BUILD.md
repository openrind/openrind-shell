# Building And Developing Openrind Shell

This guide covers source builds and operator tests. Read [README.md](./README.md)
first to choose a runtime. Run commands from the repository root unless a block
changes directory. Do not switch branches or replace existing sandboxes as setup.

For a browser-only trial, start at [Real Linux Browser Test](#real-linux-browser-test).
For the experimental browser CTF test, see
[Openrind CTF Runtime](openrind-desktop/packages/ctf-runtime/README.md).
It uses separate owner, challenge, and Chromium pods. It does not need
PostgreSQL, Haloop, Cyber-Zero, EnIGMA, or Claude. It is not a customer
FUSE-owner test.
For the customer Desktop path, use [Windows Desktop Source Setup](#windows-desktop-source-setup).

## Source Layout

```text
crates/openeral-fused/       PostgreSQL-backed FUSE daemon
openeral-js/                 migrations, init/import, CLI, and compatibility library
sandboxes/openeral/          primary and compatibility image runtime files
vendor/openshell/            pinned, patched OpenShell source snapshot
tests/fuse/                  FUSE conformance and real OpenShell E2E
Dockerfile.openrind-shell          primary FUSE image
Dockerfile.openrind-shell-compat   scoped-sync/PGlite compatibility image
```

The historical source-directory, Cargo-package, test build-argument, and `_openeral`
schema names remain stable for compatibility. Installed commands, environment
variables, skills, and image names use `openrind-shell`; legacy aliases are tested.

Migration V8 bridges workspace rows written by the renamed just-bash branch from
`_openrind.workspace_*` into the stable `_openeral.workspace_*` namespace. It does
not rename `_openeral.fs_*` or overwrite a compatibility row with an older mtime.
Source provenance permits a first FUSE volume to import the full just-bash home;
historical scoped workspaces keep their state-only import boundary.

The OpenShell snapshot is pinned in [`vendor/openshell/UPSTREAM`](./vendor/openshell/UPSTREAM):

```text
repository=https://github.com/NVIDIA/OpenShell.git
commit=c4b500a7de64d0b66e3ee8098f58d14299092162
tree=30d1825d5be2a631823d941188803e29f09aedd5
```

`vendor/openshell` has no nested `.git`; it contains the pristine snapshot plus the
default-off Openrind Shell FUSE patch.

## Prerequisites

- Linux Docker host with `/dev/fuse` for FUSE tests. The browser-only fixture does
  not use the FUSE device.
- Rust 1.95 toolchain.
- Node.js 22 and pnpm for `openeral-js` development.
- OpenShell build dependencies, including Protobuf and Z3 (Z3 is also needed at
  runtime by the patched gateway; see below).
- External PostgreSQL with TLS for primary-runtime tests.
- Desktop-managed Haloop and an Anthropic key for primary live Claude tests.
  Do not substitute a legacy direct-provider recipe.

The primary image pulls this existing base and does not rebuild it:

```bash
docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
```

If a GHCR pull is denied, check the exact image name, Docker context, and registry
credentials. Do not remove a user's registry login without approval. Do not
rebuild NVIDIA's Community base to work around image resolution.

## OTLP Capture Library Tests

The standalone `@openrind/capture` package emits application telemetry through
standard OTLP/HTTP protobuf. It is not enabled in customer Desktop sessions.
Use Node.js 22.19 or later and the Desktop workspace's pinned pnpm version.

```bash
cd openrind-desktop
pnpm install --frozen-lockfile
pnpm --filter @openrind/capture test
pnpm --filter @openrind/capture test:collector
```

Unit tests use local HTTP fixtures. The collector test needs a local Linux
Docker daemon. It starts a digest-pinned OpenTelemetry Collector, verifies all
three signals, reconstructs a 17 MiB byte payload, and removes its own resources.
It needs no database, model key, OpenShell gateway, or NVIDIA image build.

A passing collector test proves wire interoperability only. It does not prove
OpenShell policy routing, Haloop persistence, or completion of a capture profile.
See the [capture package](./openrind-desktop/packages/capture/README.md) for API
and failure semantics. Do not point it at the existing private JSON ingestion
endpoint and assume that endpoint supports OTLP.

## Windows Desktop Source Setup

The managed OpenShell installer targets Windows 11 and creates a dedicated WSL2
distribution named `openrind-desktop-openshell`. Running the Electron UI on Linux
is not a test of that installer. These source steps match the current scripts;
the Linux browser fixture does not validate the Windows setup.

Before starting, obtain Node.js 22.19 or newer, pnpm 10.27.0, Bun for the native
sidecar build, Docker access, and permission to install WSL2. The Windows source
launcher can also use Visual Studio Build Tools and LLVM for native builds.
Use a Windows checkout path, not an unresolved Linux path passed to PowerShell.

The source runtime needs a compatible `w8-haloop` checkout outside this repository.
It must contain `Dockerfile` and `halo-loop/Dockerfile`. Set
`OPENRIND_DESKTOP_HALOOP_SOURCE` if it is not a sibling of this repository.
If that source or the matched release assets are unavailable, report the missing
dependency. This checkout alone is not a replacement for them. Do not bypass Haloop.

In PowerShell at the repository root, install Desktop dependencies:

```powershell
pnpm --dir openrind-desktop install --frozen-lockfile
```

The installer needs
`openrind-desktop/apps/desktop/resources/openshell/ubuntu-24.04-openshell.tar.gz`.
Use the matched release artifact, or build this Desktop root filesystem when it
is absent. This is not a rebuild of NVIDIA's Community sandbox base:

```powershell
node openrind-desktop/apps/desktop/scripts/build-openshell-rootfs.mjs
```

Start the current Electron app, not the older Tauri instructions in historical
Desktop documents:

```powershell
node openrind-desktop/apps/desktop/scripts/dev-windows.mjs
```

In **Settings -> Sandbox**, complete installation and the environment checks.
Then, in a second PowerShell terminal at the repository root, build and verify
the three runtime images in the **dedicated WSL Docker daemon**:

```powershell
$env:OPENRIND_DESKTOP_HALOOP_SOURCE = 'C:\path\to\w8-haloop'
node openrind-desktop/apps/desktop/scripts/build-openshell-runtime-images.mjs
node openrind-desktop/apps/desktop/scripts/build-openshell-runtime-images.mjs --verify-only
```

Replace the illustrative path. The required local tags are
`openrind-shell-fuse:local`, `haloop-gateway:local`, and `haloop-collector:local`.
Source setup uses pull policy `Never`. Building in Docker Desktop alone does not
populate the WSL daemon. Do not rename an unrelated image to satisfy a check.

Now follow [README: First Launch](./README.md#first-launch). Save credentials in
Desktop Settings; merely creating `.env` does not populate those fields. Desktop
owns the signed Claude launch and scoped provider. Browser activation remains a
separate, unfinished integration. A normal successful Claude launch does not
mean browser pods are enabled.

## Build Openrind Shell

Rust daemon and historical Rust workspace:

```bash
cargo build --locked -p openeral-fused
cargo test -p openeral-fused
cargo clippy -p openeral-fused --all-targets -- -D warnings
cargo fmt --all --check
```

TypeScript library and initializer:

```bash
cd openeral-js
pnpm install
pnpm build
pnpm check
```

`pnpm check` runs type checking, structural lints, and unit tests, including PGlite
behavioral tests for prefix-scoped compatibility sync.

## Build Patched OpenShell

```bash
cd vendor/openshell
cargo build -p openshell-cli -p openshell-sandbox -p openshell-server
cargo test -p openshell-cli
cargo test -p openshell-driver-docker
cargo test -p openshell-policy
cargo test -p openshell-supervisor-process
```

The relevant binaries are:

```text
vendor/openshell/target/debug/openshell
vendor/openshell/target/debug/openshell-gateway
vendor/openshell/target/debug/openshell-sandbox
```

`openshell-gateway` links the system Z3 library dynamically (`libz3.so.4`, from the
`openshell-prover` crate). Z3 is therefore a runtime dependency of the gateway host,
not only a build dependency: install `libz3-4`/`libz3-dev` (Debian/Ubuntu) or
`z3-libs` (Fedora), or point `LD_LIBRARY_PATH` at an extracted copy before starting the
gateway. A missing library fails immediately with "error while loading shared
libraries: libz3.so.4".

The patch adds a public `--fuse` resource request, immutable `fuse_mounts` policy,
Docker operator/device gates, explicit inherited descriptors, FUSE INIT readiness,
critical-child supervision, bounded `on-failure:5` restart, and transient gateway
lifecycle handling. No-FUSE requests preserve the upstream path.

## Configure A Local Docker Gateway

The gateway must run the patched supervisor and explicitly enable FUSE. Generate a
temporary development identity outside the repository:

```bash
export OPENRIND_SHELL_GATEWAY_DIR="$(mktemp -d /tmp/openrind-shell-fuse-gateway-XXXXXX)"
mkdir -p "$OPENRIND_SHELL_GATEWAY_DIR/jwt" "$OPENRIND_SHELL_GATEWAY_DIR/state"
openssl genpkey -algorithm ED25519 -out "$OPENRIND_SHELL_GATEWAY_DIR/jwt/signing.pem"
openssl pkey \
  -in "$OPENRIND_SHELL_GATEWAY_DIR/jwt/signing.pem" \
  -pubout \
  -out "$OPENRIND_SHELL_GATEWAY_DIR/jwt/public.pem"
printf '%s\n' openrind-shell-fuse-dev > "$OPENRIND_SHELL_GATEWAY_DIR/jwt/kid"
```

Create `$OPENRIND_SHELL_GATEWAY_DIR/gateway.toml`, replacing `/absolute/repo` with this
checkout's absolute path:

```toml
[openshell]
version = 1

[openshell.gateway]
bind_address = "127.0.0.1:18770"
log_level = "info"
compute_drivers = ["docker"]
disable_tls = true

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.gateway.gateway_jwt]
signing_key_path = "/tmp/replace/jwt/signing.pem"
public_key_path = "/tmp/replace/jwt/public.pem"
kid_path = "/tmp/replace/jwt/kid"
gateway_id = "openrind-shell-fuse-dev"
ttl_secs = 0

[openshell.drivers.docker]
default_image = "openrind-shell-fuse:local"
image_pull_policy = "Never"
sandbox_namespace = "openrind-shell-fuse-dev"
grpc_endpoint = "http://host.openshell.internal:18770"
supervisor_bin = "/absolute/repo/vendor/openshell/target/debug/openshell-sandbox"
enable_fuse = true
```

Use the actual temporary JWT paths rather than the illustrative `/tmp/replace`
values. Start the gateway in a dedicated terminal:

```bash
vendor/openshell/target/debug/openshell-gateway \
  --config "$OPENRIND_SHELL_GATEWAY_DIR/gateway.toml" \
  --db-url "sqlite:$OPENRIND_SHELL_GATEWAY_DIR/state/gateway.db?mode=rwc"
```

This manual development flow does not install a gateway service. The operator
owns it and the Docker `enable_fuse` decision. The Windows Desktop flow instead
installs its paired, managed gateway.

In another terminal:

```bash
export OPENSHELL_BIN="$PWD/vendor/openshell/target/debug/openshell"
export OPENSHELL_GATEWAY_ENDPOINT="http://127.0.0.1:18770"

"$OPENSHELL_BIN" \
  --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  gateway info
```

### Primary FUSE Diagnostics

Use the paired CLI in the same Linux environment as its gateway. Desktop's
managed CLI is `/opt/openrind-desktop/fuse-runtime/openshell` inside
`openrind-desktop-openshell`. A manual source gateway uses the built CLI below.
Do not use a stock `openshell` on PATH as a fallback.

For a source gateway and an **existing** sandbox, replace the sandbox name:

```bash
export OPENSHELL_BIN="$PWD/vendor/openshell/target/debug/openshell"
export OPENSHELL_GATEWAY_ENDPOINT='http://127.0.0.1:18770'
export OWNER_SANDBOX='replace-with-existing-sandbox-name'
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox list
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox exec -n "$OWNER_SANDBOX" --no-tty -- openrind-shell-fused health
```

Require `state: writable`. `sandbox connect` opens a diagnostic shell; it does not
provide a signed Haloop conversation. Use Desktop to start or resume Claude.
Never infer a scoped provider ID, upload a raw Anthropic key, or create a second
writer for the workspace. Delete Desktop-owned resources through Desktop only.

## Build The Sandbox Images

Primary FUSE image:

```bash
docker build --pull=false -f Dockerfile.openrind-shell -t openrind-shell-fuse:local .
```

Compatibility image:

```bash
docker build --pull=false -f Dockerfile.openrind-shell-compat -t openrind-shell-compat:local .
```

The root Dockerfiles are canonical for local builds because their context includes
the Rust crates, `openeral-js`, and skills. Keep their equivalents under
`sandboxes/openeral/` synchronized.

`build-image.sh` automates primary sandbox creation against an already running patched
gateway:

```bash
export DATABASE_URL='postgresql://...'
export OPENSHELL_BIN="$PWD/vendor/openshell/target/debug/openshell"
export OPENSHELL_GATEWAY_ENDPOINT='http://127.0.0.1:18770'
bash build-image.sh
```

It invokes OpenShell's public build/create flow and never imports images through
containerd, changes Docker networking, or rebuilds NVIDIA's base.

## Experimental Browser Pods

This implements experimental Kernel and configured Hyperbrowser paths, not the
completed v1 release.
Read the [status and remaining gates](./openrind-desktop/packages/browser-pods/README.md).
Do not enable it for normal Desktop launches until the release gates pass. It uses the
existing FUSE fork without adding OpenShell patches.

Choose the test before installing anything. Run host commands below from the
repository root unless a block explicitly changes directories. The live runner
creates temporary resources; it is not an installer for an existing Desktop owner.

| Goal | Required setup | Live runner flags | Checks and extra evidence |
|---|---|---|---|
| First real Chromium test | **Real Linux Browser Test** below | None | 17; `evidence.json`, `page.png` |
| Hyperbrowser SDK and file APIs | Same Linux setup | `--hyperbrowser` | 26; `hyperbrowser.json` |
| Actual Argide browser functions | Linux setup plus the private kit and derived owner | `--argide` | 23; `argide.json` |
| Actual Argide widget and model | Above plus isolated backend, product seed, and a funded Gemini key | `--argide --argide-widget` | 28; `argide-widget.json`, `argide-widget.png` |

Each count includes the Kernel checks. Choose one row; do not combine the SDK
flag with the Argide flags and expect the same count. None of these tests proves
a browser-enabled Desktop/Claude/FUSE launch. They do not start a persistent UI.

Run unit and local transport tests on Node.js 22.19 or newer:

```bash
cd openrind-desktop
pnpm --filter @openrind/browser-pods install --frozen-lockfile
pnpm --filter @openrind/browser-pods test
pnpm --filter @openrind/browser-pods test:transport
cd ..
cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra -Werror \
  -fsyntax-only openrind-desktop/packages/browser-pods/native/helper.c
```

The transport test needs TCP loopback access, including port 19300. It uses a fake
CDP peer. It does not prove OpenShell or Chromium compatibility. It is not skipped
when the test runner denies sockets.

### Build Assets

The primary image recipes install the unchanged agent-browser v0.38.2 Linux
release for x64 or arm64. The manifest records its commit and SHA-256. The image
build checks both checksum and version. No browser or package is downloaded on
first use. A version check does not prove the native daemon works under OpenShell.
The installed launcher supplies Kernel settings and validates the file-action
policy before it executes the unchanged binary at `/opt/openrind/browser/agent-browser`.
Do not rely on Dockerfile `ENV`: OpenShell clears it for exec/SSH sessions.

The separate pod image requires an explicit Debian Chromium package version:

```bash
docker build --pull=false -f sandboxes/browser-pod/Dockerfile \
  --build-arg CHROMIUM_VERSION='<exact Debian package version>' \
  -t openrind-browser-pod:stage0 sandboxes/browser-pod
docker image inspect --format '{{.Id}}' openrind-browser-pod:stage0
```

Select a version available in the base image's Debian repository and record it in
the test evidence. Do not invent a version or accept `latest` in broker config.
Pre-pull or build in the gateway's Docker daemon. On Windows, use the managed WSL
daemon. The broker requires an image digest and fails preflight if it is absent.
Set `image_pull_policy = "Never"` in the gateway's `[openshell.drivers.docker]`
configuration, as in the local gateway example above. The broker and gateway must
use the same Docker daemon. The broker's local image check does not verify either
condition. Without `Never`, OpenShell can still pull during create, for example
if an image disappears after preflight or the gateway uses `Always`.
Image publication and a cross-platform tested Chromium pin remain release work.

### Real Linux Browser Test

Use this path for a first browser test from a clean checkout. It creates its own
gateway, Docker network, provider, owner, and browser pods. It does not use or
delete existing sandboxes. It uses agent-browser's built-in **Kernel** provider;
only the vendor API is emulated. Chromium and OpenShell are real.

#### 1. Check The Host

Use Linux x64, including a suitable WSL2 Linux environment, with a local Docker
daemon. The recorded live result is x64; an arm64 image build is not a live arm64
compatibility result. Run from the repository root in a Linux shell.

You need Node.js 22.19 or newer, npm for the one host relay dependency, Rust 1.95
as pinned in `vendor/openshell/rust-toolchain.toml`, and native build tools.
Debian/Ubuntu build dependencies include `build-essential`, `clang`, `libclang-dev`,
`cmake`, `pkg-config`, `libssl-dev`, `libz3-dev`, `protobuf-compiler`, and
`openssh-client`. See the vendored
[contributor guide](./vendor/openshell/CONTRIBUTING.md) for platform build details.

```bash
docker info --format '{{.ServerVersion}}'
docker context show
node --version
cargo --version
protoc --version
```

The gateway, broker, and image builds must use the same local Docker daemon.
Do not use a remote Docker context: the fixture uses host binaries and local
bridge addresses. Ensure `127.0.0.1:19770` is free for the gateway and that the
new Docker bridge can listen on ports 19770 and 19301. Port 19300 is inside the
owner's network namespace. The host needs network access to source/package
registries and the test website `example.com`.

This fixture needs **no** `/dev/fuse`, database URL, Anthropic key, Kernel account,
Haloop checkout, or running Desktop. Do not load `.env` to run it.

#### 2. Install And Build

Install just the host browser-pod package from its lockfile. This standalone
package install avoids installing the full Desktop workspace. If you already
use the workspace install, use its pnpm instructions above instead; do not mix
package managers in an existing `node_modules` directory.

```bash
npm --prefix openrind-desktop/packages/browser-pods ci --ignore-scripts --no-audit --no-fund
```

Build the native binaries. Optimize SHA-256 even for this debug build. Chromium
is a large binary; unoptimized concurrent cold identity checks caused navigation
timeouts during testing. Do not disable identity checks.

```bash
cd vendor/openshell
cargo build --locked -j 4 -p openshell-cli -p openshell-server -p openshell-sandbox \
  --config 'profile.dev.package.sha2.opt-level=3' \
  --config 'profile.dev.package.sha2.debug-assertions=false'
cd ../..
docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
docker build --pull=false \
  -f openrind-desktop/packages/browser-pods/test/live/Dockerfile.owner \
  -t openrind-browser-owner:e2e .
docker build --pull=false -f sandboxes/browser-pod/Dockerfile \
  --build-arg CHROMIUM_VERSION=154.0.8037.92-1~deb12u1 \
  -t openrind-browser-pod:e2e sandboxes/browser-pod
```

The Chromium package pin above was available and tested on 2026-10-06. If Debian
removes it, select and record a new available version. Do not omit the pin.
To check an available version, query the pod's Debian base rather than guess:

```bash
docker run --rm node:22.19.0-bookworm-slim \
  sh -c 'apt-get update >/dev/null && apt-cache policy chromium'
```

Changing the pin requires a new live result. The owner build downloads and
checksum-verifies the unchanged agent-browser release. It does not download a
browser into the owner. Do not rebuild NVIDIA's base.

#### 3. Run And Check Evidence

Run from the repository root:

```bash
node openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs
```

`OPENSHELL_BINARY_DIR`, `BROWSER_OWNER_IMAGE`, and `BROWSER_POD_IMAGE` override the
fixture defaults. A release build can use `OPENSHELL_BINARY_DIR` set to the
absolute `vendor/openshell/target/release` path. If Z3 is not installed system-wide,
set `LD_LIBRARY_PATH` to its library directory before running the fixture.

Require exit code 0 and the final `Result: passed` line. Inspect `evidence.json`:
`result` must be `passed`, `tests` must contain all 17 checks, and `cleanupError`
must be absent. Open `page.png` to inspect the screenshot. Record the commit,
architecture, image ID, versions, and evidence path when reporting a result.
Do not report only the number of unit tests.

The runner prints a private `/tmp/openrind-browser-live-*` evidence directory.
It retains `evidence.json`, `page.png`, gateway/broker logs, and failure diagnostics.
The directory also contains private test credentials; do not publish it as a whole.
It removes its containers and network on normal success or failure. Abruptly killing
the runner can leave test resources that need operator cleanup.

The owner uses the published NVIDIA base plus the real helper and pinned client.
It contains no Chromium, FUSE, Claude, Haloop, or Desktop UI. The browser pod runs
under actual OpenShell restrictions. The test covers real navigation, click/fill,
screenshots, session reuse, a delayed control lease, 17 MiB CDP in both directions,
file-action denial, a deliberate browser crash, and cleanup. It is not a
substitute for `owner-smoke.sh` in a FUSE owner or the full Desktop release gates.

#### Failure Checks

| Failure | Check |
|---|---|
| Docker socket or TCP permission error | Run the preflight commands and record the exact failure. Fix access; do not skip the live test |
| `libz3.so.4` not found | Install the runtime library or set `LD_LIBRARY_PATH`; a successful Rust build does not prove runtime linkage |
| `ws` module not found | Install the host package dependency before starting the fixture |
| Address already in use | Stop only a test process you own, or free the requested port with operator approval |
| Browser create or navigation times out | Read private gateway, pod, and helper logs; confirm the optimized debug SHA build and the image's `ip`, `nft`, and `nsenter` tools |
| Chromium package pin unavailable | Query the Debian repository as above, record a new exact pin, rebuild the pod, and rerun |
| Cleanup error | Keep the evidence and identify test resources by their recorded IDs. Do not delete unrelated containers or volumes |

### Hyperbrowser SDK Test

Complete **Real Linux Browser Test**, including both image builds, first. The
owner fixture includes locked Hyperbrowser SDK `0.91.0` and Playwright `1.59.1`.
It installs no browser in the owner. The extra test needs no vendor or LLM key.

```bash
node openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs --hyperbrowser
```

Require exit code 0, 26 checks, no cleanup error, and `result: passed` in both
`evidence.json` and `hyperbrowser.json`. Allow at least three minutes. The retained
session test waits 61 seconds; do not shorten it to make the test pass.

This runs the existing Kernel checks, then the configured SDK test through the
same owner helper and native OpenShell transport. The SDK fixture reconstructs
the sequence in `BROWSER-PODS.md`; it is **not extracted Argide code**. Use the
separate actual Argide test below to run its consumer and VNC parser. Neither
test establishes unchanged Argide compatibility.

The browser file path returned by `uploadFile` belongs to the pod. Send it with
CDP `DOM.setFileInputFiles`. Playwright's `setInputFiles(path)` checks the
client filesystem first and is not interchangeable with that operation.
The fixture checks bytes inside the page; it does not send a file to an external
website. Download archives are fetched explicitly and checked without automatic
workspace publication.

Run the independent pod-side file tests with:

```bash
npm --prefix sandboxes/browser-pod ci --ignore-scripts --no-audit --no-fund
npm --prefix sandboxes/browser-pod test
```

These independent tests check multipart limits, unsafe paths/links, ZIP content,
cancellation, and temporary-file cleanup. They do not replace the live test.

### Actual Argide Application Test

The private widget-eval kit is now tested separately. Follow
[Actual Argide Tests](openrind-desktop/packages/browser-pods/test/live/argide/README.md)
after the Linux browser setup. That guide gives the archive and source pins,
test image build, isolated backend compose file, product seed, commands, and cleanup.
Do not put the private kit or real credentials in this repository.
This kit is not a public dependency and is not downloaded by our image build.
If it is unavailable, stop the Argide test. The SDK test is a separate option,
not a substitute result. `--argide` requires the derived Argide owner image;
the ordinary `openrind-browser-owner:e2e` does not contain the private code.

`--argide` calls the actual compiled application functions inside the owner.
It checks create, initialization, VNC parsing, reconnect after 61 seconds,
byte-verified upload, and stop. It needs no real API keys and passes 23 checks.
It changes only the Hyperbrowser constructor's `baseUrl` configuration.

`--argide --argide-widget` also runs the original backend and widget with a real
model. It passed 28 checks with Gemini `gemini-2.5-flash`. The model filled and
submitted a controlled form. The receipt records real tool dispatch and
`chat.finish`; the screenshot shows the changed page and widget answer.

The backend and its fresh Mongo/Redis/Qdrant services run on the host. Chromium
runs in a real OpenShell browser pod. A test-only website rule exposes only the
fixture and public Argide API routes. No Auth0 bypass or public tunnel is used.
The optional dashboard, RAG, real logins, Desktop/Claude/FUSE, and load behavior
remain outside this result. The supplied kit needs additional real credentials
for those application features. The model key is read from the host shell by
Compose, not from Desktop settings or a repository `.env` file. The module-only
test needs no real key. Keep both claims separate in the test report.

### Broker Process

The broker runs on the gateway host. Node's SQLite database enforces a single
broker. Install the package with its production dependency, `ws@8.19.0`, at
`/opt/openrind-browser-pods`. The standalone `package-lock.json` supports `npm ci`
for that deployment. The workspace uses the existing pnpm lockfile.

Create a private JSON configuration owned by the broker user, mode 0600. This is
a template, not a ready-to-run customer configuration:

```json
{
  "listen": { "host": "172.18.0.1", "port": 19301 },
  "runtime": {
    "binary": "/opt/openshell/bin/openshell",
    "gateway": "http://127.0.0.1:18770",
    "image": "sha256:<verified local image ID>",
    "stateDir": "/var/lib/openrind-browser-pods",
    "websiteHosts": ["example.com"],
    "acceptNoSandbox": true
  },
  "owners": [{
    "serviceToken": "<random host-only base64url token>",
    "owner": {
      "id": "<native owner sandbox ID>",
      "generation": "<fresh owner generation>",
      "workspaceId": "<registered workspace ID>",
      "helperOrigin": "http://127.0.0.1:19300",
      "providers": ["kernel"]
    }
  }]
}
```

Use the actual private Docker bridge address. Never bind all interfaces or use
the gateway's port 18770 for the broker. The owner ID, generation, and workspace
come from trusted host setup, not a browser request. The Linux fixture proves a
single configured binding; ongoing owner-lifecycle observation remains unfinished.
The service token must be 32-128 base64url characters.

```bash
OPENRIND_BROWSER_PODS_EXPERIMENTAL=1 \
node openrind-desktop/packages/browser-pods/bin/broker.mjs \
  /etc/openrind-browser-pods/broker.json
```

The optional service unit is at
`openrind-desktop/packages/browser-pods/service/openrind-browser-pods.service`.
It expects an `openrind-browser` system account with Docker access and the installed
package. Docker access is host administrative authority. Review that grant before
installation. The unit supplies a private HOME/config directory for the native CLI.
Broker shutdown revokes sessions and retains incomplete cleanup in SQLite.
Startup revokes old capabilities and keeps pending resources counted against
quota. It can admit new sessions within the remaining quota. A single uncertain
create no longer blocks every restart. Cleanup retries use backoff up to one
minute. Shutdown makes one final reconciliation attempt after current tasks finish.

**Host trust limit:** native CLI forwards open plain CDP listeners on host
loopback. Other host processes can use them without the broker's owner checks.
Use this Stage 0 path only on a trusted single-user host. Loopback is not an
authentication boundary. Direct in-process `ForwardTcp` and pooled tokens remain
release work; the high-level SDK forward listener alone does not fix this.
Windows access through WSL localhost forwarding has not been tested.

### Resolve Uncertain Creates

Use the offline registry tool only during an approved maintenance window.
Stop the broker first. This ends its browser sessions, so obtain user approval
before stopping an active service. The tool refuses a locked registry.

```bash
node openrind-desktop/packages/browser-pods/bin/registry.mjs \
  /etc/openrind-browser-pods/broker.json pending
```

An empty inventory is not proof that an old native create cannot finish later.
Check the failed create and gateway operations. Keep quota reserved if the
outcome is still uncertain. Only after confirming that no request can still
create the resource, use its exact registry ID and a non-secret reason code:

```bash
node openrind-desktop/packages/browser-pods/bin/registry.mjs \
  /etc/openrind-browser-pods/broker.json resolve-absent '<session-id>' \
  --confirm-no-pending-create '<reason-code>'
```

The command accepts only a revoked, unobserved create with
`CREATE_OUTCOME_UNKNOWN`. It checks native inventory again, removes its capability,
releases its quota, and records the operator decision. It does not delete a
sandbox or treat a transient empty result as automatic proof. Restart the broker
after maintenance. Terminal records and audit entries expire after 24 hours in
bounded batches; unresolved records do not expire.

### Owner Activation

This step is still explicit developer provisioning. No production Desktop UI calls
it. `browserPodBinding()` in `browser-binding.mjs` creates the native profile and
network rule. `attachBrowserPodProvider()` in `browser-provider.mjs` can attach it
through the existing Windows/WSL runtime. Linux setup uses the same native profile
import and provider attach commands. A common cross-platform installer is pending.

The profile grants the dedicated helper the Kernel routes, the Hyperbrowser
session/upload/archive routes, and WebSocket upgrades at `/control` and `/cdp/*`.
It uses `protocol: rest`, `tls: none`, one bridge `/32`, and no request-body or
WebSocket-frame credential rewrite. Store the real token only in the host broker
config and OpenShell provider. The helper receives `OPENRIND_BROWSER_POD_TOKEN`
as a native provider placeholder. Do not copy the host token into the sandbox.
An owner's `providers` list is the broker's adapter grant. Keep `["kernel"]` for
the default path. For a configured Hyperbrowser client, explicitly add
`"hyperbrowser"`. Set `compatibilityProfile: "argide-0.91-browser-pods-v1"` in
that trusted owner object only when accepting the documented feature no-ops.
Clients cannot choose the profile in a request. Configure the SDK before launch:

```javascript
const client = new Hyperbrowser({
  apiKey: 'openrind-compat',
  baseUrl: 'http://127.0.0.1:19300',
});
```

This is supported base-URL configuration, not vendor-domain interception.
The primary image does not install the Hyperbrowser SDK for arbitrary projects;
the test-only owner contains its pinned fixture dependencies.
Attachment refresh is asynchronous. Wait for a new exec process to receive the
placeholder before starting the helper. Attaching a provider does not update the
environment of an already-running Claude process.

Trusted provisioning must install `/etc/openrind-browser-pods/helper.json`, owned
by root and not writable by the agent:

```json
{
  "brokerOrigin": "http://host.openshell.internal:19301",
  "generation": "<same owner generation as the broker>"
}
```

The new primary image's client launcher supplies Kernel defaults at invocation
and checks a root-owned action policy. Image ENV is not sufficient. The launcher
uses a non-secret `KERNEL_API_KEY` only for client compatibility; never put the
host broker token there. Start a fresh shell after attaching the provider. Do not
reuse an agent-browser daemon started with other settings. In that shell:

```bash
OPENRIND_BROWSER_PODS_EXPERIMENTAL=1 openrind-browser-pod-ensure
node /opt/openrind-browser-pods/bin/helper-probe.mjs
```

The helper is detached with its native parent intact. It serves one sandbox's
loopback port 19300. It stops on broker connection loss. It does not restart or
replay browser operations automatically. Client policy validation is a guardrail;
arbitrary client flags and user configuration are not a server-side boundary.

Run the installed-client smoke from the host against a disposable enabled owner:

```bash
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox exec -n "$OWNER_SANDBOX" --no-tty -- /bin/sh -s \
  < openrind-desktop/packages/browser-pods/test/live/owner-smoke.sh
```

This stores evidence on FUSE. It does not test the full failure matrix, concurrent
create latency, or Argide. Use the separate live fixtures for credential injection
and the actual Argide tests. Desktop/Claude/FUSE and load checks still block release.
Existing owner containers are not patched automatically. Do not delete or replace
one to obtain these assets without a separate user-approved migration.

## Real FUSE E2E

The Docker-driver harness requires a running patched gateway and an image whose policy
allows the supplied database host:

```bash
export DATABASE_URL='postgresql://...'
export OPENSHELL_GATEWAY_ENDPOINT='http://127.0.0.1:18770'
export OPENSHELL_XDG_CONFIG_HOME="$HOME/.config"
export OPENRIND_SHELL_FUSE_E2E_IMAGE='openrind-shell-fuse:local'

tests/fuse/test_openshell_e2e.sh
```

It verifies:

1. supervisor-owned mount at `/sandbox/work`;
2. eight filesystem conformance cases;
3. fsynced sentinel durability;
4. critical daemon exit causing container restart and lease-epoch advance;
5. persistence after sandbox delete/recreate with the same workspace ID.

The crash-restart assertion uses Docker inspection and therefore intentionally targets
the v1 Docker driver.

For a real primary Claude write, use Desktop's signed Haloop launch and verify the
file and final flush in that session. The harness's historical real-Claude/provider
flags and the Bedrock overlay are not a validated route through the current
required Haloop contract. Do not attach a direct Anthropic or AWS provider to make
this test pass. Storage conformance, browser transport, and signed agent inference
are separate test results. Raw provider credentials must never use `--env`.

### Local TLS PostgreSQL Fixture

The production policy permits Supabase poolers. For local testing,
`tests/fuse/postgres-fixture/` provides a reproducible TLS PostgreSQL via Docker
Compose plus a certificate generator (see its README):

```bash
tests/fuse/postgres-fixture/gen-certs.sh
cp tests/fuse/postgres-fixture/.env.example tests/fuse/postgres-fixture/.env
# edit .env: set POSTGRES_PASSWORD
docker compose -f tests/fuse/postgres-fixture/docker-compose.yml up -d --wait
export DATABASE_URL="postgresql://postgres:<password>@172.17.0.1:55432/postgres"
```

A private fixture needs a derived test image that trusts the fixture CA and allows
its exact host and port. `BASE_IMAGE` must name your primary image tag:

```bash
docker build \
  -f tests/fuse/Dockerfile.local-postgres \
  --build-arg BASE_IMAGE=openrind-shell-fuse:local \
  --build-arg OPENERAL_TEST_DB_HOST=172.17.0.1 \
  --build-arg OPENERAL_TEST_DB_PORT=55432 \
  -t openrind-shell-fuse-localdb:test \
  tests/fuse/postgres-fixture/context
```

The fixture PostgreSQL server must present a TLS certificate chaining to `ca.crt`
(the compose fixture does). The overlay adds that CA and an exact raw-tunnel policy
route; it does not disable PostgreSQL TLS. Point `OPENRIND_SHELL_FUSE_E2E_IMAGE`
at the derived tag when running the E2E, and tear the fixture down with
`docker compose -f tests/fuse/postgres-fixture/docker-compose.yml down -v`.

## Compatibility And Library Tests

The old Docker-only scripts now build the compatibility image explicitly:

```bash
DATABASE_URL='postgresql://...' tests/test_sandbox_e2e.sh
DATABASE_URL='postgresql://...' tests/test_setup_e2e.sh
```

Host-side custom-agent and memory tests remain under `openeral-js`:

```bash
cd openeral-js
DATABASE_URL='postgresql://...' node test-integration.mjs
DATABASE_URL='postgresql://...' node test-memory-refresh.mjs
```

`createOpenrindShell()` exposes `/db`, `/home/agent`, and `/tmp` through just-bash for
custom agents. That path is independent of the primary kernel FUSE mount.

## Custom PostgreSQL Hosts

Add a raw tunnel route and both migration/daemon binaries:

```yaml
network_policies:
  postgres:
    endpoints:
      - { host: db.example.com, port: 5432, tls: skip }
    binaries:
      - { path: /usr/bin/node }
      - { path: /usr/local/bin/openrind-shell-fused }
```

`tls: skip` applies to OpenShell inspection, not PostgreSQL. It tells OpenShell to
relay the tunnel; Node/Rust then require and verify PostgreSQL TLS end to end.

## Source And Rollout Rules

- Never grant mount syscalls or `/dev/fuse` to Claude.
- Never start `openrind-shell-fused` outside the normal hardened `ProcessHandle` path.
- Never make Rust own schema migration.
- Never run a watcher beside FUSE in the primary image.
- Never selectively omit generated/vendor changes from commits; ignore artifacts only
  through `.gitignore`.
- Rebase the pristine OpenShell pin before carrying the patch to materially different
  upstream mount, process, or lifecycle code.
- Keep the published scoped-sync image stable until FUSE correctness, fault,
  performance, and upstream/release gates are complete.

The detailed contract and rejected alternatives are in
[FUSE-DESIGN.md](./FUSE-DESIGN.md) and [FUSE.md](./FUSE.md).
# Required production image publication

Before packaging Desktop, publish the sandbox image and run the root
`Publish matched Haloop images` workflow with a reviewed full commit SHA from
`openrind/w8-haloop`. Configure `HALOOP_SOURCE_READ_TOKEN` as a read-only repository
secret because that fork is private. Both Haloop image labels must match the
Desktop contract and pinned version before either image is pushed.

Set the three GHCR packages (`sandbox`, `haloop-gateway`, `haloop-collector`) to
public in their package settings. Publishing does not change package visibility.
The workflow and Desktop packaging commands verify anonymous manifests; a failed
check blocks packaging. Do not ship an installer while this check fails. No
customer registry login or direct-provider fallback is required or supported.
