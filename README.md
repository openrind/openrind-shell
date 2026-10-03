# Openrind Shell

Run Claude Code in an isolated OpenShell sandbox with a PostgreSQL-backed native
project filesystem. In the primary runtime, project files live on the FUSE mount at
`/sandbox/work`, while Claude's high-churn home state lives on a per-workspace Docker
volume at `/sandbox/claude-home`. OpenShell owns both mounts and keeps PostgreSQL
traffic behind its default-deny network policy.

## Runtime Status

| Runtime | Persistence | OpenShell requirement | Status |
|---|---|---|---|
| Primary FUSE image (`Dockerfile.openrind-shell`) | Project files in PostgreSQL FUSE; Claude state in a local named volume | Vendored Docker-driver build with `--fuse` and driver-config named-volume mounts | Implemented; source build and `:fuse` publication target |
| Compatibility image (`Dockerfile.openrind-shell-compat`) | `.claude`, `.claude.json`, `.openrind-shell`, and legacy `.openeral` | Stock current OpenShell | GHCR `:just-bash` target; registry pull access currently required |

The FUSE capability is a default-off OpenShell patch pinned under
[`vendor/openshell`](./vendor/openshell). It is not in a released upstream OpenShell
version yet. Do not present the `:just-bash` publication target as the FUSE runtime.

The primary image inherits NVIDIA's published Community base directly. Openrind Shell does
not rebuild that base image.

The source tree and PostgreSQL schema retain some `openeral` names for upgrade
compatibility. In particular, `_openeral` is the stable on-disk database namespace;
renaming public commands does not abandon existing workspaces. Migration V8 also
imports newer compatibility rows from the short-lived `_openrind.workspace_*`
namespace without overwriting rows whose `_openeral` mtime is newer. When that
workspace creates its first FUSE volume, all valid just-bash home paths are imported;
older scoped `_openeral` workspaces retain their narrower state-only import.

## Architecture At A Glance

The primary runtime keeps the privileged mount operation in OpenShell while the
filesystem implementation runs as an ordinary sandbox child. Claude reaches
PostgreSQL only through kernel filesystem calls; it does not receive `/dev/fuse`, a
mount capability, or a direct database network path.

```mermaid
flowchart LR
  subgraph control["Host and OpenShell control plane"]
    user["User"]
    cli["Patched OpenShell CLI<br/>sandbox create --fuse"]
    gateway["OpenShell gateway<br/>policy and provider control"]
    driver["Docker driver<br/>enable_fuse operator gate"]
  end

  subgraph sandbox["OpenShell sandbox container"]
    supervisor["openshell-sandbox<br/>PID 1"]
    workload["Managed workload<br/>sleep infinity"]
    ssh["SSH sessions<br/>init, shell, Claude"]
    claude["Claude Code<br/>HOME=/sandbox/claude-home<br/>cwd=/sandbox/work"]
    vfs["Linux VFS<br/>/sandbox/work"]
    claudehome["Docker named volume<br/>/sandbox/claude-home"]
    fused["openrind-shell-fused<br/>critical sandbox child"]
    runtime["/var/lib/openrind-shell/runtime<br/>same-UID coordination"]
    proxy["OpenShell egress proxy<br/>binary-attributed policy"]
  end

  postgres[("External PostgreSQL<br/>normalized _openeral.fs_* tables")]

  user --> cli --> gateway --> driver --> supervisor
  supervisor --> workload
  supervisor --> ssh
  ssh --> claude
  claude -->|"project I/O"| vfs
  claude -->|"settings, sessions, cache"| claudehome
  supervisor -->|"open /dev/fuse, mount, pass FDs"| fused
  vfs -->|"FUSE requests"| fused
  fused <-->|"health socket, DB readiness, init marker"| runtime
  fused -->|"HTTP CONNECT"| proxy
  proxy -->|"raw tunnel, end-to-end PostgreSQL TLS"| postgres
```

The supervisor mounts before applying its TSYNC mount-denying seccomp prelude, then
starts `openrind-shell-fused` through the normal unprivileged `ProcessHandle` path. The
daemon inherits Landlock, child seccomp, the network namespace, proxy variables, TLS
roots, and two supervisor-selected descriptors: the FUSE channel and a readiness
channel. The compatibility image does not use this path.

## Primary FUSE Runtime

### Prerequisites

- Linux with Docker and `/dev/fuse`.
- The vendored OpenShell CLI, gateway, and supervisor built from this repository.
- Docker driver configuration with `enable_fuse = true`.
- An external PostgreSQL URL. PGlite is intentionally unsupported in this image.
- The required host-managed Haloop edge and a Desktop-created scoped provider.

Build instructions for the patched OpenShell components are in [BUILD.md](./BUILD.md).

### Build The Openrind Shell Image

```bash
docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
docker build --pull=false -f Dockerfile.openrind-shell -t openrind-shell-fuse:local .
```

This builds only the Openrind Shell child image and its Rust daemon. It reuses the published
NVIDIA base.

For the Windows Desktop source workflow, this image plus
`haloop-gateway:local` and `haloop-collector:local` must be built in the
dedicated OpenShell WSL Docker daemon. Run the validated builder from the
repository root:

```powershell
node openrind-desktop/apps/desktop/scripts/build-openshell-runtime-images.mjs
```

### Create And Initialize

For the supported customer flow, open Desktop, configure the PostgreSQL and provider
credentials in Settings, then choose **Sandboxes → New sandbox → Claude Code**.
Desktop creates the scoped Haloop provider and persistent agent-home volume and
initializes the FUSE workspace. No provider ID needs to be copied from Desktop.
The following low-level commands are developer diagnostics, not a standalone
customer launch recipe; they require a provider already registered by Desktop.

Point the patched CLI at the patched Docker gateway:

```bash
export OPENSHELL_BIN="$PWD/vendor/openshell/target/debug/openshell"
export OPENSHELL_GATEWAY_ENDPOINT="http://127.0.0.1:18770"
export OPENRIND_SHELL_WORKSPACE_ID="${OPENRIND_SHELL_WORKSPACE_ID:-openrind-shell-demo}"
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"
```

Create a temporary database upload and initialize the sandbox:

The supported Desktop flow creates `OPENRIND_HALOOP_PROVIDER` after registering
the matching server-owned Haloop route. A raw Anthropic key is never a sandbox
provider credential, and the FUSE runtime has no direct-provider fallback.

```bash
db_file="$(mktemp /tmp/openrind-shell-db-url-XXXXXX)"
trap 'rm -f "$db_file"' EXIT
: "${OPENRIND_HALOOP_PROVIDER:?Openrind Desktop must register the scoped Haloop provider first}"
printf '%s' "$DATABASE_URL" > "$db_file"
chmod 600 "$db_file"

"$OPENSHELL_BIN" \
  --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox create \
  --name "$OPENRIND_SHELL_WORKSPACE_ID" \
  --from openrind-shell-fuse:local \
  --fuse \
  --driver-config-json '{"docker":{"mounts":[{"type":"volume","source":"openrind-manual-claude-home","target":"/sandbox/claude-home","read_only":false}]}}' \
  --upload "$db_file:/sandbox/db-url" \
  --provider "$OPENRIND_HALOOP_PROVIDER" \
  --env "OPENRIND_SHELL_WORKSPACE_ID=$OPENRIND_SHELL_WORKSPACE_ID" \
  --no-tty \
  -- openrind-shell-init

rm -f "$db_file"
trap - EXIT
```

`openrind-shell-init` runs after OpenShell reports the sandbox Ready. It is a one-shot SSH
command that migrates PostgreSQL, prepares the normalized volume, verifies the writer
lease, performs an fsync/read-back canary through the mounted filesystem, configures
Claude, removes the uploaded URL, and exits.

Check the create command's exit status: a sandbox whose initialization failed still
lists as `Ready`, because the supervisor and mount are up but the volume is not. When
in doubt, verify before use:

```bash
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox exec -n "$OPENRIND_SHELL_WORKSPACE_ID" -- openrind-shell-fused health
```

The reported `state` must be `writable`.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant CLI as OpenShell CLI
  participant Driver as Docker driver
  participant Supervisor as openshell-sandbox PID 1
  participant FUSE as openrind-shell-fused
  participant PG as PostgreSQL
  participant Init as openrind-shell-init over SSH
  participant Claude as Claude session over SSH

  User->>CLI: sandbox create --fuse --upload ... -- openrind-shell-init
  CLI->>Driver: Provision FUSE sandbox
  Driver->>Supervisor: Start with /dev/fuse and request marker
  Supervisor->>Supervisor: Validate policy, binary, and mountpoint
  Supervisor->>Supervisor: Mount /sandbox/work before TSYNC hardening
  Supervisor->>FUSE: Spawn restricted child with FUSE and readiness FDs
  FUSE-->>Supervisor: FUSE INIT readiness byte
  Supervisor-->>Driver: Workload and SSH ready
  Driver-->>CLI: Sandbox Ready
  CLI->>Supervisor: Upload mode-0600 database URL
  CLI->>Init: SSH-exec trailing one-shot command
  Init->>PG: Migrate V1-V8, bridge renamed rows, prepare volume, verify writer lease
  Init->>FUSE: Check health and run fsync/read-back canary
  Init-->>CLI: Delete upload, mark initialized, exit 0
  CLI-->>User: sandbox create returns

  User->>CLI: sandbox connect
  CLI->>Claude: SSH shell, then user runs claude
  Claude->>FUSE: Normal VFS reads and writes
  User->>Claude: /exit or Ctrl-D
  Claude->>FUSE: Final flush-all durability barrier
  Claude-->>User: Return to sandbox shell

  alt FUSE daemon exits or loses its writer lease
    FUSE--xSupervisor: Critical child exits
    Supervisor--xDriver: Reserved restart status
    Driver->>Supervisor: Bounded container restart
    Supervisor->>FUSE: Rebuild mount and acquire higher writer epoch
  end
```

OpenShell's trailing command is deliberately not a service: it is delivered over SSH
after Ready and exits. The supervisor-owned FUSE daemon is the long-lived critical
service and survives ordinary SSH disconnects and repeated Claude sessions.

For Supabase, use an IPv4-compatible **session-mode** pooler URL on port 5432. Port
6543 is transaction pooling, which detaches sessions from backends and would break the
one-writer lease; `openrind-shell-init` rejects it. The included policy covers
`*.pooler.supabase.com`; other database hosts need an exact policy entry in a derived
image. PostgreSQL TLS is mandatory. For a local trial without Supabase, BUILD.md
describes a Docker Compose TLS PostgreSQL fixture and the derived test image.

### Start, Stop, And Resume Claude

In Desktop select the existing sandbox to connect. Use `/exit` to end Claude,
then **Reconnect** to launch another signed session. Select the same sandbox to
return to its running session; do not create a second sandbox for the same workspace.
Keep the sandbox and its agent-home volume to retain conversation history.

Connect from the host:

```bash
"$OPENSHELL_BIN" \
  --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox connect "$OPENRIND_SHELL_WORKSPACE_ID"
```

This manual connection is a diagnostic shell. Required-phase agent inference is
launched from Openrind Desktop, which supplies the signed conversation context;
running Claude directly from the diagnostic shell is intentionally rejected by
the Haloop edge.

Use `exit` to disconnect without deleting the sandbox. Openrind Desktop owns new
and resumed Claude/OpenClaw launches and runs the final FUSE durability flush.

Reconnect later with the same `sandbox connect` command. The OpenShell supervisor and
FUSE daemon remain sandbox services; they are not tied to the SSH session. Interactive
shells start with the sandbox user's login home `/sandbox`, then a hook installed by
initialization enters `/sandbox/work`. The `claude` wrapper keeps that directory as the
cwd but sets `HOME=/sandbox/claude-home` for Claude only.

### Persistence And Durability

- Project files below `/sandbox/work` are stored in PostgreSQL.
- Claude settings, onboarding/trust choices, conversation metadata, and caches use the
  per-workspace Docker volume mounted at `/sandbox/claude-home`. The volume survives
  sandbox container replacement on the same Openrind Desktop Docker daemon and is not
  deleted with the OpenShell sandbox.
- The Claude home volume is device-local: it is not restored from PostgreSQL on another
  machine or after the Openrind Desktop WSL/Docker data is reset. Project data remains
  portable through its stable `OPENRIND_SHELL_WORKSPACE_ID`.
- No watcher or second writer copies data between these stores; each path has one
  persistence authority.
- The lease-owning FUSE daemon caches inode metadata and complete directory snapshots
  per mount. Claude's repeated project/config probes, including absent-name lookups, do
  not repeat remote PostgreSQL queries; every committed namespace mutation invalidates
  the cache before later requests can observe it.
- `fsync`, `fdatasync`, `O_SYNC`, and `O_DSYNC` acknowledge only after commit.
- Ordinary writes use a bounded write-back cache and may be lost before a durability
  barrier. Claude's clean-exit wrapper calls `flush-all`.
- Dirty-source rename replacement and existing-file `O_TRUNC` replacement have
  synchronous ordering barriers to protect common safe-save patterns.
- A lost PostgreSQL connection is not a failure: the daemon reconnects within the
  lease window and renews the same writer epoch; operations return `EIO` meanwhile.
- A FUSE daemon exit or a genuine lease loss is a critical-service failure. The Docker
  driver restarts the container, reconstructs the mount, and advances the PostgreSQL
  writer epoch.
- A container restart terminates every process in the sandbox, including your SSH
  shell and Claude session; open file descriptors do not survive it.

Use the same `OPENRIND_SHELL_WORKSPACE_ID` in a replacement sandbox to mount the same
volume. Delete Desktop-managed sandboxes from Openrind Desktop. It ends tracked
agents, revokes every matching scoped Haloop token and endpoint-bound OpenShell
provider, rebuilds routes for surviving profiles, and only then removes the
sandbox container. A cleanup failure blocks deletion; do not bypass it with a
raw OpenShell command.

For a standalone manual sandbox that is not owned by Desktop, exit Claude
cleanly before deleting it:

```bash
"$OPENSHELL_BIN" \
  --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox delete "$OPENRIND_SHELL_WORKSPACE_ID"
```

### Required Haloop Runtime

Openrind Desktop starts the Haloop gateway and private trace collector outside
the sandbox, registers a server-owned route profile with capture hooks,
and creates one endpoint-bound OpenShell provider per
workspace/sandbox/agent scope. OpenShell materializes the scoped token only as
`x-api-key` for the exact Haloop endpoint and trusted native launcher. The
Desktop also issues a signed, opaque conversation assertion per agent process.
The edge verifies it against the selected server-owned profile, derives the
trace/root/session identity, and strips it before the core. Missing or invalid
assertions fail closed, so a sandbox cannot supply raw trace metadata. The
upstream Anthropic key remains in the protected host-side Haloop registry. The
gateway publishes `8787` only on the OpenShell sandbox bridge address mapped to
`host.openshell.internal`; collector port `8788` is confined to the
Desktop-managed Docker network. Packaged Desktop selects the matched,
version-pinned Haloop gateway and collector images rather than the source-only
`:local` tags. The FUSE sandbox is not given a direct
Anthropic, legacy Openrind Gateway, or `stringcost` inference path.

Routing and startup readiness are mandatory. After startup, trace capture is
best-effort (`deny: false`): collector failures do not block successful inference.
A successful response is not proof that its trace was stored; check capture stats.
Desktop sandbox deletion withdraws the live edge before removing the matching
provider and encrypted profile records. Surviving profiles are restored through
Haloop with unchanged credentials; deleting the last profile stops the managed
gateway and collector without deleting persisted traces or the PostgreSQL FUSE
workspace.

The confirmed Desktop distro reset is the complete integration-removal path. It
blocks new route preparation, closes tracked agents, withdraws the edge, deletes
all endpoint-bound providers and encrypted scoped profiles, and removes the
collector, plaintext registry, and private network before unregistering WSL.
If corruption blocks managed cleanup, Desktop stops the dedicated distro before
erasing every encrypted host token; unregister then destroys its provider store.
Failure to stop the distro or erase host tokens blocks unregister. Unlike an
ordinary sandbox deletion or Haloop restart, this destructive reset deletes
distro-local traces and packages; the external PostgreSQL FUSE workspace
remains untouched.

The current Desktop policy is `incumbent-only`: each server-owned profile has
one direct Anthropic configuration and no candidate target, weight, or model
override. **Settings -> Environment -> Restore incumbent** atomically rebuilds
that approved registry and replaces only the gateway. Existing tokens, signed
sessions, agent processes, collector data, and FUSE workspace data remain in
place; only a request already in flight may need to be retried. The restore
action requires a healthy version-matched collector; use the full Haloop restart
first when the collector itself needs repair.

## Compatibility Runtime

Use this when you need stock OpenShell, optional PostgreSQL, or PGlite. It does not
persist arbitrary project files. The publication workflow targets
`ghcr.io/openrind/openrind-shell/sandbox:just-bash`, but that package currently
requires GHCR pull access. If your registry account cannot pull it, build the child
image from the public NVIDIA base instead:

```bash
docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
docker build --pull=false -f Dockerfile.openrind-shell-compat \
  -t openrind-shell-compat:local .
```

```mermaid
flowchart LR
  claude["Claude Code and native tools"] --> disk["Container filesystem<br/>HOME=/sandbox"]
  disk --> scoped["Scoped watcher<br/>.claude, .claude.json,<br/>.openrind-shell, legacy .openeral"]
  scoped <--> rows[("_openeral.workspace_files<br/>PostgreSQL or PGlite")]
  disk --> ephemeral["Project source and all other paths<br/>ephemeral"]
```

This watcher is mutually exclusive with the primary FUSE runtime. It preserves only
the documented prefixes; it is not a native whole-home filesystem.

```bash
export OPENRIND_SHELL_WORKSPACE_ID="${OPENRIND_SHELL_WORKSPACE_ID:-openrind-shell-demo}"

openshell sandbox create \
  --name "$OPENRIND_SHELL_WORKSPACE_ID" \
  --from openrind-shell-compat:local \
  --provider claude \
  --auto-providers \
  --env "OPENRIND_SHELL_WORKSPACE_ID=$OPENRIND_SHELL_WORKSPACE_ID" \
  -- openrind-shell-init

openshell sandbox connect "$OPENRIND_SHELL_WORKSPACE_ID"
```

Inside the sandbox, run `claude`; stop with `/exit` or `Ctrl+D`; restart with
`claude`; continue with `claude -c`.

To add compatibility-mode PostgreSQL persistence, upload the URL to
`/sandbox/db-url` as shown in the FUSE flow, but omit `--fuse`. Only
`/sandbox/.claude/**`, `/sandbox/.claude.json`, `/sandbox/.openrind-shell/**`, and the
legacy `/sandbox/.openeral/**` prefix are synced.

## Useful Commands

Inside either runtime:

```bash
pg "SELECT now()"
openrind-shell memory refresh --query "current project"
```

From the host (for the FUSE runtime, always use the patched `$OPENSHELL_BIN`; a stock
`openshell` on `PATH` may be an older upstream build):

```bash
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox exec -n "$OPENRIND_SHELL_WORKSPACE_ID" -- pg "SELECT 1"
"$OPENSHELL_BIN" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" \
  sandbox exec -n "$OPENRIND_SHELL_WORKSPACE_ID" -- claude -p "Reply exactly: ok"
```

## Troubleshooting

**`--fuse` is unknown:** the CLI is an upstream/stock build. Use the vendored build or
the compatibility runtime.

**FUSE request is rejected:** confirm the selected gateway uses the Docker driver,
`enable_fuse = true`, and the host exposes `/dev/fuse`. Other drivers reject FUSE in
v1.

**Initialization reports a CONNECT denial:** the PostgreSQL host/port is outside the
image policy. Add an exact endpoint and include both `/usr/bin/node` and
`/usr/local/bin/openrind-shell-fused` as authorized binaries.

**Initialization reports "already has an active filesystem writer":** another live
sandbox is mounted with the same `OPENRIND_SHELL_WORKSPACE_ID`. One writable mount per
workspace is enforced by advisory lock and fencing epoch; stop or delete the other
sandbox first.

**Initialization reports "FUSE daemon did not become writable within 60 seconds":**
read the printed health JSON. `database.ready identity or schema does not match this
sandbox` means the workspace ID seen by the daemon differs from the one used by
initialization; set `OPENRIND_SHELL_WORKSPACE_ID` explicitly (legacy aliases are
accepted with the same precedence). Other `lastInitializationError` values usually
mean PostgreSQL is unreachable from the sandbox or the policy denies the host.

**Initialization rejects the URL with "port 6543 (transaction pooling)":** use the
Supabase session-mode pooler on port 5432; see above.

**The sandbox enters an error after repeated daemon crashes:** the Docker driver uses
a bounded `on-failure:5` policy for FUSE sandboxes. Inspect container/supervisor logs
and fix the datasource or daemon failure. A sandbox in the `Error` phase cannot be
started; delete it and recreate it with the same `OPENRIND_SHELL_WORKSPACE_ID` to
remount the volume.

## Browser Agent Support

Openrind Shell includes built-in browser automation tools for Claude Code and custom agents:

- **19 Structured Web Tools**: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_select`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_upload_file`, `browser_downloads`, `browser_take_control`, `browser_resume`, `browser_close`, and client-local `browser_import_file` / `browser_save_artifact`.
- **Three Browser Providers**:
  1. `local-chromium`: Dedicated Chromium browser managed via Playwright.
  2. `browserbase`: Scalable cloud browser automation via Browserbase session CDP.
  3. `desktop-webview`: Interactive live page embedded inside the Desktop right-sidebar panel.
- **Human Handoff**: When a page requires manual authentication (2FA, CAPTCHA, single sign-on), click **Take Control** in the sidebar. AI actions are fenced until you click **Resume AI**, safely protecting credentials and maintaining clean session state.
- **Durable File Artifacts**: Screenshots and downloaded files are saved directly into the FUSE-backed `/sandbox/work` mount.

Architecture and security details are in [ARCHITECTURE.md](./ARCHITECTURE.md). The
alternatives survey and implementation contract are [FUSE.md](./FUSE.md) and
[FUSE-DESIGN.md](./FUSE-DESIGN.md).
