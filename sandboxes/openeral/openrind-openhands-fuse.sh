#!/bin/bash
set -uo pipefail

RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-${OPENERAL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}}"
OPENSHELL_CREDENTIAL="${ANTHROPIC_API_KEY:-}"

if [ -f "$RUNTIME_DIR/session.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/session.env"
fi
if [ -f "$RUNTIME_DIR/api-key.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/api-key.env"
fi

if [ -n "$OPENSHELL_CREDENTIAL" ]; then
  case "$OPENSHELL_CREDENTIAL" in
    openshell:resolve:env:*) export ANTHROPIC_API_KEY="$OPENSHELL_CREDENTIAL" ;;
  esac
fi

export HOME=/sandbox/openhands-home
export OPENRIND_SHELL_HOME=/sandbox/work
GATEWAY_URL="${HALOOP_GATEWAY_URL:-}"
OPENAI_GATEWAY_URL="${GATEWAY_URL%/}/v1"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-${W8_BYOH_ADMIN_TOKEN:-}}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY:-${ANTHROPIC_API_KEY:-}}"
export LLM_API_KEY="${OPENROUTER_API_KEY:-${ANTHROPIC_API_KEY:-}}"
export LLM_BASE_URL="$OPENAI_GATEWAY_URL"
export ANTHROPIC_BASE_URL="$GATEWAY_URL"
export ANTHROPIC_API_BASE="$GATEWAY_URL"
export OPENAI_BASE_URL="$OPENAI_GATEWAY_URL"
export OPENAI_API_BASE="$OPENAI_GATEWAY_URL"
export OPENROUTER_BASE_URL="$OPENAI_GATEWAY_URL"
export OPENROUTER_API_BASE="$OPENAI_GATEWAY_URL"
export LITELLM_API_BASE="$OPENAI_GATEWAY_URL"
export LITELLM_LOCAL_MODEL_COST_MAP="True"
export LITELLM_MODE="PRODUCTION"
if [ -n "${OPENRIND_HALOOP_SESSION_CONTEXT:-}" ]; then
  export ANTHROPIC_CUSTOM_HEADERS="x-openrind-haloop-session: ${OPENRIND_HALOOP_SESSION_CONTEXT}"
fi
mode="${1:-cli}"
case "$mode" in cli|script) ;; *) echo 'Invalid OpenHands mode' >&2; exit 64 ;; esac
if ! printf '%s' "${OPENRIND_HALOOP_SESSION_CONTEXT:-}" | grep -Eq '^v1\.[0-9a-f]{32}\.[1-9][0-9]{9,15}\.[1-9][0-9]{9,15}\.[0-9a-f]{64}$'; then
  echo "openrind-openhands: a signed Desktop Haloop conversation context is required" >&2
  exit 64
fi
if ! install -d -m 0700 "$HOME/.openhands"; then
  echo "openrind-openhands: failed to prepare the OpenHands home" >&2
  exit 1
fi
if ! cd "$OPENRIND_SHELL_HOME"; then
  echo "openrind-openhands: FUSE workspace is unavailable at $OPENRIND_SHELL_HOME" >&2
  exit 1
fi

HEALTH="$(openrind-shell-fused health 2>/dev/null || true)"
STATE="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).state || "") } catch {}' "$HEALTH")"
if [ "$STATE" != writable ]; then
  echo "openrind-openhands: FUSE storage is not writable (state: ${STATE:-unavailable})" >&2
  exit 1
fi

if ! exec 3<&0; then
  echo "openrind-openhands: failed to preserve terminal input" >&2
  exit 1
fi
if [ ! -x /usr/local/bin/openrind-openhands-agent ]; then
  echo "openrind-openhands: native OpenHands launcher is missing or not executable" >&2
  exit 126
fi
/usr/local/bin/openrind-openhands-agent "$mode" <&3 3<&- &
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
trap - INT TERM HUP

if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  echo "openrind-openhands: native launcher failed to start OpenHands (status $status)" >&2
fi

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-openhands: final FUSE flush failed; check openrind-shell-fused health before deleting the sandbox" >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
