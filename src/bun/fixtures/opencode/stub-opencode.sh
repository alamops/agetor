#!/bin/sh
# A stand-in `opencode` v2 binary for tests (AGETOR_OPENCODE_BIN=<this file>).
#
#   --version                           -> "opencode v2.1.3"
#   serve [--hostname H] [--port P]     -> the fake server (fake-serve.ts), exec'd
#   models [--standalone]               -> two model ids
#   api --standalone model.list         -> a minimal model catalog
#   auth list [--standalone] [--format json]
#                                       -> one credential (the status probe reads "logged in")
#   anything else                       -> usage line on stderr, exit 1
#
# Works from any cwd and through a symlink. The fake server needs Bun: set
# FAKE_OC_BUN to its path when `bun` is not on PATH (the default also tries
# ~/.bun/bin/bun). Knobs for the server itself (FAKE_OC_SPEED, FAKE_OC_STATE_FILE,
# FAKE_OC_HEARTBEAT_MS, ...) are documented in fake-serve.ts.
self="$0"
while [ -h "$self" ]; do
  target=$(readlink "$self")
  case "$target" in
    /*) self="$target" ;;
    *) self="$(dirname "$self")/$target" ;;
  esac
done
dir=$(cd "$(dirname "$self")" && pwd)

has() {
  for a in "$@"; do
    [ "$a" = "$WANT" ] && return 0
  done
  return 1
}

case "$1" in
  --version|-v)
    echo "opencode v${FAKE_OC_VERSION:-2.1.3}"
    ;;
  serve)
    shift
    bun="${FAKE_OC_BUN:-}"
    if [ -z "$bun" ]; then bun=$(command -v bun 2>/dev/null); fi
    if [ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ]; then bun="$HOME/.bun/bin/bun"; fi
    if [ -z "$bun" ]; then
      echo "stub-opencode: bun not found (set FAKE_OC_BUN)" >&2
      exit 1
    fi
    exec "$bun" "$dir/fake-serve.ts" "$@"
    ;;
  models)
    printf 'opencode-go/deepseek-v4.1-flash\nopencode/deepseek-v4.1-flash-free\n'
    ;;
  api)
    shift
    WANT=model.list
    if has "$@"; then
      cat <<'JSON'
{"location":{"directory":"/"},"data":[{"id":"deepseek-v4.1-flash","modelID":"deepseek-v4.1-flash","providerID":"opencode-go","family":"deepseek","name":"DeepSeek V4.1 Flash","variants":[{"id":"low","settings":{}},{"id":"high","settings":{}},{"id":"max","settings":{}}],"status":"active","enabled":true},{"id":"deepseek-v4.1-flash-free","modelID":"deepseek-v4.1-flash-free","providerID":"opencode","family":"deepseek","name":"DeepSeek V4.1 Flash Free","variants":[],"status":"active","enabled":true}]}
JSON
    else
      echo "stub-opencode: unsupported api call: $*" >&2
      exit 1
    fi
    ;;
  auth)
    shift
    if [ "$1" = "list" ]; then
      shift
      WANT=json
      if has "$@"; then
        echo '[{"id":"opencode-go","name":"OpenCode Go","connections":[{"type":"env","name":"OPENCODE_API_KEY"}]}]'
      else
        echo '1 credential'
      fi
    else
      echo "stub-opencode: unsupported auth call: $*" >&2
      exit 1
    fi
    ;;
  *)
    echo "stub-opencode: unsupported command: $*" >&2
    exit 1
    ;;
esac
