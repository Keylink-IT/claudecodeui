# CloudCLI 1.28.1 → 1.33.0 — Change Summary
**For:** Grant · **Prepared:** 2026-06-02 · **Covers:** work since ~2026-05-30 (Sat)

## TL;DR
- Upgraded the keylink CloudCLI fork **1.28.1 → 1.33.0**, re-applying every fork customization on branch **`migrate/1.33`** (pushed to the Gitea fork `git.keylinkit.net/keylink-studio/cloudcli-deploy`).
- **Production (`lab.keylinkit.net`) is UNCHANGED — still on 1.28** (image `lab/cloudcli:dev`, container `lab-cloudcli`). It's the daily driver and was not disrupted.
- The 1.33 build runs at **`dev-lab.keylinkit.net`** (image `lab/cloudcli:133bb`, container `lab-cloudcli-dev` on `127.0.0.1:3010`) for side-by-side evaluation, against a **copy** of prod data.
- **A one-time data migration is required at cutover** (custom project/session renames) — see "Data migration" below. This is the main thing to know before going live.

## Why this was a real port (not a merge)
1.33 (upstream `siteboon/claudecodeui`) rewrote the server into TypeScript modules — `server/modules/{providers,projects,database,websocket}/*.ts` (provider registry + `AbstractProvider`, SQLite repositories, projects/sessions services) — and redesigned the chat composer, model selector, settings, and project wizard. Our 1.28 fork's server files (`projects.js`, `routes/*.js`, `database/db.js`) no longer exist upstream, and the frontend files were redesigned on both sides. So our changes were re-applied feature-by-feature ("buckets"), each gated with **both** `npm run build` (vite + server tsc + tsc-alias) **and** `tsc --noEmit` for frontend and server (vite alone doesn't type-check).

**1.33 build/run:** `npm run build` → `dist-server/`; run `node dist-server/server/index.js`. Dockerfile `ENTRYPOINT` = `bw-init.sh` → `claude-init.sh` → server.

## What changed, by area (branch `migrate/1.33`)
| Commit | Area | Summary |
|---|---|---|
| `e5639c7` | Build (H) | 1.33 Dockerfile: tsc server build → `dist-server`, run compiled; kept all tool installs; pinned `claude` CLI 2.1.160. |
| `5c54269`,`cf8c140` | DeepSeek (A) | DeepSeek as a native 1.33 provider module (`modules/providers/list/deepseek/`) — runs the Claude Code agent SDK against DeepSeek's Anthropic-compatible endpoint via per-call env overrides + an isolated `CLAUDE_CONFIG_DIR`. Frontend wired (provider selection, sidebar, logo, live-stream tag). |
| `15c9075` | Lab (C) | 6 standalone lab MCP servers (`mcp-servers/*`) + `routes/lab.js` (lab-environments API; resolves project dir via `projectsDb.getProjectPathById`) + the prod/dev environment pills + picker UI. |
| `74a504c` | Wizard/PRD/Forge (B) | Kept our 6-step project wizard (existing/new/**From-PRD** + Gitea remote + Console + Environments) as a superset of upstream's 2-step redesign; PRD editor; Forge/Gitea/Console route backends; **the 466-line `create-with-git` SSE endpoint** ported to a flat hybrid route (`routes/projects-create.js`) on top of 1.33's `createProject` (SQLite `projectsDb`) + shared `validateWorkspacePath`. |
| `db0413c` | Entrypoint (D) | Restored the `bw-init.sh` + `claude-init.sh` ENTRYPOINT chain (Vaultwarden unlock → MCP/slash-command rehydration → `exec` server). |
| `f09edd7` | Branding (E) | Removed GitHub-star badge / premium upsell (`GitHubStarBadge`, `useGitHubStars`, `PremiumFeatureCard`); fork version-upgrade modal (manual `git pull && docker compose up`, no in-UI auto-update); PRD tab (`'prd'` added to `AppTab`); 3-way i18n merge. |
| `fcc8900` | Activity (F) | Presence "Now" panel + persisted login history. `server/login-events.js` is self-contained: uses the shared better-sqlite3 connection (`getConnection`) + lazily `CREATE TABLE IF NOT EXISTS login_events` (core schema untouched). Adds `/api/auth/{login-events,active-sessions}`, `presence.register` in the WS server, `noteActivity` in the chat WS service, `trust proxy`. |
| `4c17ad4` | Voice (G) | Dictation mic in the redesigned `ChatComposer`; `useSpeechRecognition` rewritten for 1.33's newer `lib.dom` (the 1.28 `declare global` SpeechRecognition types circularly clashed with the now-built-in ones). |
| `e18db2e` | Models | Added **Opus 4.8** to the Claude picker (verified against the live Anthropic `/v1/models`: Opus 4.8 / Sonnet 4.6 / Haiku 4.5 are the current latest); default provider → **DeepSeek V4 Pro**. |

(Separately, the **DeepSeek 5th provider** was added to the 1.28 fork and re-architected onto the Claude Code agent SDK — that work is **live in prod** on 1.28.)

## ⚠️ Data migration required at cutover (the important part)
1.33 enumerates projects/sessions from a **SQLite `projects`/`sessions` DB** (populated by a boot-time session sync), not from the filesystem like 1.28. Three things don't carry automatically:
1. **Custom project renames** — 1.28 keeps them in `~/.claude/project-config.json` (e.g. "KIT-Console", "Allen-CampFix", "KIT-Synology"). 1.33 ignores that file → shows folder basenames.
2. **Custom session renames** — 1.28's `session_names` table; 1.33's schema doesn't carry it.
3. **Sessionless manually-added projects** (no Claude `.jsonl`) — 1.33's session-derived sync never creates rows for them.

**Fix (in repo): `scripts/migration/rename-migrate.cjs`** (+ `capture-sn.cjs` to snapshot `session_names` *before* 1.33 drops it). It's **non-destructive + re-runnable**: `UPDATE projects.custom_project_name` from `project-config.json` (and `INSERT` the sessionless ones) + `UPDATE sessions.custom_name` from the captured `session_names`. It persists across reboots because `createProjectPath`'s `ON CONFLICT` never overwrites `custom_project_name`, and the session synchronizer preserves an existing non-default `custom_name`.

**Also (PWA):** after any deploy, clients must visit `/clear-cache.html` or hard-refresh — the cached service worker otherwise serves the old app shell over the new backend and makes a healthy deploy look broken/empty. (This caused two false "everything's wiped" alarms during testing; data was always intact.)

## Current state / how to operate
- **prod** `lab.keylinkit.net` → 1.28 (`lab/cloudcli:dev`). Rollback image kept; daily driver.
- **eval** `dev-lab.keylinkit.net` → 1.33 (`lab/cloudcli:133bb`, container `lab-cloudcli-dev` :3010). (Used `dev-lab` not `dev.lab` — a 2-level subdomain isn't covered by the `*.keylinkit.net` cert; would need a CF Advanced Cert.)
- Recover the branch from the Gitea fork `keylink-studio/cloudcli-deploy` (`migrate/1.33`).
- 1.33 boots **~60–90s** (re-indexes the full session history on every start) vs 1.28's ~30s.

## Open items / TODO before going live
- **Clutter projects:** 1.33 lists non-projects it picks up from session cwds (`/app`, `/tmp`, `.worktrees/*`, `.claude/worktrees/*`). Needs an enumeration filter (code change) to match 1.28's list.
- **Cutover plan:** build/tag `:133` from `migrate/1.33` → point `docker-compose.yml` cloudcli at it → `docker compose up -d` → **run `rename-migrate.cjs`** → tell users to clear PWA cache. Keep `:dev` for instant rollback.
- 1.28 prod's own model picker is older (not updated); the 1.33 picker has Opus 4.8 / Sonnet 4.6 / Haiku 4.5.
