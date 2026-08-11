/**
 * Proxy routes for console.keylinkit.com — the team's project + task tracker.
 *
 * Why a server-side proxy: the Console API token lives in Vaultwarden, fetched
 * via `bw get password console-token-prod` on the lab's service-account session.
 * Browser clients can't (and shouldn't) reach that — so the wizard React calls
 * cloudcli, cloudcli calls Console with a Bearer token. Same shape as how the
 * lab-cf MCP wraps its CF API token: lazy bw lookup, in-process cache.
 *
 * Endpoints:
 *   GET  /api/console/projects?q=&limit=&cursor=  — list projects (search)
 *   POST /api/console/projects                    — create a project
 *   POST /api/console/projects/:id/tasks          — push tasks (with status
 *                                                   enum translation)
 *
 * The task-push endpoint also handles the task-master → Console board status
 * translation per the Console API v1 contract:
 *   pending     → backlog
 *   in_progress → in_progress
 *   done        → done
 *   deferred    → backlog
 *   blocked     → review
 *
 * Token lookup is cached in-process for 5 minutes. To force a refresh, restart
 * the cloudcli server (or the container).
 */

import express from 'express';
import { spawn } from 'child_process';

const router = express.Router();

const CONSOLE_API_BASE = process.env.CONSOLE_API_URL || 'https://console.keylinkit.com/api/v1';
const VAULT_ITEM_NAME = process.env.CONSOLE_TOKEN_VAULT_ITEM || 'console-token-prod';
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// task-master status → Console board column. Source of truth: Console API v1
// handoff doc. Priority passes through unchanged.
const STATUS_TRANSLATION = Object.freeze({
  pending: 'backlog',
  in_progress: 'in_progress',
  done: 'done',
  deferred: 'backlog',
  blocked: 'review',
});

let tokenCache = { value: null, fetchedAt: 0 };

// ---------- token resolution ----------------------------------------------

// bw CLI is genuinely slow on cold-start — ~8s typical even on warm vault.
// Anything under ~30s would intermittently false-positive a timeout.
function execProcess(cmd, args, { timeoutSeconds = 30 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      stderr += `\n[timeout after ${timeoutSeconds}s]`;
    }, timeoutSeconds * 1000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `spawn: ${err.message}` });
    });
  });
}

async function resolveConsoleToken() {
  const now = Date.now();
  if (tokenCache.value && now - tokenCache.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return tokenCache.value;
  }
  if (!process.env.BW_SESSION) {
    throw new Error(
      'BW_SESSION not set — Vaultwarden CLI is not unlocked. ' +
      'Check `docker logs lab-cloudcli` for the [bw-init] line.',
    );
  }
  const { code, stdout, stderr } = await execProcess('bw', ['get', 'password', VAULT_ITEM_NAME]);
  if (code !== 0 || !stdout) {
    throw new Error(`vault item "${VAULT_ITEM_NAME}" not found or empty: ${stderr || 'no output'}`);
  }
  tokenCache = { value: stdout, fetchedAt: now };
  return stdout;
}

// ---------- Console fetch helper ------------------------------------------

async function consoleFetch(pathStr, { method = 'GET', body, query } = {}) {
  const token = await resolveConsoleToken();
  const url = new URL(`${CONSOLE_API_BASE}${pathStr}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

// ---------- routes ---------------------------------------------------------

router.get('/projects', async (req, res) => {
  try {
    const { q, limit, cursor } = req.query;
    const result = await consoleFetch('/projects', { query: { q, limit, cursor } });
    if (!result.ok) {
      return res.status(result.status).json({ error: 'Console API error', details: result.body });
    }
    res.json(result.body);
  } catch (err) {
    console.error('console.projects.list error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch Console projects' });
  }
});

router.post('/projects', express.json(), async (req, res) => {
  try {
    const { name, description, type, prd_url, metadata } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const body = {
      name: String(name).trim(),
      description: description || '',
      type: type || 'dev',
      metadata: { source: 'cloudcli-from-prd-wizard', ...(metadata || {}) },
    };
    if (prd_url) body.prd_url = prd_url;

    const result = await consoleFetch('/projects', { method: 'POST', body });
    if (!result.ok) {
      return res.status(result.status).json({ error: 'Console API error', details: result.body });
    }
    res.status(201).json(result.body);
  } catch (err) {
    console.error('console.projects.create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create Console project' });
  }
});

router.post('/projects/:id/tasks', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const { tasks, source, replace } = req.body || {};
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'tasks must be an array' });
    }
    // Translate task-master status → Console board column. Priority passes
    // through. Unknown statuses fall through to backlog with a warning header.
    const unknownStatuses = new Set();
    const translated = tasks.map((task) => {
      const original = task && task.status;
      const mapped = STATUS_TRANSLATION[original];
      if (!mapped && original) unknownStatuses.add(original);
      return { ...task, status: mapped || 'backlog' };
    });
    const body = {
      tasks: translated,
      source: source || 'cloudcli-task-master',
      replace: Boolean(replace),
    };

    const result = await consoleFetch(`/projects/${encodeURIComponent(id)}/tasks`, {
      method: 'POST',
      body,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: 'Console API error', details: result.body });
    }
    if (unknownStatuses.size > 0) {
      res.set('X-Cloudcli-Unknown-Statuses', Array.from(unknownStatuses).join(','));
    }
    res.json(result.body);
  } catch (err) {
    console.error('console.projects.tasks error:', err);
    res.status(500).json({ error: err.message || 'Failed to push tasks to Console' });
  }
});

export default router;
