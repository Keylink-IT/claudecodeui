#!/bin/bash
#
# Auto-unlock the Bitwarden CLI service-account vault at container startup.
# Captures the unlocked session token and exports it as BW_SESSION so all
# child processes (cloudcli, every Claude shell it spawns) inherit it and
# can call `bw` without asking for credentials.
#
# Designed to FAIL OPEN: if any Vaultwarden creds are missing or wrong,
# log a friendly message and start cloudcli normally — image must remain
# usable when the service account isn't configured yet.
#
# Required env (set via docker-compose from .env):
#   BW_CLIENTID      — service account API client ID (Vaultwarden Settings → Security → API Key)
#   BW_CLIENTSECRET  — service account API client secret (same place)
#   BW_PASSWORD      — service account master password (used only to derive session, then scrubbed)
#
# After successful init, child processes inherit BW_SESSION (and ONLY that —
# the master password is unset before exec'ing the original CMD).

set -e

if [ -z "${BW_CLIENTID:-}" ] || [ -z "${BW_CLIENTSECRET:-}" ] || [ -z "${BW_PASSWORD:-}" ]; then
  echo "[bw-init] BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD not all set; skipping vault unlock." >&2
  exec /usr/local/bin/claude-init.sh "$@"
fi

# Always start from a fully clean bw state. `bw logout` clears the server
# config too, so we re-set it AFTER logout. Without this clean reset, stale
# login state from a prior container start can poison the unlock step even
# when the master password is correct.
bw logout >/dev/null 2>&1 || true
bw config server https://vault.keylinkit.net >/dev/null 2>&1 || true

# Authenticate with the API key. Reads BW_CLIENTID + BW_CLIENTSECRET from env.
LOGIN_ERR=$(mktemp)
if ! bw login --apikey 2>"$LOGIN_ERR" >/dev/null; then
  echo "[bw-init] bw login --apikey failed: $(cat "$LOGIN_ERR")" >&2
  rm -f "$LOGIN_ERR"
  unset BW_PASSWORD
  exec /usr/local/bin/claude-init.sh "$@"
fi
rm -f "$LOGIN_ERR"

# Unlock and capture the session token. --raw prints just the token to stdout.
# Capture stderr to a temp file so we can surface the actual error if unlock fails.
ERR=$(mktemp)
SESSION="$(bw unlock --raw --passwordenv BW_PASSWORD 2>"$ERR")"
if [ -z "$SESSION" ]; then
  echo "[bw-init] bw unlock failed: $(cat "$ERR")" >&2
  rm -f "$ERR"
  unset BW_PASSWORD
  exec /usr/local/bin/claude-init.sh "$@"
fi
rm -f "$ERR"

# Scrub the password so child processes (Claude shells, etc.) never see it.
# BW_SESSION is what's needed for every subsequent `bw` call.
unset BW_PASSWORD

export BW_SESSION="$SESSION"

echo "[bw-init] vault unlocked, BW_SESSION exported (${#SESSION} chars)." >&2
exec /usr/local/bin/claude-init.sh "$@"
