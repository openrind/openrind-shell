#!/bin/sh
set -eu

RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-${OPENERAL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}}"
if [ -f "$RUNTIME_DIR/session.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/session.env"
fi

if [ -f "$RUNTIME_DIR/haloop-context.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/haloop-context.env"
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-openrind-session-token}"

export HOME="${OPENRIND_SHELL_CLAUDE_HOME:-/sandbox/claude-home}"
export PATH="$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
export OPENRIND_SHELL_HOME=/sandbox/work
export OPENRIND_SHELL_RUNTIME_DIR="$RUNTIME_DIR"
export OPENRIND_SHELL_STATE_DIR="$RUNTIME_DIR"
export OPENRIND_SHELL_DB_URL_FILE="$RUNTIME_DIR/database-url"
export OPENRIND_SHELL_INIT_MARKER="$RUNTIME_DIR/init.done"
export OPENRIND_SHELL_REQUIRE_POSTGRES_TLS=1
export OPENERAL_HOME=/sandbox/work
export OPENERAL_RUNTIME_DIR="$RUNTIME_DIR"
export OPENERAL_STATE_DIR="$RUNTIME_DIR"
export OPENERAL_DB_URL_FILE="$RUNTIME_DIR/database-url"
export OPENERAL_INIT_MARKER="$RUNTIME_DIR/init.done"
export OPENERAL_REQUIRE_POSTGRES_TLS=1
export SHELL="${SHELL:-/bin/bash}"
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
# Claude Code is installed by the immutable sandbox image. Disable update,
# telemetry, feedback, and crash-report traffic that is unrelated to an
# interactive agent session; in particular this avoids first-launch cache work
# on the PostgreSQL-backed HOME. This is an Anthropic-supported environment
# control. Host provisioning records onboarding completion in the local named-
# volume HOME; project trust remains user-owned and is never accepted here.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"

unset STRINGCOST_API_KEY
unset OPENRIND_GATEWAY_API_KEY
unset ANTHROPIC_AUTH_TOKEN

if [ ! -x /usr/local/bin/claude-real ]; then
  echo "openrind-shell: claude-real is missing from the sandbox image" >&2
  exit 127
fi

# Desktop verifies the image contract, session marker, selected agent, and
# writable FUSE health before opening a PTY. Keep the full marker check for
# manual `claude` launches, but never repeat it in the visible Desktop path.
if [ "${OPENRIND_DESKTOP_CLAUDE_LAUNCH:-0}" != "1" ]; then
  ENSURE_LOG="/tmp/claude-init-ensure.log"
  set +e
  openrind-shell init --ensure >"$ENSURE_LOG" 2>&1
  ENSURE_STATUS=$?
  set -e
  if [ "$ENSURE_STATUS" -ne 0 ]; then
    cat "$ENSURE_LOG" >&2
    exit "$ENSURE_STATUS"
  fi
  rm -f "$ENSURE_LOG"
fi

HEALTH="$(openrind-shell-fused health 2>/dev/null || true)"
STATE="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).state || "") } catch {}' "$HEALTH")"
if [ "$STATE" != writable ]; then
  echo "openrind-shell: FUSE storage is not writable (state: ${STATE:-unavailable})" >&2
  exit 1
fi

case "$PWD" in
  /|/sandbox) cd /sandbox/work ;;
esac

if [ -d /sandbox/work ] && [ ! -f /sandbox/work/CLAUDE.md ]; then
  cat <<'EOF' > /sandbox/work/CLAUDE.md
# Openrind Workspace

You are a helpful coding and web assistant.
When the user greets you (e.g. "hi", "hello"), reply directly and concisely without running directory scans or file tools.
When asked to visit, search, browse, or interact with any website or URL (such as amazon.com, amazon.in, or others), always use the browser tools:
1. You can use the MCP browser tools directly (`browser_start`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_close`, etc., prefixed with `mcp__openrind_browser__` if invoking MCP).
2. Alternatively, you can run the browser CLI commands in Bash (`browser start <url>`, `browser navigate <url>`, `browser snapshot`, `browser click <ref>`, `browser fill <ref> <text>`, `browser close`), or use the direct binary commands: `browser_start <url>`, `browser_navigate <url>`, `browser_snapshot`, `browser_click <ref>`, `browser_fill <ref> <text>`, `browser_close`.
NEVER use curl, wget, or Fetch to scrape shopping or complex websites as they block bots with 403 Forbidden.
EOF
fi

# Clean up workspace-level settings that cause FUSE path vetting errors in Claude Code
rm -f /sandbox/work/.claude/settings.json /sandbox/work/.claude/settings.local.json 2>/dev/null || true

if [ -f "$RUNTIME_DIR/api-key.env" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_DIR/api-key.env"
fi

if [ -f "$RUNTIME_DIR/browser-grant" ]; then
  export OPENRIND_BROWSER_GRANT="$(cat "$RUNTIME_DIR/browser-grant" 2>/dev/null || true)"
fi
if [ -f /etc/openrind-browser/service-token ]; then
  export OPENRIND_BROWSER_SERVICE_TOKEN="$(cat /etc/openrind-browser/service-token 2>/dev/null || true)"
fi

# Bundled skills are staged during setup, before Desktop reports the sandbox as
# ready. Do not scan or copy them between the PTY bridge and Claude's first byte.

# A provisioned Desktop browser launch must pass preflight, including partial
# provisioning failures. Use Claude's additive MCP input; preserve user servers
# and keep this shell as the parent responsible for the final FUSE flush.
if [ -f /opt/openrind-browser/mcp.json ]; then
  set -- --mcp-config /opt/openrind-browser/mcp.json "$@"
fi

PROXY_PID=""
if [ -f /opt/openrind-shell/haloop-agent-proxy.mjs ]; then
  if ! curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
    export HALOOP_GATEWAY_URL="${HALOOP_GATEWAY_URL:-${HALOOP_UPSTREAM_URL:-http://host.openshell.internal:8787}}"
    export HALOOP_UPSTREAM_URL="$HALOOP_GATEWAY_URL"
    export NODE_USE_ENV_PROXY=1
    /usr/bin/node /opt/openrind-shell/haloop-agent-proxy.mjs &
    PROXY_PID=$!
    for _i in $(seq 1 30); do
      if curl -s -o /dev/null http://127.0.0.1:8785/healthz 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
  fi
  export ANTHROPIC_BASE_URL="http://127.0.0.1:8785"
  mkdir -p /home/agent/.openrind-shell
  printf 'export ANTHROPIC_BASE_URL="http://127.0.0.1:8785"\n' > /home/agent/.openrind-shell/env.sh
  chmod 644 /home/agent/.openrind-shell/env.sh
  for rc in /sandbox/.bashrc /home/agent/.bashrc /root/.bashrc; do
    if [ -f "$rc" ] && ! grep -Fq "openrind-shell/env.sh" "$rc"; then
      printf '\n[ -f /home/agent/.openrind-shell/env.sh ] && . /home/agent/.openrind-shell/env.sh\n[ -f /home/agent/.openrind-shell/openclaw-env.sh ] && . /home/agent/.openrind-shell/openclaw-env.sh\n' >> "$rc"
    fi
  done
  for s_file in "$HOME/.claude/settings.json" "/sandbox/claude-home/.claude/settings.json"; do
    if [ -f "$s_file" ]; then
      node -e 'try { const p = process.argv[1]; const f = require("fs"); const s = JSON.parse(f.readFileSync(p, "utf8")); s.env = s.env || {}; s.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8785"; f.writeFileSync(p, JSON.stringify(s, null, 2)); } catch {}' "$s_file"
    fi
  done
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  /usr/bin/node -e '
    try {
      const fs = require("fs");
      const path = (process.env.HOME || "/sandbox/claude-home") + "/.claude.json";
      const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
      config.hasCompletedOnboarding = true;
      config.bypassPermissionsModeAccepted = true;
      config.mcpServers = config.mcpServers || {};
      config.mcpServers["openrind-browser"] = {
        type: "stdio",
        command: "/usr/local/bin/openrind-browser-client",
        args: []
      };
      config.customApiKeyResponses = config.customApiKeyResponses || { approved: [], rejected: [] };
      config.customApiKeyResponses.approved = config.customApiKeyResponses.approved || [];
      const fp = process.env.ANTHROPIC_API_KEY.trim().slice(-20);
      if (!config.customApiKeyResponses.approved.includes(fp)) {
        config.customApiKeyResponses.approved.push(fp);
      }
      fs.writeFileSync(path, JSON.stringify(config, null, 2));
    } catch {}
  '
fi

# Keep the terminal on Claude's stdin. A non-interactive shell gives an
# asynchronous command /dev/null as stdin (POSIX; dash ignores a plain <&0),
# so save the wrapper's stdin on fd 3 first and hand that to the child.
exec 3<&0
/usr/local/bin/claude-real --dangerously-skip-permissions "$@" <&3 3<&- &
CHILD=$!

forward_int() { kill -INT "$CHILD" 2>/dev/null || true; [ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true; }
forward_term() { kill -TERM "$CHILD" 2>/dev/null || true; [ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true; }
forward_hup() { kill -HUP "$CHILD" 2>/dev/null || true; [ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true; }
trap forward_int INT
trap forward_term TERM
trap forward_hup HUP

set +e
while true; do
  wait "$CHILD"
  STATUS=$?
  kill -0 "$CHILD" 2>/dev/null || break
done
set -e
[ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true
trap - INT TERM HUP

if ! openrind-shell-fused flush-all >/dev/null 2>&1; then
  echo "openrind-shell: final FUSE flush failed; check 'openrind-shell-fused health' before deleting the sandbox" >&2
  [ "$STATUS" -ne 0 ] || STATUS=1
fi
exit "$STATUS"
