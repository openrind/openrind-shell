#!/bin/bash
set -uo pipefail

export HOME=/sandbox/openclaw-home
export OPENRIND_SHELL_HOME=/sandbox/work
export OPENRIND_SHELL_OPENCLAW_HOME=/sandbox/openclaw-home
RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}"
if [ -f "$RUNTIME_DIR/api-key.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/api-key.env"
fi
export OPENAI_API_KEY="${OPENAI_API_KEY:-${ANTHROPIC_API_KEY:-sk-openrind-compat-key}}"
export CODEX_API_KEY="${CODEX_API_KEY:-$OPENAI_API_KEY}"
if [ -f "$RUNTIME_DIR/session.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/session.env"
fi
export OPENRIND_SHELL_OPENCLAW_HOME="${OPENRIND_SHELL_OPENCLAW_HOME:-/sandbox/openclaw-home}"
export HOME="$OPENRIND_SHELL_OPENCLAW_HOME"
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
export OPENCLAW_NO_RESPAWN=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_EXEC_SHELL_SNAPSHOT=0
export OPENCLAW_CHILD_OOM_SCORE_ADJ=0
export OPENCLAW_LOG_LEVEL="${OPENCLAW_LOG_LEVEL:-error}"
export DEBUG="${DEBUG:-}"
export PI_DEBUG_REDRAW=0
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/openrind-openclaw-compile-cache}"
if ! printf '%s' "${OPENRIND_HALOOP_SESSION_CONTEXT:-}" | grep -Eq '^v1\.[0-9a-f]{32}\.[1-9][0-9]{9,15}\.[1-9][0-9]{9,15}\.[0-9a-f]{64}$'; then
  echo "openrind-openclaw: a signed Desktop Haloop conversation context is required" >&2
  exit 64
fi
if ! install -d -m 0700 "$HOME/.openclaw" "$HOME/.openclaw/logs" "$NODE_COMPILE_CACHE"; then
  echo "openrind-openclaw: failed to prepare the OpenClaw home or compile cache" >&2
  exit 1
fi
if ! cd "$OPENRIND_SHELL_HOME"; then
  echo "openrind-openclaw: FUSE workspace is unavailable at $OPENRIND_SHELL_HOME" >&2
  exit 1
fi

HEALTH="$(openrind-shell-fused health 2>/dev/null || true)"
STATE="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).state || "") } catch {}' "$HEALTH")"
if [ "$STATE" != writable ]; then
  echo "openrind-openclaw: FUSE storage is not writable (state: ${STATE:-unavailable})" >&2
  exit 1
fi

# Persistent configuration, bundled skills, and the Node TUI compile cache are
# prepared by setup-fuse.sh while Desktop is still showing provisioning
# activity. Keep this interactive path limited to health, cwd, and agent exec so
# OpenClaw can paint as soon as the PTY bridge is attached.

session_args=()
case "${1:-}" in
  ""|default) ;;
  *[!A-Za-z0-9._-]*)
    echo "openrind-openclaw: ignoring invalid session key" >&2
    ;;
  *) session_args+=("$1") ;;
esac

# OPENCLAW_PLUGIN_STAGE_DIR makes the client restage plugins during terminal
# input and was the source of severe keystroke latency in the previous flow.
unset OPENCLAW_PLUGIN_STAGE_DIR
export SHELL=/bin/bash

PROXY_PID=""
if [ -f /opt/openrind-shell/haloop-agent-proxy.mjs ]; then
  pkill -f haloop-agent-proxy.mjs 2>/dev/null || true
  export HALOOP_GATEWAY_URL="${HALOOP_GATEWAY_URL:-${HALOOP_UPSTREAM_URL:-http://136.112.93.84:8787}}"
  export HALOOP_UPSTREAM_URL="$HALOOP_GATEWAY_URL"
  export NODE_USE_ENV_PROXY=1
  nohup /usr/bin/node /opt/openrind-shell/haloop-agent-proxy.mjs </dev/null >"$RUNTIME_DIR/proxy.log" 2>&1 &
  PROXY_PID=$!
  for _i in $(seq 1 30); do
    if curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
      break
    fi
    sleep 0.05
  done
  export OPENRIND_GATEWAY_BASE_URL="http://127.0.0.1:8785"
  export ANTHROPIC_BASE_URL="http://127.0.0.1:8785"
fi

# Keep the real terminal on OpenClaw's stdin. The native fixed-target launcher
# remains its kernel-verifiable parent for provider authorization; this shell
# remains outside that trust boundary and owns the final FUSE durability barrier.
if ! exec 3<&0; then
  echo "openrind-openclaw: failed to preserve terminal input" >&2
  exit 1
fi
if [ ! -x /usr/local/bin/openrind-openclaw-agent ]; then
  echo "openrind-openclaw: native OpenClaw launcher is missing or not executable" >&2
  exit 126
fi
/usr/local/bin/openrind-openclaw-agent "${session_args[@]}" <&3 3<&- &
child=$!

forward_int() { kill -INT "$child" 2>/dev/null || true; }
forward_term() { kill -TERM "$child" 2>/dev/null || true; }
forward_hup() { kill -HUP "$child" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM
trap forward_hup HUP

while true; do
  if wait "$child"; then
    status=0
  else
    status=$?
  fi
  # A trapped signal interrupts wait before the child necessarily exits. Retry
  # only while the same child is still alive so its final status remains intact.
  kill -0 "$child" 2>/dev/null || break
done
[ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true
trap - INT TERM HUP

if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  echo "openrind-openclaw: native launcher failed to start OpenClaw (status $status)" >&2
fi

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-openclaw: final FUSE flush failed; check openrind-shell-fused health before deleting the sandbox" >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
