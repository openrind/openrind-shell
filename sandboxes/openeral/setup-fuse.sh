#!/bin/bash
set -euo pipefail

export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"
export OPENRIND_SHELL_WORKSPACE_ID="${OPENRIND_SHELL_WORKSPACE_ID:-${OPENERAL_WORKSPACE_ID:-${WORKSPACE_ID:-${OPENSHELL_SANDBOX_ID:-default}}}}"
export OPENERAL_WORKSPACE_ID="$OPENRIND_SHELL_WORKSPACE_ID"
export WORKSPACE_ID="$OPENRIND_SHELL_WORKSPACE_ID"
export OPENRIND_SHELL_RUNTIME_DIR="${OPENRIND_SHELL_RUNTIME_DIR:-${OPENERAL_RUNTIME_DIR:-/var/lib/openrind-shell/runtime}}"
export OPENRIND_SHELL_STATE_DIR="$OPENRIND_SHELL_RUNTIME_DIR"
export OPENRIND_SHELL_DB_URL_FILE="$OPENRIND_SHELL_RUNTIME_DIR/database-url"
export OPENRIND_SHELL_INIT_MARKER="$OPENRIND_SHELL_RUNTIME_DIR/init.done"
export OPENRIND_SHELL_HOME=/sandbox/work
export OPENRIND_SHELL_CLAUDE_HOME=/sandbox/claude-home
export OPENRIND_SHELL_OPENCLAW_HOME=/sandbox/openclaw-home
export OPENRIND_SHELL_CODEX_HOME=/sandbox/codex-home
export OPENRIND_SHELL_OPENHANDS_HOME=/sandbox/openhands-home
export OPENRIND_SHELL_OPENHANDS_MODE="${OPENRIND_SHELL_OPENHANDS_MODE:-cli}"
export OPENRIND_SHELL_AGENT="${OPENRIND_SHELL_AGENT:-claude}"
export OPENRIND_SHELL_REQUIRE_POSTGRES_TLS=1
# Legacy aliases are exported for user scripts and older library builds.
export OPENERAL_RUNTIME_DIR="$OPENRIND_SHELL_RUNTIME_DIR"
export OPENERAL_STATE_DIR="$OPENRIND_SHELL_STATE_DIR"
export OPENERAL_DB_URL_FILE="$OPENRIND_SHELL_DB_URL_FILE"
export OPENERAL_INIT_MARKER="$OPENRIND_SHELL_INIT_MARKER"
export OPENERAL_HOME="$OPENRIND_SHELL_HOME"
export OPENERAL_REQUIRE_POSTGRES_TLS=1
# OpenShell supplies its combined trust bundle through SSL_CERT_FILE. Node uses
# that bundle only in OpenSSL-CA mode; image-level ENV is not preserved by the
# supervisor's sandbox environment construction.
case " ${NODE_OPTIONS:-} " in
  *" --use-openssl-ca "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-openssl-ca --no-warnings" ;;
esac
OPENRIND_SHELL_DIR=/opt/openrind-shell
OPENERAL_DIR="$OPENRIND_SHELL_DIR"
mkdir -p "$OPENRIND_SHELL_RUNTIME_DIR"
chmod 700 "$OPENRIND_SHELL_RUNTIME_DIR"
case "$OPENRIND_SHELL_AGENT" in
  claude)
    if [ ! -d "$OPENRIND_SHELL_CLAUDE_HOME" ] || [ ! -w "$OPENRIND_SHELL_CLAUDE_HOME" ]; then
      echo "setup-fuse.sh: persistent Claude home is missing or not writable at $OPENRIND_SHELL_CLAUDE_HOME" >&2
      exit 1
    fi
    chmod 700 "$OPENRIND_SHELL_CLAUDE_HOME"
    install -d -m 0700 "$OPENRIND_SHELL_CLAUDE_HOME/.local/bin"
    # The upstream base installs Claude's native binary system-wide, but the
    # client validates its installation at $HOME/.local/bin/claude. This link is
    # runtime plumbing only; settings, trust, and onboarding remain user-owned.
    ln -sfn /usr/local/bin/claude-real "$OPENRIND_SHELL_CLAUDE_HOME/.local/bin/claude"
    ;;
  openclaw)
    if [ ! -d "$OPENRIND_SHELL_OPENCLAW_HOME" ] || [ ! -w "$OPENRIND_SHELL_OPENCLAW_HOME" ]; then
      echo "setup-fuse.sh: persistent OpenClaw home is missing or not writable at $OPENRIND_SHELL_OPENCLAW_HOME" >&2
      exit 1
    fi
    chmod 700 "$OPENRIND_SHELL_OPENCLAW_HOME"
    install -d -m 0700 "$OPENRIND_SHELL_OPENCLAW_HOME/.openclaw"
    ;;
  codex)
    if [ ! -d "$OPENRIND_SHELL_CODEX_HOME" ] || [ ! -w "$OPENRIND_SHELL_CODEX_HOME" ]; then
      mkdir -p "$OPENRIND_SHELL_CODEX_HOME" 2>/dev/null || true
    fi
    chmod 700 "$OPENRIND_SHELL_CODEX_HOME" 2>/dev/null || true
    install -d -m 0700 "$OPENRIND_SHELL_CODEX_HOME/.codex"
    ;;
  openhands)
    case "$OPENRIND_SHELL_OPENHANDS_MODE" in cli|script) ;; *) exit 64 ;; esac
    [ -d "$OPENRIND_SHELL_OPENHANDS_HOME" ] && [ -w "$OPENRIND_SHELL_OPENHANDS_HOME" ] || {
      echo "setup-fuse.sh: persistent OpenHands home is missing or not writable" >&2
      exit 1
    }
    chmod 700 "$OPENRIND_SHELL_OPENHANDS_HOME"
    install -d -m 0700 "$OPENRIND_SHELL_OPENHANDS_HOME/.openhands"
    ;;
  *)
    echo "setup-fuse.sh: unsupported agent '$OPENRIND_SHELL_AGENT'" >&2
    exit 2
    ;;
esac

read_database_url() {
  tr -d '\r' < "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

load_stored_database_url() {
  if [ -z "${DATABASE_URL:-}" ] && [ -f "$OPENERAL_DB_URL_FILE" ]; then
    DATABASE_URL="$(read_database_url "$OPENERAL_DB_URL_FILE")"
    export DATABASE_URL
  fi
}

load_stored_database_url

case "${1:-}" in
  init|stats|analyze|apply|optimize|presign)
    exec env HOME="$OPENRIND_SHELL_HOME" node "$OPENRIND_SHELL_DIR/dist/bin/openrind-shell.js" "$@"
    ;;
  memory)
    set +e
    env HOME="$OPENRIND_SHELL_HOME" node "$OPENRIND_SHELL_DIR/dist/bin/openrind-shell.js" "$@"
    status=$?
    set -e
    openrind-shell-fused flush-all >/dev/null 2>&1 || true
    exit "$status"
    ;;
  "")
    ;;
  -h|--help|help)
    cat <<'USAGE'
Usage:
  openrind-shell-init                 one-shot sandbox initialization (run by sandbox create)
  openrind-shell init [--ensure|--check-marker|--write-marker]
  openrind-shell memory refresh [--query TEXT]
  openrind-shell stats|analyze|apply|optimize ...
  openrind-shell presign [renew]
USAGE
    exit 0
    ;;
  *)
    echo "openrind-shell: unknown command '$1' (see 'openrind-shell --help')" >&2
    exit 2
    ;;
esac

DATABASE_URL="${DATABASE_URL:-${OPENRIND_SHELL_DATABASE_URL:-${OPENERAL_DATABASE_URL:-${POSTGRES_URL:-}}}}"
case "$DATABASE_URL" in openshell:resolve:env:*) DATABASE_URL="" ;; esac
DB_URL_FILE=""
if [ -z "$DATABASE_URL" ]; then
  if [ -f /sandbox/db-url ]; then
    DB_URL_FILE=/sandbox/db-url
  elif [ -d /sandbox/db-url ]; then
    DB_URL_FILE="$(find /sandbox/db-url -maxdepth 2 -type f -name db-url | head -1)"
    [ -n "$DB_URL_FILE" ] || DB_URL_FILE="$(find /sandbox/db-url -maxdepth 1 -type f | head -1)"
  elif [ -f /sandbox/openeral-input/db-url ]; then
    DB_URL_FILE=/sandbox/openeral-input/db-url
  elif [ -d /sandbox/openeral-input ]; then
    DB_URL_FILE="$(find /sandbox/openeral-input -type f -name db-url | head -1)"
  elif [ -f /sandbox/openrind-shell-input/db-url ]; then
    DB_URL_FILE=/sandbox/openrind-shell-input/db-url
  elif [ -d /sandbox/openrind-shell-input ]; then
    DB_URL_FILE="$(find /sandbox/openrind-shell-input -type f -name db-url | head -1)"
  fi
  [ -z "$DB_URL_FILE" ] || DATABASE_URL="$(read_database_url "$DB_URL_FILE")"
fi

case "$DATABASE_URL" in
  postgresql://*|postgres://*) ;;
  '')
    echo "setup-fuse.sh: DATABASE_URL is required; the FUSE image does not fall back to PGlite" >&2
    exit 1
    ;;
  *)
    echo "setup-fuse.sh: DATABASE_URL must use postgres:// or postgresql://" >&2
    exit 1
    ;;
esac
if [[ "$DATABASE_URL" =~ [\?\&]sslmode=(disable|allow)($|\&) ]]; then
  echo "setup-fuse.sh: PostgreSQL TLS cannot be disabled in the FUSE runtime" >&2
  exit 1
fi
# The writer lease is a session-level advisory lock plus per-session settings.
# Supabase port 6543 is transaction pooling, which detaches sessions from
# backends and silently breaks fencing; the FUSE runtime requires session mode.
if [[ "$DATABASE_URL" =~ ^postgres(ql)?://[^/@]*@[^/:]*\.pooler\.supabase\.com:6543(/|\?|$) ]]; then
  echo "setup-fuse.sh: Supabase port 6543 (transaction pooling) breaks the writer lease; use the session-mode pooler on port 5432" >&2
  exit 1
fi
export DATABASE_URL

if [ -f "$OPENERAL_DB_URL_FILE" ]; then
  STORED_DATABASE_URL="$(read_database_url "$OPENERAL_DB_URL_FILE")"
  if [ "$STORED_DATABASE_URL" != "$DATABASE_URL" ] && [ -f "$OPENERAL_RUNTIME_DIR/database.ready" ]; then
    echo "openrind-shell: datasource changed in a live sandbox; delete and recreate it" >&2
    exit 1
  fi
fi
DB_URL_TMP="$OPENRIND_SHELL_RUNTIME_DIR/database-url.tmp-$$"
printf '%s' "$DATABASE_URL" > "$DB_URL_TMP"
chmod 600 "$DB_URL_TMP"
mv -f "$DB_URL_TMP" "$OPENERAL_DB_URL_FILE"

DB_HOST="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname + ":" + (u.port || "5432"))')"
echo "setup-fuse.sh: migrating and preparing $WORKSPACE_ID on $DB_HOST..."
PREPARED="$(node "$OPENRIND_SHELL_DIR/dist/bin/openrind-shell-fuse-init.js" prepare)"
IMPORTED="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).importedItems || 0))' "$PREPARED")"
SEEDED="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).seededItems || 0))' "$PREPARED")"
echo "setup-fuse.sh: normalized project volume ready; imported $IMPORTED legacy item(s), seeded $SEEDED runtime item(s)"

echo "setup-fuse.sh: waiting for the mounted filesystem writer lease..."
HEALTH=""
for attempt in $(seq 1 60); do
  HEALTH="$(openrind-shell-fused health 2>/dev/null || true)"
  STATE="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).state || "") } catch {}' "$HEALTH")"
  [ "$STATE" != writable ] || break
  if [ $((attempt % 10)) -eq 0 ]; then
    echo "setup-fuse.sh: still waiting (${STATE:-management socket unavailable}, ${attempt}s)"
  fi
  sleep 1
done
if [ "${STATE:-}" != writable ]; then
  echo "setup-fuse.sh: FUSE daemon did not become writable within 60 seconds" >&2
  [ -z "$HEALTH" ] || echo "setup-fuse.sh: health: $HEALTH" >&2
  exit 1
fi

LEASE_OWNER="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).leaseOwner)' "$HEALTH")"
LEASE_EPOCH="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).leaseEpoch))' "$HEALTH")"
OPENRIND_SHELL_LEASE_OWNER="$LEASE_OWNER" OPENRIND_SHELL_LEASE_EPOCH="$LEASE_EPOCH" \
OPENERAL_LEASE_OWNER="$LEASE_OWNER" OPENERAL_LEASE_EPOCH="$LEASE_EPOCH" \
  node "$OPENRIND_SHELL_DIR/dist/bin/openrind-shell-fuse-init.js" verify-lease

echo "setup-fuse.sh: verifying mounted read/write durability..."
HOME="$OPENRIND_SHELL_HOME" node --input-type=module - <<'NODE'
import { closeSync, constants, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

// `prepare` creates .openrind-shell transactionally before the daemon mounts.
// A single mounted create/write/fsync/read/unlink is the required end-to-end
// durability proof. Directory fsyncs add remote PostgreSQL round trips but no
// extra guarantee here: FUSE namespace mutations commit before their replies.
const path = `/sandbox/work/.openrind-shell/.durability-probe-${randomUUID()}`;
const expected = randomBytes(256);
const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
try {
  writeFileSync(fd, expected);
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
const actual = readFileSync(path);
if (!actual.equals(expected)) throw new Error('FUSE canary read-back mismatch');
unlinkSync(path);
NODE
echo "setup-fuse.sh: mounted durability verified"

sync_bundled_skills() {
  local src="$1"
  local dst="$2"
  [ -d "$src" ] || return 0
  node - "$src" "$dst" << 'EOF'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [,, srcBase, dstBase] = process.argv;
if (!srcBase || !dstBase || !fs.existsSync(srcBase)) process.exit(0);

function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

try {
  fs.mkdirSync(dstBase, { recursive: true });
  const entries = fs.readdirSync(srcBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const srcDir = path.join(srcBase, skillName);
    const dstDir = path.join(dstBase, skillName);
    const manifestPath = path.join(dstDir, '.managed-manifest.json');

    let oldManifest = {};
    if (fs.existsSync(manifestPath)) {
      try {
        oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        oldManifest = {};
      }
    }

    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }

    const newManifest = {};

    function syncDir(currentSrc, currentDst, relPrefix = '') {
      fs.mkdirSync(currentDst, { recursive: true });
      const items = fs.readdirSync(currentSrc, { withFileTypes: true });
      for (const item of items) {
        if (item.name === '.managed-manifest.json' || item.name === '.git') continue;
        const srcItemPath = path.join(currentSrc, item.name);
        const dstItemPath = path.join(currentDst, item.name);
        const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;

        if (item.isDirectory()) {
          syncDir(srcItemPath, dstItemPath, relPath);
        } else if (item.isFile()) {
          const srcHash = hashFile(srcItemPath);
          if (!srcHash) continue;
          newManifest[relPath] = srcHash;

          if (!fs.existsSync(dstItemPath)) {
            fs.copyFileSync(srcItemPath, dstItemPath);
          } else {
            const dstHash = hashFile(dstItemPath);
            if (dstHash !== srcHash) {
              const prevHash = oldManifest[relPath];
              if (!prevHash || dstHash === prevHash) {
                fs.copyFileSync(srcItemPath, dstItemPath);
              }
            }
          }
        }
      }
    }

    syncDir(srcDir, dstDir);
    fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + '\n');
  }
} catch (err) {
  console.error('sync_bundled_skills warning:', err.message);
}
EOF
}

chmod 0644 /opt/openrind/browser/*.json 2>/dev/null || true
install -d -m 0755 /etc/openrind-browser-pods
if [ ! -f /etc/openrind-browser-pods/helper.json ]; then
  printf '{"brokerOrigin":"http://127.0.0.1:19300","generation":"openrind-desktop"}\n' > /etc/openrind-browser-pods/helper.json
  chmod 0644 /etc/openrind-browser-pods/helper.json 2>/dev/null || true
fi
if [ -f /opt/openrind-shell/browser-socket-relay.mjs ] && ! pgrep -f "browser-socket-relay" >/dev/null 2>&1; then
  /usr/bin/node /opt/openrind-shell/browser-socket-relay.mjs >/dev/null 2>&1 &
fi
if [ -f /opt/openrind-browser-pods/bin/openrind-browser-pod-helper.mjs ]; then
  pkill -f "openrind-browser-pod-helper" >/dev/null 2>&1 || true
  OPENRIND_BROWSER_PODS_EXPERIMENTAL=1 /opt/openrind-browser-pods/bin/helper-ensure.sh >/dev/null 2>&1 || true
fi

if [ "$OPENRIND_SHELL_AGENT" = claude ]; then
  # Desktop owns the mandatory API route. Seed Claude's persistent home as
  # host-provisioned so its first-run account/OAuth connectivity probes cannot
  # bypass the inference-only Haloop policy; project trust remains user-owned.
  echo "setup-fuse.sh: persistent Claude home ready"
  if [ -d /opt/openrind-shell/skills ]; then
    for target_skills_dir in "$OPENRIND_SHELL_CLAUDE_HOME/.claude/skills" "$OPENRIND_SHELL_HOME/.claude/skills"; do
      sync_bundled_skills /opt/openrind-shell/skills "$target_skills_dir"
    done
  fi
  HOME="$OPENRIND_SHELL_CLAUDE_HOME" node /opt/openrind-shell/configure-haloop.mjs
  # Warm the immutable executable and its dynamic loader while provisioning is
  # still showing progress. This does not create project trust state.
  HOME="$OPENRIND_SHELL_CLAUDE_HOME" /usr/local/bin/claude-real --version >/dev/null 2>&1 || true
elif [ "$OPENRIND_SHELL_AGENT" = openclaw ]; then
  echo "setup-fuse.sh: persistent OpenClaw home ready"
  if [ -d /opt/openrind-shell/skills ]; then
    for target_skills_dir in "$OPENRIND_SHELL_OPENCLAW_HOME/.openclaw/skills" "$OPENRIND_SHELL_OPENCLAW_HOME/.claude/skills" "$OPENRIND_SHELL_HOME/.claude/skills"; do
      sync_bundled_skills /opt/openrind-shell/skills "$target_skills_dir"
    done
  fi
  # Configuration and bundled-skill staging belong to provisioning, not the
  # interactive launch path.
  HOME="$OPENRIND_SHELL_OPENCLAW_HOME" \
    /usr/bin/node /opt/openrind-shell/configure-haloop.mjs
  OPENRIND_GATEWAY_BASE_URL="http://127.0.0.1:8785" \
  HOME="$OPENRIND_SHELL_OPENCLAW_HOME" \
    /usr/bin/node /opt/openrind-shell/configure-openclaw-fuse.mjs

  # OpenClaw's first TUI import is its expensive cold-start path. Prime those
  # immutable modules during provisioning into the exact compile cache used by
  # the real launcher. `tui --help` loads the command without starting an agent,
  # opening a network connection, or creating a conversation.
  OPENRIND_OPENCLAW_COMPILE_CACHE=/tmp/openrind-openclaw-compile-cache
  install -d -m 0700 "$OPENRIND_OPENCLAW_COMPILE_CACHE"
  (
    cd "$OPENRIND_SHELL_HOME"
    HOME="$OPENRIND_SHELL_OPENCLAW_HOME" \
      NODE_COMPILE_CACHE="$OPENRIND_OPENCLAW_COMPILE_CACHE" \
      OPENCLAW_NO_RESPAWN=1 OPENCLAW_SKIP_CHANNELS=1 \
      OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_SKIP_GMAIL_WATCHER=1 \
      OPENCLAW_DISABLE_BONJOUR=1 OPENCLAW_EXEC_SHELL_SNAPSHOT=0 \
      /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui --help
  ) >/dev/null 2>&1 || true
else
  echo "setup-fuse.sh: persistent OpenHands home ready"
fi

OPENRIND_SHELL_NPMRC="$OPENRIND_SHELL_RUNTIME_DIR/npmrc"
rm -f "$OPENRIND_SHELL_NPMRC"
if [ -n "${SOCKET_TOKEN:-}" ]; then
  cat > "$OPENRIND_SHELL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=${SOCKET_TOKEN}
NPMRC
  chmod 600 "$OPENRIND_SHELL_NPMRC"
fi

# Interactive SSH shells start with the sandbox user's login home (/sandbox), not
# the mount, so the session hook must live in that .bashrc. A normal README-style
# `sandbox connect` remains a shell. Openrind Desktop writes a consume-once marker
# immediately before its connection; only that connection auto-launches the
# selected agent through the same proven Linux PTY bridge used by the just-bash
# image.
SHELL_BASHRC="${HOME:-/sandbox}/.bashrc"
if ! grep -q 'Openrind Shell FUSE session environment' "$SHELL_BASHRC" 2>/dev/null; then
  cat >> "$SHELL_BASHRC" <<'BASHRC'

# Openrind Shell FUSE session environment.
[ -f /home/agent/.openrind-shell/env.sh ] && . /home/agent/.openrind-shell/env.sh
[ -f /var/lib/openrind-shell/runtime/session.env ] && . /var/lib/openrind-shell/runtime/session.env
case "$-" in
  *i*)
    case "$PWD" in
      /|/sandbox) [ -d /sandbox/work ] && cd /sandbox/work ;;
    esac

    _openrind_desktop_marker=/var/lib/openrind-shell/runtime/desktop-session
    _openrind_desktop_launch=0
    _openrind_desktop_sid=""
    if [ -f "$_openrind_desktop_marker" ]; then
      _openrind_desktop_launch=1
      _openrind_desktop_sid="$(tr -d '\r\n ' < "$_openrind_desktop_marker" 2>/dev/null || true)"
      rm -f "$_openrind_desktop_marker" 2>/dev/null || true
    fi

    if [ "$_openrind_desktop_launch" -eq 1 ] && [ -z "${OPENRIND_DESKTOP_AGENT_LAUNCHED:-}" ]; then
      export OPENRIND_DESKTOP_AGENT_LAUNCHED=1
      if [ "${OPENRIND_SHELL_AGENT:-claude}" = openhands ]; then
        echo "OpenHands requires a signed Desktop launch. Reconnect from Desktop."
        exit 64
      fi
      if [ "${OPENRIND_SHELL_AGENT:-claude}" = openclaw ]; then
        _openrind_desktop_openclaw_args=()
        case "$_openrind_desktop_sid" in
          default|'') ;;
          *[!A-Za-z0-9._-]*) ;;
          *) _openrind_desktop_openclaw_args=("$_openrind_desktop_sid") ;;
        esac
        if command -v python3 >/dev/null 2>&1 && [ -x /opt/openrind-shell/openrind-pty-bridge.py ]; then
          exec python3 /opt/openrind-shell/openrind-pty-bridge.py \
            /usr/local/bin/openrind-openclaw "${_openrind_desktop_openclaw_args[@]}"
        fi
        exec /usr/local/bin/openrind-openclaw "${_openrind_desktop_openclaw_args[@]}"
      else
        _openrind_desktop_claude_args=()
        case "$_openrind_desktop_sid" in
          default|'') ;;
          *[!0-9a-fA-F-]*) ;;
          *)
            if find "$OPENRIND_SHELL_CLAUDE_HOME/.claude/projects" -type f -name "${_openrind_desktop_sid}.jsonl" -print -quit 2>/dev/null | grep -q .; then
              _openrind_desktop_claude_args=(--resume "$_openrind_desktop_sid")
            else
              _openrind_desktop_claude_args=(--session-id "$_openrind_desktop_sid")
            fi
            ;;
        esac
        if command -v python3 >/dev/null 2>&1 && [ -x /opt/openrind-shell/openrind-pty-bridge.py ]; then
          exec python3 /opt/openrind-shell/openrind-pty-bridge.py \
            env SHELL=/bin/bash DISABLE_AUTOUPDATER=1 \
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
            /usr/local/bin/claude "${_openrind_desktop_claude_args[@]}"
        fi
        exec env SHELL=/bin/bash DISABLE_AUTOUPDATER=1 \
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
          /usr/local/bin/claude "${_openrind_desktop_claude_args[@]}"
      fi
    elif [ -z "${OPENRIND_SHELL_HINT_SHOWN:-}" ]; then
      export OPENRIND_SHELL_HINT_SHOWN=1
      if [ "${OPENRIND_SHELL_AGENT:-claude}" = openclaw ]; then
        echo "Openrind Shell ready. Run 'openrind-openclaw' to start OpenClaw."
      else
        echo "Openrind Shell ready. Run 'claude' to start; /exit or Ctrl-D returns here; 'claude -c' continues."
      fi
    fi
    ;;
esac
BASHRC
fi

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
SESSION_ENV="$OPENRIND_SHELL_RUNTIME_DIR/session.env"
{
  printf 'export HOME='; shell_quote "$OPENRIND_SHELL_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_HOME='; shell_quote "$OPENRIND_SHELL_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_CLAUDE_HOME='; shell_quote "$OPENRIND_SHELL_CLAUDE_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_OPENCLAW_HOME='; shell_quote "$OPENRIND_SHELL_OPENCLAW_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_CODEX_HOME='; shell_quote "$OPENRIND_SHELL_CODEX_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_OPENHANDS_HOME='; shell_quote "$OPENRIND_SHELL_OPENHANDS_HOME"; printf '\n'
  printf 'export OPENRIND_SHELL_OPENHANDS_MODE='; shell_quote "$OPENRIND_SHELL_OPENHANDS_MODE"; printf '\n'
  printf 'export OPENRIND_SHELL_AGENT='; shell_quote "$OPENRIND_SHELL_AGENT"; printf '\n'
  printf 'export OPENRIND_SHELL_RUNTIME_DIR='; shell_quote "$OPENRIND_SHELL_RUNTIME_DIR"; printf '\n'
  printf 'export OPENRIND_SHELL_STATE_DIR='; shell_quote "$OPENRIND_SHELL_RUNTIME_DIR"; printf '\n'
  printf 'export OPENRIND_SHELL_DB_URL_FILE='; shell_quote "$OPENRIND_SHELL_DB_URL_FILE"; printf '\n'
  printf 'export OPENRIND_SHELL_INIT_MARKER='; shell_quote "$OPENRIND_SHELL_INIT_MARKER"; printf '\n'
  printf 'export OPENRIND_SHELL_REQUIRE_POSTGRES_TLS=1\n'
  printf 'export OPENERAL_HOME='; shell_quote "$OPENRIND_SHELL_HOME"; printf '\n'
  printf 'export OPENERAL_RUNTIME_DIR='; shell_quote "$OPENRIND_SHELL_RUNTIME_DIR"; printf '\n'
  printf 'export OPENERAL_STATE_DIR='; shell_quote "$OPENRIND_SHELL_RUNTIME_DIR"; printf '\n'
  printf 'export OPENERAL_DB_URL_FILE='; shell_quote "$OPENRIND_SHELL_DB_URL_FILE"; printf '\n'
  printf 'export OPENERAL_INIT_MARKER='; shell_quote "$OPENRIND_SHELL_INIT_MARKER"; printf '\n'
  printf 'export OPENERAL_REQUIRE_POSTGRES_TLS=1\n'
  printf 'export OPENRIND_SHELL_WORKSPACE_ID='; shell_quote "$WORKSPACE_ID"; printf '\n'
  printf 'export OPENERAL_WORKSPACE_ID='; shell_quote "$WORKSPACE_ID"; printf '\n'
  printf 'export WORKSPACE_ID='; shell_quote "$WORKSPACE_ID"; printf '\n'
  printf 'export SHELL=/bin/bash\n'
  printf 'export AGENT_BROWSER_PROVIDER=kernel\n'
  printf 'export KERNEL_ENDPOINT=http://127.0.0.1:19300\n'
  printf 'export KERNEL_API_KEY=openrind-compat\n'
  printf 'export KERNEL_HEADLESS=true\n'
  printf 'export KERNEL_STEALTH=false\n'
  printf 'export KERNEL_TIMEOUT_SECONDS=300\n'
  printf 'export AGENT_BROWSER_ACTION_POLICY=/opt/openrind/browser/agent-browser-policy.json\n'
  printf 'export OPENRIND_BROWSER_PODS_EXPERIMENTAL=1\n'
  printf 'export BROWSER_POD_NAME=%s\n' "$(shell_quote "${BROWSER_POD_NAME:-openrind-browser-pod}")"
  printf 'export BROWSER_POD_HOST=%s\n' "$(shell_quote "${BROWSER_POD_HOST:-openrind-browser-pod}")"
  printf 'export BROWSER_POD_PORT=%s\n' "$(shell_quote "${BROWSER_POD_PORT:-9222}")"
  [ ! -f "$OPENRIND_SHELL_NPMRC" ] || printf 'export NPM_CONFIG_USERCONFIG=%s\n' "$(shell_quote "$OPENRIND_SHELL_NPMRC")"
  if [ "$OPENRIND_SHELL_AGENT" = openclaw ]; then
    # OpenClaw owns the terminal screen; pass output through immediately and
    # replay its observed banner only within the shared clear-rewrite budget.
    printf 'export OPENRIND_SHELL_PTY_KEEP_SCROLLBACK=0\n'
    printf 'export OPENRIND_SHELL_PTY_SHOW_OPENCLAW_BANNER=1\n'
    # Its explicit openrind-gateway provider owns the endpoint; never let it
    # inherit a stale Claude base URL from a previous image contract.
    printf 'unset ANTHROPIC_BASE_URL\n'
  elif [ "$OPENRIND_SHELL_AGENT" = openhands ]; then
    _gw="${HALOOP_GATEWAY_URL:-http://136.112.93.84:8787}"
    printf 'export LLM_BASE_URL=%s\n' "$(shell_quote "$_gw")"
    printf 'export ANTHROPIC_BASE_URL=%s\n' "$(shell_quote "$_gw")"
    printf 'export ANTHROPIC_API_BASE=%s\n' "$(shell_quote "$_gw")"
    printf 'export OPENAI_BASE_URL=%s\n' "$(shell_quote "$_gw")"
    printf 'export OPENAI_API_BASE=%s\n' "$(shell_quote "$_gw")"
    printf 'export LITELLM_API_BASE=%s\n' "$(shell_quote "$_gw")"
  elif [ -f "$OPENRIND_SHELL_RUNTIME_DIR/anthropic-base-url" ]; then
    printf 'export ANTHROPIC_BASE_URL='; shell_quote "$(cat "$OPENRIND_SHELL_RUNTIME_DIR/anthropic-base-url")"; printf '\n'
  fi
} > "$SESSION_ENV"
chmod 600 "$SESSION_ENV"

if [ "$OPENRIND_SHELL_AGENT" = claude ]; then
  command -v claude-real >/dev/null 2>&1 || {
    echo "setup-fuse.sh: claude-real is missing from the image" >&2
    exit 1
  }
elif [ "$OPENRIND_SHELL_AGENT" = openhands ]; then
  [ -x /usr/local/bin/openrind-openhands-agent ] && [ -x /opt/openrind-openhands/bin/python3.12 ] || {
    echo "setup-fuse.sh: OpenHands runtime is missing from the image" >&2
    exit 1
  }
else
  command -v openclaw >/dev/null 2>&1 || {
    echo "setup-fuse.sh: openclaw is missing from the image" >&2
    exit 1
  }
  [ -x /usr/local/bin/openrind-openclaw ] || {
    echo "setup-fuse.sh: OpenClaw desktop launcher is missing from the image" >&2
    exit 1
  }
fi

openrind-shell-fused flush-all >/dev/null
node "$OPENRIND_SHELL_DIR/dist/bin/openrind-shell-fuse-init.js" mark-done

# Prime the daemon's authoritative root-directory snapshot after the final
# initialization write. Claude synchronously probes several optional project
# files before first paint; warming one listing here makes every root hit
# and miss local when the terminal connects. This is a prefetch, not another
# durability validation or retry loop.
ls -A "$OPENRIND_SHELL_HOME" >/dev/null

if [ -n "$DB_URL_FILE" ] && [ "$DB_URL_FILE" != "$OPENERAL_DB_URL_FILE" ]; then
  rm -f "$DB_URL_FILE"
fi

echo
echo "Openrind Shell FUSE initialized for workspace: $WORKSPACE_ID"
echo "Connect with: openshell sandbox connect <sandbox-name>"
if [ "$OPENRIND_SHELL_AGENT" = openclaw ]; then
  echo "Inside the sandbox: run 'openrind-openclaw' to start OpenClaw in the FUSE workspace."
else
  echo "Inside the sandbox: run 'claude'; use /exit or Ctrl-D to stop; run 'claude -c' to continue."
fi
echo
