#!/bin/bash
#
# Rehydrate user-scope Claude Code config that the lab requires to be present
# on every container start, recovering from any prior bind-mount drift or
# Claude Code schema-migration losses. Idempotent — only adds what's missing.
#
# Specifically:
#   - Slash commands at ~/.claude/commands/*.md (PRD pipeline: /save-prd,
#     /generate-tasks, /submit-to-forge, /push-to-console). Source of truth at
#     /app/scripts/claude-defaults/commands/.
#   - MCP server registrations in ~/.claude.json (ruflo, playwright,
#     task-master-ai, sequential-thinking, context7). The same set originally
#     added per CLAUDE.md "MCP servers" section.
#
# Runs after bw-init.sh in the entrypoint chain. Always exec's CMD at the end
# even on partial failure — image must remain usable when this rehydration
# misbehaves.

set +e  # never crash the container

DEFAULTS_DIR=/app/scripts/claude-defaults
USER_COMMANDS_DIR="$HOME/.claude/commands"

#----- Slash commands ---------------------------------------------------------
mkdir -p "$USER_COMMANDS_DIR"
INSTALLED_CMDS=0
if [ -d "$DEFAULTS_DIR/commands" ]; then
  for src in "$DEFAULTS_DIR"/commands/*.md; do
    [ -f "$src" ] || continue
    name=$(basename "$src")
    dst="$USER_COMMANDS_DIR/$name"
    if [ ! -f "$dst" ]; then
      cp "$src" "$dst"
      INSTALLED_CMDS=$((INSTALLED_CMDS + 1))
    fi
  done
fi
echo "[claude-init] slash commands: installed $INSTALLED_CMDS missing, $(ls "$USER_COMMANDS_DIR"/*.md 2>/dev/null | wc -l) total in user scope"

#----- DigitalOcean API token (optional, vault-sourced) ----------------------
# If BW_SESSION is in env (vault unlocked successfully), try to fetch the DO
# API token from the vault item literally named "DigitalOcean API Token" and
# export as DIGITALOCEAN_ACCESS_TOKEN so the lab-do MCP server (and any
# direct doctl calls from Claude shells) can authenticate. Falls back to
# whatever's in env if the vault lookup fails.
if [ -n "${BW_SESSION:-}" ] && [ -z "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]; then
  # Try Login-type first (token in password field), then Secure Note (token
  # in notes body). Either storage convention works.
  DO_TOKEN=$(bw get password "DigitalOcean API Token" 2>/dev/null)
  DO_TOKEN_SOURCE=password
  if [ -z "$DO_TOKEN" ]; then
    DO_TOKEN=$(bw get notes "DigitalOcean API Token" 2>/dev/null | head -1 | tr -d '[:space:]')
    DO_TOKEN_SOURCE=notes
  fi
  if [ -n "$DO_TOKEN" ]; then
    export DIGITALOCEAN_ACCESS_TOKEN="$DO_TOKEN"
    echo "[claude-init] DIGITALOCEAN_ACCESS_TOKEN sourced from vault item 'DigitalOcean API Token' (${DO_TOKEN_SOURCE} field, ${#DO_TOKEN} chars)"
  fi
fi

#----- MCP servers ------------------------------------------------------------
# Snapshot what's already registered so we don't churn through `claude mcp add`
# for servers that already exist (which is slow and prints noisy warnings).
EXISTING=$(claude mcp list 2>/dev/null | awk -F: '{print $1}' | tr -d ' ' | tr '\n' ' ')

ensure_mcp() {
  local name="$1"
  shift
  if echo " $EXISTING " | grep -q " $name "; then
    return 0
  fi
  if claude mcp add "$name" --scope user "$@" >/dev/null 2>&1; then
    echo "[claude-init] registered mcp '$name'"
  else
    echo "[claude-init] WARN: failed to register mcp '$name'" >&2
  fi
}

ensure_mcp ruflo                -e CLAUDE_FLOW_CWD="$HOME" -- ruflo mcp start
ensure_mcp playwright           -- playwright-mcp --headless --isolated --executable-path /usr/local/bin/playwright-chromium --output-dir /tmp/playwright-mcp
ensure_mcp task-master-ai       -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" -- npx -y task-master-ai
ensure_mcp sequential-thinking  -- npx -y @modelcontextprotocol/server-sequential-thinking
ensure_mcp context7             -- npx -y @upstash/context7-mcp
ensure_mcp lab-do               -e DIGITALOCEAN_ACCESS_TOKEN="${DIGITALOCEAN_ACCESS_TOKEN:-}" -- node /app/mcp-servers/digitalocean/server.js
ensure_mcp lab-kitvm3           -- node /app/mcp-servers/kitvm3/server.js
ensure_mcp lab-environments     -- node /app/mcp-servers/lab-environments/server.js
ensure_mcp lab-cf               -- node /app/mcp-servers/cloudflare/server.js
ensure_mcp lab-inmotion         -- node /app/mcp-servers/inmotion/server.js
ensure_mcp lab-aws-ec2          -- node /app/mcp-servers/aws-ec2/server.js

exec "$@"
