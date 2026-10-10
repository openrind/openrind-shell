---
name: openrind-shell
description: Launch and diagnose the required Haloop-routed PostgreSQL FUSE runtime in Openrind Desktop.
allowed-tools: Read, Bash, Grep, Glob
---

# Openrind Shell

## First-Time Context

Use this skill for the primary Desktop Claude workflow. Read repository
`README.md` first. The managed installer targets Windows 11 and WSL2. A Linux
browser fixture is not a substitute for that customer launch.
If the user supplies a sandbox name or workspace ID, inspect that existing
resource first. Do not create a replacement just to satisfy setup instructions.

Check that the user has a matched Desktop build, OpenShell runtime assets,
PostgreSQL access, and an Anthropic key in Desktop's credential fields. Do not
print their values. Desktop does not load the repository `.env` automatically.
For source builds, follow BUILD's **Windows Desktop Source Setup**. Source images
must exist in the dedicated `openrind-desktop-openshell` WSL Docker daemon.

Use a PostgreSQL URL, not a Supabase API URL/key. Supabase must use an
IPv4-compatible session pooler on port 5432, not transaction pooling on 6543.
Primary FUSE needs TLS and has no PGlite fallback. A non-Supabase host needs a
reviewed exact endpoint in the image policy.

## Supported launch flow

1. In **Settings -> Sandbox**, install the matched stack and complete its checks.
2. Save `DATABASE_URL` and `ANTHROPIC_API_KEY` in **Settings -> Environment**.
3. In **Sandboxes**, choose **New sandbox -> Openrind Shell - Claude Code** (or OpenClaw).
4. Desktop registers the scoped Haloop provider, creates the agent-home named
   volume, initializes FUSE, and issues a signed conversation context.
5. Claude starts in the terminal. Verify FUSE health is `writable`. Use a uniquely
   named test file, read it back, and call `openrind-shell-fused flush-all` before
   reporting storage success. Do not overwrite an existing user file.
6. Select an existing sandbox to return to its live session. After `/exit`, use
   **Reconnect** for a new signed launch. Keep the agent-home volume for history.

Do not ask the user to type `claude` in another shell after Desktop opens it.
`/exit` ends Claude, not the workspace. To work on something else, leave the
sandbox intact and switch sessions. Reconnect to the same sandbox afterward.

Do not invent a provider ID for a standalone CLI launch. Never use
`--auto-providers`, a direct Anthropic provider, or an unsigned `claude` command
as a substitute. Missing Haloop readiness blocks launch; recovery uses Desktop's
restart/reconnect controls, never a direct-provider fallback.

## Diagnostics

Read `README.md` and `openrind-desktop/apps/desktop/OPENRIND_SHELL.md` for the
current flow and `BUILD.md` for source builds. Do not rebuild NVIDIA's base.
Never print database URLs or provider keys, or pass provider keys through `--env`.

Use the paired patched CLI and gateway for FUSE diagnostics. Run
`sandbox exec -n <sandbox-name> -- openrind-shell-fused health` through that CLI
with the managed gateway endpoint. The filesystem state must be `writable`.
`Ready` alone does not prove initialization succeeded. A manual
`sandbox connect` opens a diagnostic shell, not a signed agent launch.

## Browser Diagnostics

Normal Desktop setup does not enable browser pods yet. The Linux browser-only
fixture passed 17 checks; it did not test Desktop, Claude, or FUSE. Do not make
a browser service a prerequisite for ordinary Claude launch. The new image ignores the
retired managed MCP descriptor, but an existing container may still have the old
wrapper. Do not delete or replace that container without the user's approval.

For a host-enabled development sandbox, check the installed `agent-browser`
version (expected `0.38.2`). Run `/opt/openrind-browser-pods/bin/helper-probe.mjs`
with Node through OpenShell `sandbox exec`. Use `openrind-browser` only after that check
passes. Report missing assets, denied destinations, or a stopped helper. Do not
start local Chrome, switch providers, or change the network policy as recovery.

The provider is built-in `kernel`, configured to our helper at `127.0.0.1:19300`.
Only the Kernel API is emulated. The browser is real Chromium in another sandbox.
No Kernel account, local browser executable, or browser MCP server is needed.
The provider path is experimental. A separate configured Hyperbrowser SDK test
passed upload and ZIP retrieval in the real sandbox. Actual Argide has its own
private-kit fixture. Its backend runs in host Docker and its widget runs in a
browser pod. Its Gemini model route is test-only; it does not replace the required
Haloop route for Desktop Claude. Neither fixture proves Desktop browser activation
or durable FUSE export. Do not switch a Kernel client to the Hyperbrowser path
without explicit host configuration.
Control Chrome and user MCP servers are separate and must remain unchanged.
Read `openrind-desktop/packages/browser-pods/README.md` for current test limits.
For a fresh-checkout browser trial, route to `openrind-dev` and BUILD's **Real
Linux Browser Test**. Do not apply a test broker configuration to a customer owner.
For the private kit, use BUILD's **Actual Argide Application Test** after the
public browser test. Do not import Argide's test services into Desktop setup.

## Managed Runtime Diagnostics

Desktop requests a managed diagnostic route at launch. The supplied Haloop
release has no matching route or OTLP receiver, so it reports unsupported.
Required inference routing remains unchanged. A valid route enables lazy SDK
loading, content-free lifecycle spans, and sampled FUSE health. There is no new
WSL service. Environment variables do not activate this Desktop path. Do not
put host credentials in the owner or replace a live image to obtain counters.

Use `openrind-capture` for setup and tests. Check `runtimeDiagnostics` in Haloop
status and receiver-side spans before reporting delivery. New FUSE daemons add
process-local counters to `health`; old daemons work without counters. Same-UID
health is not trusted execution evidence. FUSE flush and telemetry flush are
independent. Full content capture and durable telemetry remain unimplemented.

## Persistence and safety

- `/sandbox/work` is PostgreSQL-backed FUSE, not a watched or mirrored folder.
- Claude uses `/sandbox/claude-home`, on a separate persistent named volume.
- One writable sandbox per workspace; do not create a duplicate to resume.
- FUSE daemon exit or lease loss ends the session. Never grant Claude mount
  capabilities, `/dev/fuse`, or a PostgreSQL/TLS-bypass fallback.
- Never delete a sandbox or volume without the user's explicit request.
- Compatibility is a separately requested legacy runtime, not recovery for a
  failed mandatory Haloop launch. Do not reuse its old provider recipe.
- Desktop captures traces only. Export them to the w8-haloop web app for analysis
  and Harbor task generation. Post-start capture is best-effort; a successful
  inference response does not prove its trace was stored.
