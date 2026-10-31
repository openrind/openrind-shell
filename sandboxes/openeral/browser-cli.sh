#!/bin/sh
if [ -n "${OPENRIND_SHELL_OPENCLAW_HOME:-}" ]; then
  export HOME="${OPENRIND_SHELL_OPENCLAW_HOME}"
elif [ -n "${OPENRIND_SHELL_CODEX_HOME:-}" ]; then
  export HOME="${OPENRIND_SHELL_CODEX_HOME}"
elif [ -n "${OPENRIND_SHELL_OPENHANDS_HOME:-}" ]; then
  export HOME="${OPENRIND_SHELL_OPENHANDS_HOME}"
elif [ -n "${OPENRIND_SHELL_CLAUDE_HOME:-}" ]; then
  export HOME="${OPENRIND_SHELL_CLAUDE_HOME}"
fi
case "${HOME:-}" in
  /root|'') export HOME=/sandbox/work ;;
esac
base="$(basename "$0")"
case "$base" in
  browser_start|browser_navigate)
    exec agent-browser --session web open "$@"
    ;;
  browser_snapshot)
    exec agent-browser --session web snapshot -i "$@"
    ;;
  browser_click)
    exec agent-browser --session web click "$@"
    ;;
  browser_fill)
    exec agent-browser --session web fill "$@"
    ;;
  browser_close)
    exec agent-browser --session web close
    ;;
  browser)
    case "${1:-}" in
      start|open|navigate)
        shift
        exec agent-browser --session web open "$@"
        ;;
      snapshot)
        shift
        exec agent-browser --session web snapshot -i "$@"
        ;;
      click)
        shift
        exec agent-browser --session web click "$@"
        ;;
      fill)
        shift
        exec agent-browser --session web fill "$@"
        ;;
      close)
        exec agent-browser --session web close
        ;;
      *)
        exec agent-browser --session web "$@"
        ;;
    esac
    ;;
  *)
    exec agent-browser "$@"
    ;;
esac
