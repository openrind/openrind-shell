# Openrind Desktop Orchestrator

Host orchestrator for opencode + Openrind Desktop server + opencode-router. This is a CLI-first way to run host mode without the desktop UI.

Published on npm as `openrind-desktop-orchestrator` and installs the `openrind-desktop` command.

## Quick start

```bash
npm install -g openrind-desktop-orchestrator
openrind-desktop start --workspace /path/to/workspace --approval auto
```

When run in a TTY, `openrind-desktop` shows an interactive status dashboard with service health, ports, and
connection details. Use `openrind-desktop serve` or `--no-tui` for log-only mode.

```bash
openrind-desktop serve --workspace /path/to/workspace
```

`openrind-desktop` ships as a compiled binary, so Bun is not required at runtime.

If npm skips the optional platform package, `postinstall` falls back to downloading the matching
binary from the `openrind-desktop-orchestrator-v<version>` GitHub release. Override the download host with
`OPENRIND_DESKTOP_ORCHESTRATOR_DOWNLOAD_BASE_URL` when you need to use a mirror.

`openrind-desktop` downloads and caches the `openrind-desktop-server`, `opencode-router`, and `opencode` sidecars on
first run using a SHA-256 manifest. Use `--sidecar-dir` or `OPENRIND_DESKTOP_SIDECAR_DIR` to control the
cache location, and `--sidecar-base-url` / `--sidecar-manifest` to point at a custom host.

Use `--sidecar-source` to control where `openrind-desktop-server` and `opencode-router` are resolved
(`auto` | `bundled` | `downloaded` | `external`), and `--opencode-source` to control
`opencode` resolution. Set `OPENRIND_DESKTOP_SIDECAR_SOURCE` / `OPENRIND_DESKTOP_OPENCODE_SOURCE` to
apply the same policies via env vars.

By default the manifest is fetched from
`https://github.com/openrind/openrind-shell/releases/download/openrind-desktop-orchestrator-v<version>/openrind-desktop-orchestrator-sidecars.json`.

OpenCode Router is optional. If it exits, `openrind-desktop` continues running unless you pass
`--opencode-router-required` or set `OPENRIND_DESKTOP_OPENCODE_ROUTER_REQUIRED=1`.

For development overrides only, set `OPENRIND_DESKTOP_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `openrind-desktop-server` or `opencode-router` binaries.

Add `--verbose` (or `OPENRIND_DESKTOP_VERBOSE=1`) to print extra diagnostics about resolved binaries.

OpenCode hot reload is enabled by default when launched via `openrind-desktop`.
Tune it with:

- `--opencode-hot-reload` / `--no-opencode-hot-reload`
- `--opencode-hot-reload-debounce-ms <ms>`
- `--opencode-hot-reload-cooldown-ms <ms>`

Equivalent env vars:

- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD` (router mode)
- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD_COOLDOWN_MS`
- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD` (start/serve mode)
- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `OPENRIND_DESKTOP_OPENCODE_HOT_RELOAD_COOLDOWN_MS`

Or from source:

```bash
pnpm --filter openrind-desktop-orchestrator dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

When `OPENRIND_DESKTOP_DEV_MODE=1` is set, orchestrator uses an isolated OpenCode dev state for config, auth, data, cache, and state. Openrind Desktop's repo-level `pnpm dev` commands enable this automatically so local development does not reuse your personal OpenCode environment.

The command prints pairing URLs by default and withholds live credentials from stdout to avoid leaking them into shell history or collected logs. Use `--json` only when you explicitly need the raw pairing secrets in command output.

Use `--detach` to keep services running and exit the dashboard. The detach summary includes the
Openrind Desktop URL and a redacted `opencode attach` command, while keeping live credentials out of the detached summary.

## Sandbox mode (Docker / Apple container)

`openrind-desktop` can run the sidecars inside a Linux container boundary while still mounting your workspace
from the host.

```bash
# Auto-pick sandbox backend (prefers Apple container on supported Macs)
openrind-desktop start --sandbox auto --workspace /path/to/workspace --approval auto

# Explicit backends
openrind-desktop start --sandbox docker --workspace /path/to/workspace --approval auto
openrind-desktop start --sandbox container --workspace /path/to/workspace --approval auto
```

Notes:

- `--sandbox auto` prefers Apple `container` on supported Macs (arm64), otherwise Docker.
- Docker backend requires `docker` on your PATH.
- Apple container backend requires the `container` CLI (https://github.com/apple/container).
- In sandbox mode, sidecars are resolved for a Linux target (and `--sidecar-source` / `--opencode-source`
  are effectively `downloaded`).
- Custom `--*-bin` overrides are not supported in sandbox mode yet.
- Use `--sandbox-image` to pick an image with the toolchain you want available to OpenCode.
- Use `--sandbox-persist-dir` to control the host directory mounted at `/persist` inside the container.

### Extra mounts (allowlisted)

You can add explicit, validated mounts into `/workspace/extra/*`:

```bash
openrind-desktop start --sandbox auto --sandbox-mount "/path/on/host:datasets:ro" --workspace /path/to/workspace
```

Additional mounts are blocked unless you create an allowlist at:

- `~/.config/openrind-desktop/sandbox-mount-allowlist.json`

Override with `OPENRIND_DESKTOP_SANDBOX_MOUNT_ALLOWLIST`.

## Logging

`openrind-desktop` emits a unified log stream from OpenCode, Openrind Desktop server, and opencode-router. Use JSON format for
structured, OpenTelemetry-friendly logs and a stable run id for correlation.

```bash
OPENRIND_DESKTOP_LOG_FORMAT=json openrind-desktop start --workspace /path/to/workspace
```

Use `--run-id` or `OPENRIND_DESKTOP_RUN_ID` to supply your own correlation id.

Openrind Desktop server logs every request with method, path, status, and duration. Disable this when running
`openrind-desktop-server` directly by setting `OPENRIND_DESKTOP_LOG_REQUESTS=0` or passing `--no-log-requests`.

## Router daemon (multi-workspace)

The router keeps a single OpenCode process alive and switches workspaces JIT using the `directory` parameter.

```bash
openrind-desktop daemon start
openrind-desktop workspace add /path/to/workspace-a
openrind-desktop workspace add /path/to/workspace-b
openrind-desktop workspace list --json
openrind-desktop workspace path <id>
openrind-desktop instance dispose <id>
```

Use `OPENRIND_DESKTOP_DATA_DIR` or `--data-dir` to isolate router state in tests.

## Pairing notes

- Use the **Openrind Desktop connect URL** and **client token** to connect a remote Openrind Desktop client.
- The Openrind Desktop server advertises the **OpenCode connect URL** plus optional basic auth credentials to the client.

## Approvals (manual mode)

```bash
openrind-desktop approvals list \
  --openrind-desktop-url http://<host>:8787 \
  --host-token <token>

openrind-desktop approvals reply <id> --allow \
  --openrind-desktop-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
openrind-desktop status \
  --openrind-desktop-url http://<host>:8787 \
  --opencode-url http://<host>:4096
```

## File sessions (JIT catalog + batch read/write)

Create a short-lived workspace file session and sync files in batches:

```bash
# Create writable session
openrind-desktop files session create \
  --openrind-desktop-url http://<host>:8787 \
  --token <client-token> \
  --workspace-id <workspace-id> \
  --write \
  --json

# Fetch catalog snapshot
openrind-desktop files catalog <session-id> \
  --openrind-desktop-url http://<host>:8787 \
  --token <client-token> \
  --limit 200 \
  --json

# Read one or more files
openrind-desktop files read <session-id> \
  --openrind-desktop-url http://<host>:8787 \
  --token <client-token> \
  --paths "README.md,notes/todo.md" \
  --json

# Write a file (inline content or --file)
openrind-desktop files write <session-id> \
  --openrind-desktop-url http://<host>:8787 \
  --token <client-token> \
  --path notes/todo.md \
  --content "hello from openrind-desktop" \
  --json

# Watch change events and close session
openrind-desktop files events <session-id> --openrind-desktop-url http://<host>:8787 --token <client-token> --since 0 --json
openrind-desktop files session close <session-id> --openrind-desktop-url http://<host>:8787 --token <client-token> --json
```

## Smoke checks

```bash
openrind-desktop start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Point to source CLIs for fast iteration:

```bash
openrind-desktop start \
  --workspace /path/to/workspace \
  --allow-external \
  --openrind-desktop-server-bin apps/server/src/cli.ts \
  --opencode-router-bin apps/opencode-router/dist/cli.js
```
