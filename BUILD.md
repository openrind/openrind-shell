# Building And Developing Openrind Shell

This guide covers source builds. The GHCR compatibility target requires registry pull
access; [README.md](./README.md) also shows the local child-image fallback.

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

- Linux Docker host with `/dev/fuse`.
- Rust 1.95 toolchain.
- Node.js 22 and pnpm for `openeral-js` development.
- OpenShell build dependencies, including Protobuf and Z3 (Z3 is also needed at
  runtime by the patched gateway; see below).
- External PostgreSQL with TLS for primary-runtime tests.
- Optional Anthropic, AWS, and Openrind Gateway providers for live agent tests.

The primary image pulls this existing base and does not rebuild it:

```bash
docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
```

If an anonymous GHCR pull is denied, remove stale registry credentials with
`docker logout ghcr.io` and retry before changing the image source.

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

This repository does not install, start, or mutate a gateway automatically. The
operator owns the gateway and Docker `enable_fuse` decision.

In another terminal:

```bash
export OPENSHELL_BIN="$PWD/vendor/openshell/target/debug/openshell"
export OPENSHELL_GATEWAY_ENDPOINT="http://127.0.0.1:18770"

"$OPENSHELL_BIN" \
  --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  gateway info
```

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

To include a real Claude write, attach a configured provider:

```bash
export OPENRIND_SHELL_FUSE_REAL_CLAUDE=1
export OPENRIND_SHELL_FUSE_E2E_PROVIDER=claude
tests/fuse/test_openshell_e2e.sh
```

For AWS Bedrock, build `tests/fuse/Dockerfile.bedrock`, attach an `aws` provider, and
set `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, and `ANTHROPIC_MODEL`. Raw provider
credentials must never be passed with `--env`.

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

## Browser Agent Packages Build and Test

The browser agent subsystem consists of workspace packages under `openrind-desktop/packages/`:

```bash
cd openrind-desktop

# Run unit and integration tests across core, providers, artifacts, and handoff
NODE_OPTIONS="--experimental-sqlite" node --test \
  packages/browser-core/test/core.test.mjs \
  packages/browser-core/test/artifacts.test.mjs \
  packages/browser-providers/test/local-chromium.test.mjs \
  packages/browser-providers/test/browserbase.test.mjs \
  packages/browser-service/test/standalone.test.mjs \
  packaging/browser-client/step3.test.mjs \
  apps/desktop/__tests__/browser-broker.test.mjs \
  apps/desktop/__tests__/browser-handoff.test.mjs

# Build client bundles and run checksum integrity checks
cd packaging/browser-client
npm ci
node build.mjs --checks
```
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
