# syntax=docker/dockerfile:1
#
# CloudCLI fork — single-stage image for the lab.keylinkit droplet.
#
# Single-stage on purpose: 4 GB droplet, image size doesn't matter,
# debuggability and iteration speed do. Multi-stage when we need it.
#
# Companion docker-compose.yml lives in the parent lab.keylinkit/ repo
# and supplies bind mounts for ~/.cloudcli, ~/.claude, and the workspace.

FROM node:22-bookworm

# Native build deps (node-pty, better-sqlite3, bcrypt) plus the dev tools
# upstream's docker/shared/install-cloudcli.sh ships — the in-browser shell
# is a lot more useful with jq/ripgrep/sqlite/etc. on PATH.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python3-dev \
      python3-setuptools \
      python3-pip \
      python3-venv \
      libpq-dev \
      postgresql-client \
      git \
      jq \
      ripgrep \
      sqlite3 \
      zip \
      unzip \
      tree \
      vim \
      nano \
      tmux \
      htop \
      rsync \
      ncdu \
      fzf \
      fd-find \
      pandoc \
      ffmpeg \
      gh \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
# ^ interactive/media tool set (2026-08-12): these were hand-installed into the
#   running container for months and silently lost on every image rebuild
#   (see lab.keylinkit CHANGELOG 2026-08-12). tools/container-provision.sh in
#   lab.keylinkit is the runtime fallback — keep its APT_PKGS list in sync.
#   fd-find installs the binary as `fdfind`; the symlink gives it its usual name.

# yq (mikefarah) — not packaged in Debian bookworm; static binary.
RUN curl -fsSL -o /usr/local/bin/yq \
      https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
    && chmod +x /usr/local/bin/yq

# Python deps for in-house MCP servers (lab.keylinkit/mcp-servers/*).
# `mcp` is the official Anthropic Python MCP SDK. `psycopg[binary]` is the
# Postgres driver for our keylink-console MCP server. Installed system-wide
# via --break-system-packages because Debian Bookworm marks the system
# Python as PEP-668 externally-managed; we accept that since the only
# Python in this image is for our MCP servers, no system tooling depends
# on it. The break-system-packages flag was added in pip 23.0+.
RUN pip3 install --break-system-packages --no-cache-dir \
      "mcp>=1.0.0" \
      "psycopg[binary]>=3.2.0" \
      pillow \
      mammoth
# ^ pillow: image validation (nano-banana --validate, pdf tooling).
#   mammoth: .docx -> HTML for the Forge PRD parser (2026-08-12, same
#   rebuild-loss story as the apt block above).

# Graphify (safishamsi/graphify) — knowledge-graph builder + MCP server for
# codebases. Installed but NOT auto-registered as a user-scope MCP because
# the server needs a per-project graph.json that doesn't exist by default.
# Each project does `graphify .` once, then `claude mcp add graphify
# --scope project -- python -m graphify.serve ./graphify-out/graph.json`.
# The /graphify-init slash command bundles both steps.
#
# Gotcha: the PyPI package name is `graphifyy` with a DOUBLE Y — `graphify`
# (single y) on PyPI is an unrelated package. The upstream README calls
# this out explicitly. The `[mcp]` extra pulls in the MCP SDK needed to
# run `python -m graphify.serve`. ~150 MB layer (~25 tree-sitter language
# wheels download at install time, no GPU/daemon needed at runtime).
#
# Do NOT run `graphify claude install` inside the container — it auto-
# mutates the bind-mounted ~/.claude/settings.json with a PreToolUse hook
# and writes a section into CLAUDE.md, which is intrusive and out of scope
# for the lab's bind-mounted config. Manual registration via the slash
# command is the supported path.
RUN pip3 install --break-system-packages --no-cache-dir 'graphifyy[mcp]'

# Claude Code CLI itself. cloudcli's "Connect Claude" terminal shells out
# to `claude`, so it has to be on PATH inside the container.
RUN npm install -g @anthropic-ai/claude-code@2.1.160

# ruflo (multi-agent orchestration via @claude-flow/cli, exposed as MCP).
# Bake into the image so the binary is on PATH the moment the container
# starts; no first-run install race, and rebuilds pin the version.
# Registration as a Claude MCP server is a runtime step done once per
# fresh ~/.claude — see CLAUDE.md "Ruflo / MCP" section.
#
# PINNED to 3.5.78 deliberately. The two memory/security workarounds below
# (lines for memory-bridge.js and @claude-flow/security) reference paths
# and behaviors specific to this version. Upstream ruflo also (as of
# 2026-05-06) tags pre-release alphas as `latest` on npm — so an unpinned
# `npm install -g ruflo` will silently pick up a 3.7.0-alpha.X that breaks
# the build. Bump only after re-validating the workarounds against the
# new version's source.
RUN npm install -g ruflo@3.5.78

# TaskMaster AI (eyaltoledano/claude-task-master). AI-driven task management
# that decomposes PRDs into sequenced dev tasks. cloudcli's Settings → Tasks
# tab detects it via `which task-master && task-master --version`. Also
# registerable as an MCP server so Claude can use task-master tools natively
# in chat sessions. Pure JS, no native deps, ~10-20 MB.
RUN npm install -g task-master-ai

# Bitwarden CLI (`bw`) for Vaultwarden access. Auto-unlocked at container
# startup by /usr/local/bin/bw-init.sh using a service-account API key +
# master password from .env (BW_CLIENTID, BW_CLIENTSECRET, BW_PASSWORD).
# After unlock, BW_SESSION is exported to all child processes — Claude
# shells inherit it and can call `bw get/list/search` without credentials.
# Scoped to the read-only "CloudCLI Tools" collection per CLAUDE.md
# Vaultwarden integration design.
RUN npm install -g @bitwarden/cli

# DigitalOcean CLI (doctl) — auth via DIGITALOCEAN_ACCESS_TOKEN env var,
# populated by claude-init.sh from the vault item "DigitalOcean API Token".
# Underpins the lab-do MCP server (mcp-servers/digitalocean) which exposes
# droplet management as MCP tools to Claude.
ARG DOCTL_VERSION=1.110.0
RUN curl -fsSL "https://github.com/digitalocean/doctl/releases/download/v${DOCTL_VERSION}/doctl-${DOCTL_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C /usr/local/bin doctl \
    && chmod +x /usr/local/bin/doctl

# AWS CLI v2 — underpins the lab-aws-ec2 MCP server (mcp-servers/aws-ec2).
# Auth is per-call via env vars (AWS_ACCESS_KEY_ID/SECRET) sourced from
# Vaultwarden by the MCP, so no shared ~/.aws config in the image. v2 is
# preferred over v1 (deprecated for new installs); the official .zip
# installer is the supported path on Debian (apt's awscli is v1).
ARG AWSCLI_VERSION=2.17.42
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# cloudflared client — used as SSH ProxyCommand for connections to KITVM3
# (Hyper-V host on the office network, reachable only via Cloudflare Tunnel
# at kitvm3.keylinkit.net per the SSH config in ~/.ssh/config). Underpins
# the lab-kitvm3 MCP server (mcp-servers/kitvm3) which exposes Hyper-V VM
# management as MCP tools to Claude. The .deb install registers cloudflared
# as a service we DON'T want — we only need the binary as a client. Use
# the standalone binary download instead.
ARG CLOUDFLARED_VERSION=2026.3.0
RUN curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && chmod +x /usr/local/bin/cloudflared

# WORKAROUND 1: ruflo's bundled @xenova/transformers v2.17.2 hardcodes its
# model cache to `<package-install-dir>/.cache`, which is read-only to the
# `node` user inside the container. The library does NOT respect any env
# var for cache path in this version (only programmatic env.cacheDir).
# Result: every `ruflo memory *` call retries the ~90 MB Xenova model
# download, can't write the cache, spams EACCES errors, and (when output
# is piped through tail) appears to hang.
#
# Fix: symlink the hardcoded cache path to a directory under the
# bind-mounted ~/.claude-flow/cache/, so writes succeed AND the downloaded
# model survives across image rebuilds.
RUN ln -s /home/node/.claude-flow/cache/transformers \
      /usr/local/lib/node_modules/ruflo/node_modules/@xenova/transformers/.cache

# WORKAROUND 2: in ruflo v3.5.78, every memory operation (store, retrieve,
# search, list) tries the "AgentDB v3 bridge" path first via getBridge() in
# memory-initializer.js. The bridge intercepts everything, returns success-
# shaped results, but does NOT actually persist to the bind-mounted SQLite
# db that the fallback path would use. Net effect: `ruflo memory store`
# reports "Data stored successfully" with an entry id, but a direct sqlite3
# query of memory.db shows zero rows, every queryable table empty, and
# subsequent retrieve/list/search return "No entries found".
#
# Root cause: AgentDB v3 init reports "Activated: 15 Failed: 8" — 8 of 23
# controllers fail silently, leaving the bridge in a half-initialized state
# that accepts writes but doesn't durably persist them. Same code path is
# used by both the CLI and the MCP `memory_*` tools, so Claude can't escape
# the bug either.
#
# Fix: rename memory-bridge.js so the dynamic import in getBridge() throws.
# The catch block sets `_bridge = null` and every storeEntry/searchEntries
# call falls through to the working raw-sql.js fallback that writes to
# `process.cwd()/.swarm/memory.db` (which we bind-mount via data/swarm/).
#
# Trade-off: we lose the AgentDB v3 features the bridge enables — BM25
# hybrid search, ReasoningBank pattern store, CausalMemoryGraph edges,
# ExplainableRecall provenance, AttestationLog. None of these were working
# anyway given the failed controllers. The fallback gives us actual,
# durable, namespace-scoped key/value memory with vector embeddings and
# HNSW similarity search — which is the 80% use case.
#
# When ruflo upstream fixes the bridge, undo this by removing the rename
# (or pinning to a version that doesn't have the bug).
RUN mv /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js \
      /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js.disabled-by-fork

# WORKAROUND 3: in ruflo v3.5.78, MCP tool input validation runs through an
# OPTIONAL @claude-flow/security module via a dynamic import in
# `mcp-tools/validate-input.js#getSecurityModule()`. The intent is "load
# enhanced Zod schemas if available, fall through to working inline regex
# checks otherwise". Same defensive-fallback pattern as the memory bridge.
#
# Bug: the security module's `SpawnAgentSchema` Zod schema disagrees with
# every other place in the codebase about field names. The MCP tool, the
# CLI handler, and validate-input.js's inline checks all use `agentType`,
# but the security schema requires literal `type`. Result: every single
# `mcp__ruflo__agent_spawn` call fails with `Input validation failed:
# type: Required` — the field the schema wants doesn't exist anywhere on
# the calling side. The CLI path swallows this error silently and prints
# "Agent X spawned successfully" with empty fields (no agent is actually
# created — `ruflo agent list` returns 0 entries afterward).
#
# Fix: rename the @claude-flow/security package directory so the dynamic
# import in getSecurityModule() throws. The catch block sets
# `_securityModule = null`, validateAgentSpawn falls through to its inline
# regex checks (which work correctly), and agent_spawn calls succeed.
#
# Trade-off: lose the additional Zod-based validation hardening that the
# security package was meant to provide. Acceptable because (a) it doesn't
# work anyway in this version, and (b) inline regex checks are still
# applied — we're not disabling validation, just disabling the broken
# *enhanced* validation layer.
#
# When ruflo upstream fixes the field-name mismatch, undo this by removing
# the rename. The same security package may also affect other tools that
# call validateAgentSpawn or sibling validators — if anything else breaks
# with a similar "Input validation failed" pattern, this is the first
# place to look.
RUN mv /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/security \
      /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/security.disabled-by-fork

# Playwright MCP server (microsoft/playwright-mcp). Lets Claude drive a real
# headless browser via the Playwright API — useful for scraping,
# screenshotting, filling forms, and debugging end-to-end browser tests
# from inside a chat session.
#
# WHY THE BUNDLED CHROMIUM HEADLESS SHELL, AND WHY THE STABLE SYMLINK:
# playwright-mcp's `--browser` flag accepts only release channels —
# `chrome`, `firefox`, `webkit`, `msedge` — and defaults to `chrome`.
# We tried each of those:
#   - Google Chrome stable (147.0.7727): the bundled chrome_crashpad_handler
#     is broken on Debian Bookworm — Chrome's main process spawns it
#     without --database and the handler crashes the whole browser with
#     SIGTRAP on every navigate. No combination of --disable-crash-reporter,
#     --crash-dumps-dir, --user-data-dir flags suppresses it. Tested
#     2026-04-11.
#   - `--browser chromium`: rejected by playwright-mcp as an invalid
#     channel (the help text is correct, not incomplete).
#
# What DOES work: launching the bundled `chrome-headless-shell` binary
# (a stripped-down Chromium variant that ships with `playwright install
# chromium`) directly via playwright-mcp's `--executable-path` flag.
# We verified it works end-to-end in the same image.
#
# The footgun with --executable-path is the version-suffixed directory
# (e.g. /ms-playwright/chromium_headless_shell-1217/...) which changes
# every time playwright is upgraded — leaving a registration that
# silently breaks at the next rebuild. We sidestep this by creating a
# stable symlink at /usr/local/bin/playwright-chromium that resolves to
# whatever version the current image has, re-pointed by the build step
# itself on every rebuild. The MCP registration uses the stable name.
#
# `playwright install --with-deps chromium` does two things in one shot:
#   (1) apt-installs the system shared libs Chromium needs (libnss3,
#       libxkbcommon, libdrm, libgbm, libpango, libcairo, libasound2,
#       fonts-noto-color-emoji, etc — ~30 packages, ~250 MB)
#   (2) downloads the bundled Chromium build (~170 MB) into
#       PLAYWRIGHT_BROWSERS_PATH, including the chrome-headless-shell
#       variant we actually want
#
# We pin the browser cache to /ms-playwright (instead of the default
# ~/.cache/ms-playwright) so the binaries are owned by root, readable by
# everyone, and survive image rebuilds via the docker layer cache. The
# unprivileged `node` user reads from this path at runtime via the same
# PLAYWRIGHT_BROWSERS_PATH env var, which stays set for the runtime stage
# below — no chown needed.
#
# Registration as an MCP server is a runtime step done once per fresh
# ~/.claude.json — see CLAUDE.md "MCP servers" section for the
# `claude mcp add playwright ...` command.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @playwright/mcp playwright \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rx /ms-playwright \
    && BIN=$(ls /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell) \
    && ln -sf "$BIN" /usr/local/bin/playwright-chromium

# socket.io-client — the /setup-monitoring slash command drives Uptime Kuma's
# Socket.IO API via require('/usr/local/lib/node_modules/socket.io-client').
# Global install so ad-hoc scripts can use that fixed path (2026-08-12).
RUN npm install -g socket.io-client

# Reuse the base image's built-in `node` user (uid/gid 1000). It already
# matches the typical droplet user (waddl, also uid 1000) so bind-mounted
# dotdirs are writable without chown gymnastics, and creating a second
# uid-1000 account would just collide.

WORKDIR /app

# Install deps first for layer caching. HUSKY=0 skips git hook install
# (no .git in image and no commits happen from inside the container).
# scripts/ has to land before npm ci because cloudcli's postinstall hook
# (`node scripts/fix-node-pty.js`) runs during install — even though the
# script is a no-op on Linux, Node still tries to load it and crashes if
# the file isn't on disk.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts
RUN HUSKY=0 npm ci --include=dev

# Source + build. In 1.33 `npm run build` runs BOTH the client bundle
# (vite -> dist/) AND the server TypeScript compile (tsc -> dist-server/,
# via tsc + tsc-alias). The server now runs from the compiled dist-server/
# output (see CMD), not the TS-importing source under server/.
COPY --chown=node:node . .
RUN npm run build

# Install deps for the lab MCP servers shipped in this image. Each is a
# self-contained Node project under mcp-servers/<name>/ with its own
# package.json. claude-init.sh registers each one via `claude mcp add` so
# Claude sees the tools they expose. Adding a new server: drop it under
# mcp-servers/<name>/ and add an `ensure_mcp` line to claude-init.sh.
RUN for dir in /app/mcp-servers/*/; do \
      if [ -f "$dir/package.json" ]; then \
        echo "Installing deps for MCP server: $dir" && \
        cd "$dir" && npm install --omit=dev && cd /app; \
      fi; \
    done

# Pre-create /home/node/.config as node-owned. Without this, the
# ./data/git bind mount at /home/node/.config/git causes Docker to
# auto-create the parent /home/node/.config as root-owned, which then
# blocks `bw` (and any other tool) from mkdir-ing siblings under it.
USER root
RUN mkdir -p /home/node/.config && chown node:node /home/node/.config

# bw-init wrapper: auto-unlock Vaultwarden at startup, export BW_SESSION
# into env, then chain to claude-init.sh. Fail-open if creds aren't
# configured (logs friendly message and continues).
#
# claude-init wrapper: rehydrate user-scope Claude Code config that should
# always be present — slash commands at ~/.claude/commands/ and the
# locally-registered MCP servers. Recovers from bind-mount drift / Claude
# Code schema migrations that strip them. Idempotent. Always exec's CMD.
COPY --chown=node:node scripts/bw-init.sh /usr/local/bin/bw-init.sh
COPY --chown=node:node scripts/claude-init.sh /usr/local/bin/claude-init.sh
RUN chmod 755 /usr/local/bin/bw-init.sh /usr/local/bin/claude-init.sh

USER node
ENV NODE_ENV=production
EXPOSE 3001

# bw-init unlocks Vaultwarden, then chains to claude-init (slash-command + MCP
# rehydration), which finally exec's CMD. Fail-open throughout, so the server
# still starts when vault creds are absent.
ENTRYPOINT ["/usr/local/bin/bw-init.sh"]
# 1.33 runs the COMPILED server (tsc -> dist-server/), not the source under
# server/ (whose @/ imports only resolve after tsc + tsc-alias).
CMD ["node", "dist-server/server/index.js"]
