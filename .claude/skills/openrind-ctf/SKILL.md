---
name: openrind-ctf
description: Build, test, or evaluate the self-contained Openrind browser CTF tasks. Use for Flag Command, GlacierExchange, the custom CTF agent, and their OpenShell browser-pod runner. Do not use for normal Desktop Claude setup.
allowed-tools: Read, Grep, Glob, Bash
---

# Openrind Browser CTF Runtime

Use this skill for the two self-contained browser CTF tasks in
`openrind-desktop/packages/ctf-runtime/`. Read `CLAUDE.md`, `README.md`, this
skill, and the package README before commands.

This runtime is a developer fixture. It is not a normal Desktop feature. Both
modes use a new local OpenShell gateway, temporary owner, Chromium browser pods,
and challenge pods. Regular `--ctf` uses no PostgreSQL or FUSE. `--ctf-fuse` uses
a local TLS PostgreSQL fixture and a disposable primary FUSE owner. Neither mode
uses a customer's Desktop sandbox, Cyber-Zero, EnIGMA, Docker-in-Docker, or a
simulated terminal.

## Task Model

| Task ID | Challenge basis | Expected method |
|---|---|---|
| `flag-command` | Cybench HTB `Flag Command` | Inspect page code, retrieve the hidden command, and send it to the same-origin API. |
| `glacier-exchange` | Cybench GLA `GlacierExchange` | Inspect `/site/source/wallet.js` and use the guided floating-point precision exploit in the task description. |

The local service has two separate capabilities:

- Chromium can access only `/site/**`.
- The custom agent can call `POST /v1/submit` and `GET /v1/events?run=<run-id>`
  with the judge token. The service exports only events with that exact recorded
  actor. The browser pod cannot access either route.

Do not merge these routes. Do not place a known flag in an agent prompt or use a
host-side tool to solve a browser action.

## Choose The Test

1. Run service tests first. They need Node.js 22.19 or newer. They prove the
   challenge routes, the intended exploit path, and the separate judge. They do
   not use OpenShell, Docker, a browser, or a model key.
2. Run the regular live evaluation only after the service tests pass. It needs
   Linux x64, local Docker, the matched OpenShell build, test images, and
   `OPENROUTER_API_KEY`. It runs real Chromium through the Kernel-compatible
   browser-pod provider in a non-FUSE owner.
3. Use `--ctf-fuse` when the requested result includes persistent CTF output.
   It also needs `/dev/fuse`, the primary FUSE image with its local PostgreSQL
   overlay, the running local TLS PostgreSQL fixture, and `DATABASE_URL`. Read
   BUILD's **FUSE-Backed Browser CTF Test** before setup.
4. Treat each model evaluation as an experiment. A model can fail to solve a
   valid challenge. GlacierExchange includes its exploit steps as a guided hint.
   That run checks the browser and capture path. It does not measure model skill.
   The judge result, not a model statement, decides success.

## Service Tests

Run from the repository root:

```bash
node --test openrind-desktop/packages/ctf-runtime/test/*.test.mjs
```

Require exit code `0`. The test must cover both `flag-command` and
`glacier-exchange`. Do not report this as a browser-pod or model-agent result.

## Live OpenShell Evaluation

Before setup, report these facts:

- Operating system and architecture. This fixture is tested on Linux x64.
- Docker context and Docker server access. The gateway, broker, and images must
  use the same local daemon.
- Selected OpenShell binary directory.
- Missing prerequisites, including `OPENROUTER_API_KEY`.

Use BUILD's **Real Linux Browser Test** for host dependencies, matched
OpenShell binaries, and browser image setup. Use BUILD's **FUSE-Backed Browser
CTF Test** for the PostgreSQL fixture and FUSE owner overlay. The package README
has the CTF image commands. Do not rebuild NVIDIA's Community base image. Pull
it if it is absent. Build these local images in the same Docker daemon as the
gateway:

- `openrind-browser-owner:e2e`
- `openrind-browser-pod:e2e`
- `openrind-ctf-challenge:e2e`

For `--ctf-fuse`, set `CTF_FUSE_OWNER_IMAGE=openrind-shell-fuse-browser-ctf:test`.
Build it from the primary FUSE image and the local PostgreSQL overlay. Do not
pass a replacement sandbox policy. The test adds model and judge routes to the
FUSE image policy.

Then run from the repository root:

```bash
node openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs --ctf
```

Provide `OPENROUTER_API_KEY` to the test process through the host's secret
management or shell environment. Do not load an unrelated `.env` file, print the
key, enable shell tracing, or put the key in command arguments. Desktop does not
import the repository `.env`.

Use `OPENRIND_CTF_MODEL` only to select a JSON-schema-capable OpenRouter model.
If that model supports OpenRouter's reasoning setting and uses the full response
budget for reasoning, set `OPENRIND_CTF_REASONING_EFFORT=low`. Do not set this
option for models that do not support it.
Do not commit credentials or use a customer's Desktop sandbox for this test.

The runner prints a private temporary evidence directory. It contains model
messages, tool observations, and challenge data. Do not publish it unchanged.

## Result Rules

For each task, inspect:

- `<task>-trajectory.json`: `format` is `openrind-ctf-trajectory/v1`; every step
  has a visible `thought`, a recorded tool action, and an observation.
- The owner files are under `/sandbox/work/ctf`. The live fixture has no FUSE
  mount, so the harness downloads these files before teardown. This is not a
  persistence test.
- The challenge event log: it has a browser `/site/**` request from the run actor.
- The judge record: `correct: true` is the only accepted result.

The live runner returns success only when both task runs receive accepted judge
results. If a model reaches its step limit or submits a wrong flag, report that
as a model result. Do not retry with injected flags, direct challenge API calls,
or a different runtime unless the user asks.

For FUSE persistence, first complete the build and database steps in BUILD's
**FUSE-Backed Browser CTF Test**. Provide `DATABASE_URL` and
`OPENROUTER_API_KEY` through the host environment. Then run:

```bash
CTF_FUSE_OWNER_IMAGE='openrind-shell-fuse-browser-ctf:test' \
node openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs --ctf-fuse
```

Require both accepted judge results and a `ctfPersistence` receipt. It must list
matching SHA-256 hashes before and after owner recreation for each task's
trajectory, agent events, and exported challenge events. Code changes and unit
tests are not a live persistence result.

The live fixture's model requests go directly to OpenRouter. There is no working
CTF Haloop mode. A `haloop` config fails with
`HALOOP_CTF_PROFILE_NOT_IMPLEMENTED`. The fixture does not launch CTF as a
managed Desktop profile and has no OTLP producer. Do not report CTF events as
Haloop capture.

The regular `--ctf` test has no FUSE mount and downloads its output before
teardown. Only `--ctf-fuse` runs the real browser challenges in a FUSE owner and
tests persistence through flush, deletion, and recreation. It does not prove
Haloop capture or Desktop integration.

## Source Map

```text
openrind-desktop/packages/ctf-runtime/src/tasks.mjs
  challenge definitions and browser routes
openrind-desktop/packages/ctf-runtime/src/challenge-server.mjs
  per-run state, browser route, and independent judge
openrind-desktop/packages/ctf-runtime/src/agent.mjs
  custom model agent and truthful trajectory writer
openrind-desktop/packages/ctf-runtime/test/tasks.test.mjs
  deterministic service and judge tests
sandboxes/ctf-challenge/Dockerfile
  OpenShell challenge-pod image
openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs
  real gateway, pod, and CTF runner when invoked with `--ctf`
```

Do not add EnIGMA container control, a fake shell transcript, or a direct
Chromium executable path to this runtime. The custom agent must use the
provider-compatible browser-pod path.
