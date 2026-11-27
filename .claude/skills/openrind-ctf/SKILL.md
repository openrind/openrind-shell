---
name: openrind-ctf
description: Build, test, or evaluate the Openrind browser CTF runtime against a user-supplied challenge directory. Use for the custom CTF agent, the generic challenge image, and the OpenShell browser-pod runner. Do not use for normal Desktop Claude setup.
allowed-tools: Read, Grep, Glob, Bash
---

# Openrind Browser CTF Runtime

Use this skill for the browser CTF runtime in
`openrind-desktop/packages/ctf-runtime/`. Read `CLAUDE.md`, `README.md`, this
skill, and the package README before commands.

This runtime is a developer fixture. It is not a normal Desktop feature. It
bundles no challenge tasks. The user supplies a tasks directory; the runtime
detects challenges in it and runs them. The live runner uses a new local
OpenShell gateway, a temporary owner sandbox, Chromium browser pods, and a
challenge pod. It does not use the customer's Desktop sandbox, PostgreSQL,
FUSE workspace, Docker-in-Docker, or a simulated terminal.

## Task Model

A directory is a CTF challenge when it has at least one of these fingerprints:

- `challenge.json` or `task.toml`
- `flag.txt` or `flag` in the directory or in a `chall/` or `challenge/` subdir
- a `chall/` or `challenge/` subdir with server code (`server.py`, `app.py`,
  `run.py`, and similar)

Metadata comes from `challenge.json` (`name`, `description`, `flag`,
`internal_port`, `entrypoint`) or `task.toml` (`name`, `description`,
`web_service_port`). `DESCRIPTION.md` or `README.md` supplies the description.
The judge flag comes from `flag.txt`.

The local service has two separate capabilities:

- Chromium can access only the task's browser routes.
- The custom agent can call only `POST /v1/submit` with a per-run judge token.

Do not merge these routes. Do not place a known flag in an agent prompt or use a
host-side tool to solve a browser action.

## Choose The Test

1. Run service tests first. They need Node.js 22.19 or newer. They use
   synthetic fixtures and prove task metadata normalization, the proxy
   contract, run attribution, and the separate judge. They do not use
   OpenShell, Docker, a browser, or a model key.
2. Run the container smoke test to build a synthetic challenge image through
   the generic Dockerfile and check the proxy and judge inside the container.
   It needs Docker.
3. Run the live evaluation only after the service tests pass. It needs Linux
   x64, local Docker, the matched OpenShell build, browser test images, a
   challenge directory, and `OPENROUTER_API_KEY`. It runs real Chromium through
   the Kernel-compatible browser-pod provider.
4. Treat each model evaluation as an experiment. A model can fail to solve a
   valid challenge. The judge result, not a model statement, decides success.

## Service Tests

Run from the repository root:

```bash
node --test openrind-desktop/packages/ctf-runtime/test/*.test.mjs
```

Require exit code `0`. Do not report this as a browser-pod or model-agent
result.

Container smoke test (needs Docker):

```bash
pnpm --dir openrind-desktop/packages/ctf-runtime test:images
```

## Live OpenShell Evaluation

Before setup, report these facts:

- Operating system and architecture. This fixture is tested on Linux x64.
- Docker context and Docker server access. The gateway, broker, and images must
  use the same local daemon.
- Selected OpenShell binary directory.
- The challenge directory for `--ctf-task-dir`.
- Missing prerequisites, including `OPENROUTER_API_KEY`.

Follow the build commands in
`openrind-desktop/packages/ctf-runtime/README.md`. Do not rebuild NVIDIA's
Community base image. Pull it if it is absent. Build these local images in the
same Docker daemon as the gateway:

- `openrind-browser-owner:e2e`
- `openrind-browser-pod:e2e`

The runner builds the challenge image (`openrind-ctf-<id>:e2e`) from the
supplied task directory itself.

Then run from the repository root:

```bash
node --env-file=.env \
  openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs \
  --ctf --ctf-task-dir=<path-to-task-dir>
```

`OPENRIND_CTF_TASK_DIR=<path>` works instead of the flag. With `--ctf` and no
task directory, the runner prints a skip message and runs the standard browser
fixture instead.

Use `OPENRIND_CTF_MODEL` only to select a JSON-schema-capable OpenRouter model.
Do not pass keys in command arguments or commit them. Desktop does not import
the repository `.env`, but this isolated developer runner can use it explicitly.

The runner prints a private temporary evidence directory. It contains model
messages, tool observations, and challenge data. Do not publish it unchanged.

## Result Rules

For the task run, inspect:

- `<task>-trajectory.json`: `format` is `openrind-ctf-trajectory/v1`; every step
  has a visible `thought`, a recorded tool action, and an observation.
- The challenge event log: it has a site request from the run actor.
- The judge record: `correct: true` is the only accepted result.

The live runner returns success only when the task run receives an accepted
judge result. If a model reaches its step limit or submits a wrong flag, report
that as a model result. Do not retry with injected flags, direct challenge API
calls, or a different runtime unless the user asks.

## Source Map

```text
openrind-desktop/packages/ctf-runtime/src/tasks.mjs
  dynamic task registry and metadata normalization (no bundled tasks)
openrind-desktop/packages/ctf-runtime/src/challenge-server.mjs
  app proxy, independent judge, and per-run event records
openrind-desktop/packages/ctf-runtime/src/agent.mjs
  custom model agent and truthful trajectory writer
openrind-desktop/packages/ctf-runtime/bin/challenge.mjs
  in-image challenge server; loads the baked challenge.json
openrind-desktop/packages/ctf-runtime/test/tasks.test.mjs
  deterministic service and judge tests (synthetic fixtures)
sandboxes/ctf-challenge/Dockerfile
  generic OpenShell challenge-pod image (TASK_DIR build-arg)
openrind-desktop/packages/browser-pods/test/live/openshell-e2e.mjs
  real gateway, pod, and CTF runner when invoked with `--ctf --ctf-task-dir`
```

Do not add container control, a fake shell transcript, or a direct Chromium
executable path to this runtime. The custom agent must use the
provider-compatible browser-pod path.
