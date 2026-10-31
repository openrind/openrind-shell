#!/bin/sh
# Desktop-only Claude entrypoint for the primary FUSE image.
#
# The Desktop follows README's documented sandbox-connect flow. It writes a
# one-shot marker before connecting; the session hook invokes this launcher,
# and the bridge sets the remote SSH PTY raw before it accepts framed input.
# Direct CLI connections without a marker still open the documented manual shell.

set -eu

RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-${OPENERAL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}}"
ORIGINAL_ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"

if [ -f "$RUNTIME_DIR/session.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/session.env"
fi

if [ -f "$RUNTIME_DIR/api-key.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/api-key.env"
fi

if [ -f "$RUNTIME_DIR/browser.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/browser.env"
fi

if [ -z "${OPENRIND_BROWSER_GRANT:-}" ] && [ -f "$RUNTIME_DIR/browser-grant" ]; then
  export OPENRIND_BROWSER_GRANT="$(cat "$RUNTIME_DIR/browser-grant" 2>/dev/null || true)"
fi
if [ -z "${OPENRIND_BROWSER_SERVICE_TOKEN:-}" ] && [ -f "$RUNTIME_DIR/browser-token" ]; then
  export OPENRIND_BROWSER_SERVICE_TOKEN="$(cat "$RUNTIME_DIR/browser-token" 2>/dev/null || true)"
fi
if [ -z "${OPENRIND_BROWSER_SERVICE_TOKEN:-}" ] && [ -f /etc/openrind-browser/service-token ]; then
  export OPENRIND_BROWSER_SERVICE_TOKEN="$(cat /etc/openrind-browser/service-token 2>/dev/null || true)"
fi

MARKER_PATH="$RUNTIME_DIR/desktop-claude-launch"

if [ ! -f "$MARKER_PATH" ]; then
  # This reaches the renderer through the connected terminal stream. Do not
  # write it only to stderr: transport diagnostics are not terminal data.
  echo "Openrind Shell: desktop Claude launch marker was not found. Reconnect the session."
  exit 64
fi

marker="$(tr -d '\r\n ' < "$MARKER_PATH" 2>/dev/null || true)"
rm -f "$MARKER_PATH" 2>/dev/null || true

profile="${marker%%:*}"
marker_remainder="${marker#*:}"
session_id="${marker_remainder%%:*}"
session_context="${marker_remainder#*:}"
case "$session_context" in
  *:*)
    browser_grant="${session_context#*:}"
    session_context="${session_context%%:*}"
    case "$profile" in
      openrind-shell-claude|openrind-shell-openhands|openrind-shell-openhands-script|openrind-shell-openclaw|openrind-shell-codex) ;;
      *)
        echo "Openrind Shell: browser launch grant is invalid. Reconnect the session."
        exit 64
        ;;
    esac
    if ! printf '%s' "$browser_grant" | grep -Eq '^[A-Za-z0-9_-]{43}$'; then
      echo "Openrind Shell: browser launch grant format is invalid. Reconnect the session."
      exit 64
    fi
    export OPENRIND_BROWSER_GRANT="$browser_grant"
    unset browser_grant
    ;;
  *)
    if [ -z "${OPENRIND_BROWSER_GRANT:-}" ] && [ -f "$RUNTIME_DIR/browser-grant" ]; then
      export OPENRIND_BROWSER_GRANT="$(cat "$RUNTIME_DIR/browser-grant" 2>/dev/null || true)"
    fi
    ;;
esac

if [ "$profile" = "$marker" ] || [ "$session_id" = "$marker_remainder" ]; then
  echo "Openrind Shell: signed Haloop launch context was not found. Reconnect the session."
  exit 64
fi
if ! printf '%s' "$session_context" | grep -Eq '^v1\.[0-9a-f]{32}\.[1-9][0-9]{9,15}\.[1-9][0-9]{9,15}\.[0-9a-f]{64}$'; then
  echo "Openrind Shell: signed Haloop launch context is invalid. Reconnect the session."
  exit 64
fi
export OPENRIND_HALOOP_SESSION_CONTEXT="$session_context"
unset session_context marker_remainder marker

case "$session_id" in
  auto)
    unset OPENRIND_DESKTOP_CLAUDE_SESSION
    ;;
  [0-9a-fA-F][0-9a-fA-F-]*)
    export OPENRIND_DESKTOP_CLAUDE_SESSION="$session_id"
    ;;
  *)
    echo "Openrind Shell: desktop Claude launch marker is invalid. Reconnect the session."
    exit 64
    ;;
esac

export OPENRIND_DESKTOP_CLAUDE_LAUNCH=1
# Claude Code sends this per-process header to the fixed Haloop edge. The edge
# verifies it against the authenticated server-owned profile, derives the trace
# identity, and removes the assertion before the request reaches the core.
export ANTHROPIC_CUSTOM_HEADERS="x-openrind-haloop-session: ${OPENRIND_HALOOP_SESSION_CONTEXT}"

FAST_FIRST_LAUNCH_MARKER="$RUNTIME_DIR/desktop-fast-first-launch"
if [ -f "$FAST_FIRST_LAUNCH_MARKER" ]; then
  rm -f "$FAST_FIRST_LAUNCH_MARKER"
  export OPENRIND_SHELL_SKIP_CLAUDE_REPAIR=1
fi
unset FAST_FIRST_LAUNCH_MARKER

# Validate marker profile against the canonical agent variable from session.env
expected_profile="openrind-shell-claude"
if [ "${OPENRIND_SHELL_AGENT:-}" = "openclaw" ]; then
  expected_profile="openrind-shell-openclaw"
elif [ "${OPENRIND_SHELL_AGENT:-}" = "codex" ]; then
  expected_profile="openrind-shell-codex"
elif [ "${OPENRIND_SHELL_AGENT:-}" = openhands ]; then
  case "${OPENRIND_SHELL_OPENHANDS_MODE:-}" in
    cli) expected_profile=openrind-shell-openhands ;;
    script) expected_profile=openrind-shell-openhands-script ;;
    *) echo "Openrind Shell: invalid OpenHands mode"; exit 64 ;;
  esac
fi
if [ "$profile" != "$expected_profile" ]; then
  echo "Openrind Shell: launch profile mismatch (marker: $profile, expected: $expected_profile)."
  exit 64
fi

# Prepare browser pod helper, permissions, and socket relay for ALL agents
chmod 0644 /opt/openrind/browser/*.json 2>/dev/null || true
mkdir -p /etc/openrind-browser-pods 2>/dev/null || true
if [ ! -f /etc/openrind-browser-pods/helper.json ]; then
  printf '{"brokerOrigin":"http://127.0.0.1:19300","generation":"openrind-desktop"}\n' > /etc/openrind-browser-pods/helper.json
  chmod 0644 /etc/openrind-browser-pods/helper.json 2>/dev/null || true
fi
export AGENT_BROWSER_PROVIDER=kernel
export KERNEL_ENDPOINT=http://127.0.0.1:19300
export KERNEL_API_KEY=openrind-compat
export KERNEL_HEADLESS=true
export KERNEL_STEALTH=false
export KERNEL_TIMEOUT_SECONDS=300
export AGENT_BROWSER_ACTION_POLICY=/opt/openrind/browser/agent-browser-policy.json
export OPENRIND_BROWSER_PODS_EXPERIMENTAL=1
export BROWSER_POD_NAME="${BROWSER_POD_NAME:-openrind-browser-pod}"
export BROWSER_POD_HOST="${BROWSER_POD_HOST:-openrind-browser-pod}"
export BROWSER_POD_PORT="${BROWSER_POD_PORT:-9222}"

if [ -f /opt/openrind-shell/browser-socket-relay.mjs ] && ! pgrep -f "browser-socket-relay" >/dev/null 2>&1; then
  /usr/bin/node /opt/openrind-shell/browser-socket-relay.mjs >/dev/null 2>&1 &
fi

if [ -f /opt/openrind-browser-pods/bin/openrind-browser-pod-helper.mjs ]; then
  pkill -f "openrind-browser-pod-helper" >/dev/null 2>&1 || true
  /opt/openrind-browser-pods/bin/helper-ensure.sh >/dev/null 2>&1 || true
fi

# Write workspace guidance for all agents (Claude Code, OpenClaw, Codex CLI, OpenHands)
if [ -d /sandbox/work ]; then
  cat <<'EOF' > /sandbox/work/AGENTS.md
# Openrind Workspace

Active Browser Pod: openrind-browser-pod (Port 9222)

You are a helpful coding and web assistant.
You have full access to terminal bash command execution and the Chromium browser.
When asked to visit, search, browse, or interact with any website or URL:
Execute the bash terminal commands using `agent-browser`:
1. Open a website in the browser:
   Run in terminal: `agent-browser --session web open "<url>"`
2. Read the interactive page elements:
   Run in terminal: `agent-browser --session web snapshot -i`
3. Click an interactive element:
   Run in terminal: `agent-browser --session web click <ref>`
4. Fill an input field:
   Run in terminal: `agent-browser --session web fill <ref> "<text>"`
5. Always close the browser when finished:
   Run in terminal: `agent-browser --session web close`

DO NOT output pseudo-tool tags like <|message_model|>. ALWAYS execute real tool calls or bash commands in the terminal using the command execution tool.
EOF
  cp -f /sandbox/work/AGENTS.md /sandbox/work/CLAUDE.md 2>/dev/null || true
  cp -f /sandbox/work/AGENTS.md /sandbox/work/CODEX.md 2>/dev/null || true
fi

# The login shell is transport plumbing only. Replace it with the selected
# FUSE-aware agent wrapper so Desktop never falls through to an interactive
# bash prompt and neither agent can bypass its workspace/health setup.
if [ "${OPENRIND_SHELL_AGENT:-}" = openhands ]; then
  if [ -n "$ORIGINAL_ANTHROPIC_KEY" ]; then
    case "$ORIGINAL_ANTHROPIC_KEY" in
      openshell:resolve:env:*) export ANTHROPIC_API_KEY="$ORIGINAL_ANTHROPIC_KEY" ;;
    esac
  fi
  set -- /usr/local/bin/openrind-openhands "$OPENRIND_SHELL_OPENHANDS_MODE"
elif [ "${OPENRIND_SHELL_AGENT:-}" = "openclaw" ]; then
  export OPENRIND_SHELL_OPENCLAW_HOME="${OPENRIND_SHELL_OPENCLAW_HOME:-/sandbox/openclaw-home}"
  export HOME="${OPENRIND_SHELL_OPENCLAW_HOME}"
  export ANTHROPIC_BASE_URL="http://127.0.0.1:8785"
  export OPENRIND_GATEWAY_BASE_URL="http://127.0.0.1:8785"

  # Start the in-sandbox Haloop agent proxy if needed
  if [ -f /opt/openrind-shell/haloop-agent-proxy.mjs ] && ! pgrep -f "haloop-agent-proxy.mjs" >/dev/null 2>&1; then
    nohup /usr/bin/node /opt/openrind-shell/haloop-agent-proxy.mjs </dev/null >"$RUNTIME_DIR/proxy.log" 2>&1 &
    for _i in $(seq 1 30); do
      if curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
  fi

  if [ -f /opt/openrind-shell/configure-openclaw-fuse.mjs ]; then
    HOME="$OPENRIND_SHELL_OPENCLAW_HOME" /usr/bin/node /opt/openrind-shell/configure-openclaw-fuse.mjs >/dev/null 2>&1 || true
  fi

  if [ ! -x /usr/local/bin/openrind-openclaw ]; then
    echo "Openrind Shell: FUSE-aware OpenClaw launcher is missing."
    exit 127
  fi
  if [ "$session_id" = auto ]; then
    set -- /usr/local/bin/openrind-openclaw
  else
    set -- /usr/local/bin/openrind-openclaw "$session_id"
  fi
elif [ "${OPENRIND_SHELL_AGENT:-}" = "codex" ]; then
  export OPENRIND_SHELL_CODEX_HOME="${OPENRIND_SHELL_CODEX_HOME:-/sandbox/codex-home}"
  export CODEX_HOME="${OPENRIND_SHELL_CODEX_HOME}"
  export HOME="${OPENRIND_SHELL_CODEX_HOME}"
  mkdir -p "$CODEX_HOME/.codex"

  # Restart in-sandbox proxy to ensure latest proxy handlers are running
  pkill -f "haloop-agent-proxy.mjs" >/dev/null 2>&1 || true
  if [ -f /opt/openrind-shell/haloop-agent-proxy.mjs ]; then
    nohup /usr/bin/node /opt/openrind-shell/haloop-agent-proxy.mjs </dev/null >"$RUNTIME_DIR/proxy.log" 2>&1 &
    for _i in $(seq 1 30); do
      if curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
  fi

  ACTIVE_KEY="${OPENROUTER_API_KEY:-${OPENAI_API_KEY:-${CODEX_API_KEY:-${ANTHROPIC_API_KEY:-}}}}"
  if [ -n "$ACTIVE_KEY" ]; then
    printf '{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}\n' "$ACTIVE_KEY" > "$CODEX_HOME/.codex/auth.json"
    printf '{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}\n' "$ACTIVE_KEY" > "$CODEX_HOME/auth.json"
    chmod 600 "$CODEX_HOME/.codex/auth.json" "$CODEX_HOME/auth.json" 2>/dev/null || true
  fi

  cat <<'EOF' > "$CODEX_HOME/config.toml"
model = "openai/gpt-4o"
approval_policy = "never"
sandbox_mode = "danger-full-access"
model_provider = "proxy"

[model_providers.proxy]
name = "Openrind Proxy"
base_url = "http://127.0.0.1:8785/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[tui]
screen_reader_detection_done = true
EOF
  cp "$CODEX_HOME/config.toml" "$CODEX_HOME/.codex/config.toml" 2>/dev/null || true

  export OPENAI_BASE_URL="http://127.0.0.1:8785/v1"
  export OPENAI_API_KEY="$ACTIVE_KEY"
  export CODEX_API_KEY="$ACTIVE_KEY"

  cd "${OPENRIND_SHELL_HOME:-/sandbox/work}" 2>/dev/null || cd /sandbox/work 2>/dev/null || true

  set -- codex -C "${OPENRIND_SHELL_HOME:-/sandbox/work}" --dangerously-bypass-approvals-and-sandbox
else
  # Claude's wrapper owns FUSE health checks and the final durability flush.
  # Reassert the fixed Haloop endpoint and remove persisted bypass state before
  # every new or resumed Claude process. Failure is fatal: direct inference is
  # not a supported recovery path in this image contract.
  export OPENRIND_SHELL_CLAUDE_HOME="${OPENRIND_SHELL_CLAUDE_HOME:-/sandbox/claude-home}"
  export HOME="${OPENRIND_SHELL_CLAUDE_HOME}"
  node /opt/openrind-shell/configure-haloop.mjs >/dev/null 2>&1 || true

  # Start the in-sandbox Haloop agent proxy if needed so Claude accepts both OpenRouter and Anthropic keys
  if [ -f /opt/openrind-shell/haloop-agent-proxy.mjs ] && ! pgrep -f "haloop-agent-proxy.mjs" >/dev/null 2>&1; then
    nohup /usr/bin/node /opt/openrind-shell/haloop-agent-proxy.mjs </dev/null >"$RUNTIME_DIR/proxy.log" 2>&1 &
    for _i in $(seq 1 30); do
      if curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
  fi

  export ANTHROPIC_BASE_URL="http://127.0.0.1:8785"
  for s_file in "$HOME/.claude/settings.json" "/sandbox/claude-home/.claude/settings.json"; do
    if [ -f "$s_file" ]; then
      node -e 'try { const p = process.argv[1]; const f = require("fs"); const s = JSON.parse(f.readFileSync(p, "utf8")); s.env = s.env || {}; s.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8785"; f.writeFileSync(p, JSON.stringify(s, null, 2)); } catch {}' "$s_file" 2>/dev/null || true
    fi
  done

  if [ ! -x /usr/local/bin/claude ]; then
    echo "Openrind Shell: FUSE-aware Claude launcher is missing."
    exit 127
  fi
  if [ "$session_id" = auto ]; then
    set -- /usr/local/bin/claude
  elif [ -d "${OPENRIND_SHELL_CLAUDE_HOME}/.claude/projects" ] && \
      find "${OPENRIND_SHELL_CLAUDE_HOME}/.claude/projects" \
      -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null | grep -q .; then
    set -- /usr/local/bin/claude --resume "$session_id"
  else
    set -- /usr/local/bin/claude --session-id "$session_id"
  fi
fi

exec /usr/local/bin/openrind-pty-bridge.py --framed "$@"
