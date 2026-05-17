#!/usr/bin/env bash
# PreToolUse hook that routes claude's tool-call approvals through agetor's
# localhost API. Written for portability — macOS Bash 3.2 + base GNU tools
# only, no jq / no process substitution / no <<<.
#
# Env vars injected by claude-tmux's `tmux new-session -e KEY=VAL` call:
#   AGETOR_API_PORT   localhost port of the agetor HTTP API
#   AGETOR_API_TOKEN  per-launch random bearer token
#   AGETOR_TASK_ID    which task this hook is approving for
#
# IMPORTANT: this hook stays installed in `<workdir>/.claude/settings.local.json`
# even after agetor is closed (we never auto-uninstall). When a user later
# runs `claude` directly in that workdir — without agetor — we must become
# inert so claude's own permission flow takes over as if no hook were
# present. Two-stage bypass below: env-var presence is the strong signal,
# /health is the authoritative liveness check.

# Bypass 1: agetor never injected its env vars → we are not running under
# agetor. Exit silently; an empty stdout + exit 0 means "no opinion, use
# claude's default permission flow." Cheaper than the curl probe.
if [ -z "$AGETOR_API_PORT" ] || [ -z "$AGETOR_API_TOKEN" ] || [ -z "$AGETOR_TASK_ID" ]; then
  exit 0
fi

# Bypass 2: env vars are set (could be leaked from a shell inherited from
# agetor's tmux pane, a stale value in dotfiles, or agetor died mid-session)
# but the API is not actually responding. 1-second timeout: localhost
# round-trip should complete in <10ms, anything longer means agetor isn't
# there and we'd rather bypass than block claude.
#
# Body-content check (not just HTTP status): a different service happening
# to listen on the same port could respond 200 to /health, which would
# slip past `curl -f`. Agetor's /health returns `"app":"agetor"`;
# require that string in the body before trusting the response.
HEALTH=$(curl -fsS -m 1 "http://127.0.0.1:${AGETOR_API_PORT}/health" 2>/dev/null)
case "$HEALTH" in
  *'"app":"agetor"'*) ;;
  *) exit 0 ;;
esac

INPUT="$(cat)"

# Extract tool_name out of the PreToolUse JSON without spawning jq.
# Matches the first "tool_name": "..." occurrence in the stdin payload.
TOOL_NAME="$(printf '%s' "$INPUT" \
  | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed 's/.*"\([^"]*\)"$/\1/')"

# Fast paths — never bother agetor:
#   • Hard-coded safe read-only tools.
#   • Our own MCP server's tools (always allow; the MCP process itself gates
#     the user interaction inside its tool body).
case "$TOOL_NAME" in
  Read|LS|Glob|Grep|NotebookRead|mcp__agetor__*)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
    ;;
esac

# Forward to agetor. The body is the verbatim PreToolUse JSON; the server
# parses tool_name + tool_input out of it. -m 605 sits just over claude's
# default 600s hook timeout — gives the server one full timeout window
# while still letting curl give up on its own if claude already moved on.
RESP=$(printf '%s' "$INPUT" | curl -fsS -m 605 -X POST \
  -H "authorization: Bearer ${AGETOR_API_TOKEN}" \
  -H "content-type: application/json" \
  --data-binary @- \
  "http://127.0.0.1:${AGETOR_API_PORT}/approvals?taskId=${AGETOR_TASK_ID}" 2>/dev/null)
status=$?

# Mid-call agetor death: /health passed milliseconds ago but the POST
# failed (agetor restarted, network hiccup, server-side panic). Exit
# silently — same outcome as the top-of-script bypass. We can't use
# `permissionDecision: "ask"` here because in --permission-mode auto
# claude treats hook "ask" as a hard deny (verified via spike); silent
# exit lets claude's own permission engine take over instead.
if [ $status -ne 0 ] || [ -z "$RESP" ]; then
  exit 0
fi

printf '%s' "$RESP"
