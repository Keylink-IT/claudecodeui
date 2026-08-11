import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { authenticateToken } from '../modules/auth/index.js';
import { projectsDb } from '../modules/database/index.js';

const router = express.Router();

// In-memory caches with TTL. Both list endpoints are slow:
//  - doctl list: ~1-2s, hits the DO API with auth
//  - Get-VM via SSH-over-cloudflared: 20-40s on cold tunnel, 1-2s warm
// The picker UI loads them on demand, so caching makes opening the modal
// snappy and avoids re-cold-starting the tunnel for every user click.
const CACHE_TTL_MS = 5 * 60 * 1000;
const dropletsCache = { data: null, fetchedAt: 0, error: null };
const vmsCache = { data: null, fetchedAt: 0, error: null };
const inmotionServersCache = { data: null, fetchedAt: 0 };
const inmotionAccountsCache = new Map(); // server slug → { data, fetchedAt }
const ec2InstancesCache = new Map();     // region → { data, fetchedAt }
const ec2CredsCache = { data: null, fetchedAt: 0 };

const WHM_VAULT_PREFIX = 'whm-server-';
const AWS_VAULT_ITEM = process.env.AWS_CREDS_VAULT_ITEM || 'aws-creds-prod';

const ENV_FILE_RELPATH = path.join('.lab', 'environments.json');

const ENV_DEFAULTS = Object.freeze({
  production: null,
  development: null,
});

// ---------- helpers --------------------------------------------------------

function execProcess(cmd, args, { timeoutSeconds = 60, env = process.env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = timeoutSeconds > 0
      ? setTimeout(() => {
        proc.kill('SIGKILL');
        stderr += `\n[killed by timeout after ${timeoutSeconds}s]`;
      }, timeoutSeconds * 1000)
      : null;
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}` });
    });
  });
}

async function resolveProjectPath(projectId) {
  // 1.33: projects are addressed by DB projectId; resolve it to the on-disk path
  // (replaces the legacy name-based extractProjectDirectory removed upstream).
  const dir = projectsDb.getProjectPathById(projectId);
  if (!dir) return null;
  // Sanity: the path resolution can return a synthesized directory name when
  // there are no .jsonl sessions yet. Verify the directory actually exists.
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

async function readEnvironmentsFile(projectPath) {
  const filePath = path.join(projectPath, ENV_FILE_RELPATH);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      production: parsed.production ?? null,
      development: parsed.development ?? null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...ENV_DEFAULTS };
    throw err;
  }
}

async function writeEnvironmentsFile(projectPath, envs) {
  const dir = path.join(projectPath, '.lab');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify(envs, null, 2) + '\n';
  await fs.writeFile(path.join(dir, 'environments.json'), content, 'utf-8');
}

function normalizeExtras(entry) {
  // Pull through the optional rich-doc fields (services / urls / deploy_notes)
  // that any kind may carry. Validate shapes lightly; drop anything malformed.
  const out = {};
  if (Array.isArray(entry.services)) {
    out.services = entry.services
      .filter((s) => s && typeof s === 'object' && s.name)
      .map((s) => ({
        name: String(s.name),
        port: s.port != null ? Number(s.port) : undefined,
        restart: s.restart ? String(s.restart) : undefined,
      }));
  }
  if (entry.urls && typeof entry.urls === 'object' && !Array.isArray(entry.urls)) {
    out.urls = Object.fromEntries(
      Object.entries(entry.urls)
        .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
        .map(([k, v]) => [k, String(v)]),
    );
  }
  if (typeof entry.deploy_notes === 'string') {
    out.deploy_notes = entry.deploy_notes;
  }
  return out;
}

function normalizeEnvironmentEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== 'object') return null;

  const kind = entry.kind;
  const extras = normalizeExtras(entry);

  if (kind === 'do_droplet') {
    if (entry.id === undefined && !entry.name) return null;
    return {
      kind: 'do_droplet',
      id: entry.id != null ? Number(entry.id) : null,
      name: entry.name ? String(entry.name) : null,
      region: entry.region ? String(entry.region) : null,
      ip: entry.ip ? String(entry.ip) : null,
      ...extras,
    };
  }
  if (kind === 'kitvm3_vm') {
    if (!entry.name) return null;
    return {
      kind: 'kitvm3_vm',
      name: String(entry.name),
      state: entry.state != null ? entry.state : null,
      ...extras,
    };
  }
  if (kind === 'inmotion_cpanel') {
    if (!entry.server || !entry.account) return null;
    return {
      kind: 'inmotion_cpanel',
      server: String(entry.server),
      account: String(entry.account),
      domain: entry.domain ? String(entry.domain) : null,
      ip: entry.ip ? String(entry.ip) : null,
      home_path: entry.home_path ? String(entry.home_path) : `/home/${entry.account}`,
      ...extras,
    };
  }
  if (kind === 'ec2_instance') {
    if (!entry.instance_id || !entry.region || !entry.public_ip || !entry.ssh_user || !entry.ssh_key_path) {
      return null;
    }
    return {
      kind: 'ec2_instance',
      instance_id: String(entry.instance_id),
      region: String(entry.region),
      public_ip: String(entry.public_ip),
      ssh_user: String(entry.ssh_user),
      ssh_key_path: String(entry.ssh_key_path),
      code_path: entry.code_path ? String(entry.code_path) : null,
      ...extras,
    };
  }
  return null;
}

// ---------- routes ---------------------------------------------------------

router.use(authenticateToken);

// GET /api/lab/projects/:projectName/environments
router.get('/projects/:projectName/environments', async (req, res) => {
  try {
    const projectPath = await resolveProjectPath(req.params.projectName);
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const envs = await readEnvironmentsFile(projectPath);
    res.json({ projectPath, environments: envs });
  } catch (err) {
    console.error('GET /lab/projects/:name/environments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/lab/projects/:projectName/environments
// Body: { production?: <entry|null>, development?: <entry|null> }
router.put('/projects/:projectName/environments', async (req, res) => {
  try {
    const projectPath = await resolveProjectPath(req.params.projectName);
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const incoming = req.body || {};
    const merged = await readEnvironmentsFile(projectPath);
    if ('production' in incoming) {
      merged.production = normalizeEnvironmentEntry(incoming.production);
    }
    if ('development' in incoming) {
      merged.development = normalizeEnvironmentEntry(incoming.development);
    }
    await writeEnvironmentsFile(projectPath, merged);
    res.json({ projectPath, environments: merged });
  } catch (err) {
    console.error('PUT /lab/projects/:name/environments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lab/droplets — cached doctl list
router.get('/droplets', async (req, res) => {
  const now = Date.now();
  const force = req.query.refresh === '1';
  if (!force && dropletsCache.data && now - dropletsCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ droplets: dropletsCache.data, cached: true, fetchedAt: dropletsCache.fetchedAt });
  }
  if (!process.env.DIGITALOCEAN_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'DIGITALOCEAN_ACCESS_TOKEN not set in container env' });
  }
  const result = await execProcess('doctl', ['compute', 'droplet', 'list', '-o', 'json'], { timeoutSeconds: 30 });
  if (result.code !== 0) {
    dropletsCache.error = result.stderr;
    return res.status(502).json({ error: 'doctl failed', details: result.stderr });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return res.status(502).json({ error: 'doctl returned non-JSON', details: result.stdout.slice(0, 500) });
  }
  // Slim to fields the picker needs.
  const droplets = parsed.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    region: d.region?.slug,
    size: d.size?.slug,
    ip: (d.networks?.v4 || []).find((n) => n.type === 'public')?.ip_address || null,
    tags: d.tags || [],
  }));
  dropletsCache.data = droplets;
  dropletsCache.fetchedAt = now;
  dropletsCache.error = null;
  res.json({ droplets, cached: false, fetchedAt: now });
});

// GET /api/lab/vms — cached `ssh kitvm3 'Get-VM | ConvertTo-Json'` output
router.get('/vms', async (req, res) => {
  const now = Date.now();
  const force = req.query.refresh === '1';
  if (!force && vmsCache.data && now - vmsCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ vms: vmsCache.data, cached: true, fetchedAt: vmsCache.fetchedAt });
  }
  // PowerShell 5.1 — no -EnumsAsStrings; State comes back as integer. The
  // picker UI doesn't really care about state for picker purposes (just
  // names + display), but expose it for richer UI later.
  const psCmd = 'Get-VM | Select-Object Name, State, MemoryAssigned, ProcessorCount | ConvertTo-Json -Depth 3 -Compress';
  // First call may cold-start cloudflared (20-40s); retry once on banner timeout.
  const tryCmd = async () => execProcess('ssh', ['kitvm3', psCmd], { timeoutSeconds: 60 });
  let result = await tryCmd();
  if (result.code !== 0 && result.stderr.includes('banner exchange')) {
    result = await tryCmd();
  }
  if (result.code !== 0) {
    vmsCache.error = result.stderr;
    return res.status(502).json({ error: 'ssh kitvm3 failed', details: result.stderr });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return res.status(502).json({ error: 'kitvm3 returned non-JSON', details: result.stdout.slice(0, 500) });
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const vms = list.map((v) => ({
    name: v.Name,
    state: v.State,
    memory_bytes: v.MemoryAssigned,
    vcpus: v.ProcessorCount,
  }));
  vmsCache.data = vms;
  vmsCache.fetchedAt = now;
  vmsCache.error = null;
  res.json({ vms, cached: false, fetchedAt: now });
});

// ---------- inmotion (WHM/cPanel) picker endpoints ------------------------

// Vault items live in the cloudcli@ service account's CloudCLI Tools
// collection (plus whatever else has been granted). Looking them up here
// duplicates a little of the lab-inmotion MCP's logic — accepted cost; the
// MCP server can't be called from cloudcli's express process because MCPs
// are stdio children of Claude Code, not of cloudcli.

async function bwGetItemJson(name) {
  const result = await execProcess('bw', ['get', 'item', name], { timeoutSeconds: 30 });
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`vault item "${name}" not found: ${result.stderr || 'no output'}`);
  }
  return JSON.parse(result.stdout);
}

// GET /api/lab/inmotion/servers
router.get('/inmotion/servers', async (req, res) => {
  const now = Date.now();
  const force = req.query.refresh === '1';
  if (!force && inmotionServersCache.data && now - inmotionServersCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ servers: inmotionServersCache.data, cached: true, fetchedAt: inmotionServersCache.fetchedAt });
  }
  if (!process.env.BW_SESSION) {
    return res.status(503).json({ error: 'BW_SESSION not set — Vaultwarden CLI is not unlocked.' });
  }
  const result = await execProcess('bw', ['list', 'items', '--search', WHM_VAULT_PREFIX], { timeoutSeconds: 30 });
  if (result.code !== 0) {
    return res.status(502).json({ error: 'bw list failed', details: result.stderr });
  }
  let items;
  try { items = JSON.parse(result.stdout || '[]'); }
  catch { return res.status(502).json({ error: 'bw list returned non-JSON' }); }

  // Each whm-server-<slug> item carries its WHM host in the URI field. We
  // surface that so the picker can show "<slug> — <host>" entries; the
  // picker doesn't need the token or SSH key (those are server-side only).
  const servers = items
    .filter((it) => typeof it?.name === 'string' && it.name.startsWith(WHM_VAULT_PREFIX))
    .map((it) => {
      const slug = it.name.slice(WHM_VAULT_PREFIX.length);
      const uri = it.login?.uris?.[0]?.uri || '';
      const host = uri.replace(/^https?:\/\//, '').replace(/\/+$/, '').split(':')[0] || null;
      return { slug, host };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  inmotionServersCache.data = servers;
  inmotionServersCache.fetchedAt = now;
  res.json({ servers, cached: false, fetchedAt: now });
});

// GET /api/lab/inmotion/accounts?server=<slug>
router.get('/inmotion/accounts', async (req, res) => {
  const slug = String(req.query.server || '').trim();
  if (!slug) return res.status(400).json({ error: 'server query param is required' });
  const now = Date.now();
  const force = req.query.refresh === '1';
  const cached = inmotionAccountsCache.get(slug);
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return res.json({ server: slug, accounts: cached.data, cached: true, fetchedAt: cached.fetchedAt });
  }
  if (!process.env.BW_SESSION) {
    return res.status(503).json({ error: 'BW_SESSION not set — Vaultwarden CLI is not unlocked.' });
  }

  let item;
  try { item = await bwGetItemJson(`${WHM_VAULT_PREFIX}${slug}`); }
  catch (err) { return res.status(404).json({ error: err.message }); }

  const login = item.login || {};
  const token = login.password;
  const user = login.username || 'root';
  const uri = login.uris?.[0]?.uri || '';
  if (!token) return res.status(500).json({ error: `vault item "${WHM_VAULT_PREFIX}${slug}" has no password (WHM token)` });
  if (!uri) return res.status(500).json({ error: `vault item "${WHM_VAULT_PREFIX}${slug}" has no URI (WHM host)` });

  const hostPart = uri.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = hostPart.includes(':') ? hostPart : `${hostPart}:2087`;
  const url = `https://${host}/json-api/listaccts?api.version=1`;

  let json;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `whm ${user}:${token}`, Accept: 'application/json' },
    });
    json = await resp.json();
  } catch (err) {
    return res.status(502).json({ error: `WHM listaccts failed: ${err.message}` });
  }
  if (json?.metadata?.result === 0) {
    return res.status(502).json({ error: `WHM error: ${json.metadata.reason || 'unknown'}` });
  }

  const accounts = (json?.data?.acct || []).map((a) => ({
    user: a.user,
    domain: a.domain,
    ip: a.ip,
    owner: a.owner,
    plan: a.plan,
    suspended: a.suspended === 1 || a.suspended === '1',
  }));
  inmotionAccountsCache.set(slug, { data: accounts, fetchedAt: now });
  res.json({ server: slug, accounts, cached: false, fetchedAt: now });
});

// ---------- aws ec2 picker endpoint ---------------------------------------

async function resolveAwsCreds() {
  const now = Date.now();
  if (ec2CredsCache.data && now - ec2CredsCache.fetchedAt < CACHE_TTL_MS) return ec2CredsCache.data;
  if (!process.env.BW_SESSION) {
    throw new Error('BW_SESSION not set — Vaultwarden CLI is not unlocked.');
  }
  const item = await bwGetItemJson(AWS_VAULT_ITEM);
  const login = item.login || {};
  const access_key_id = login.username;
  const secret_access_key = login.password;
  if (!access_key_id || !secret_access_key) {
    throw new Error(`vault item "${AWS_VAULT_ITEM}" missing username (AWS_ACCESS_KEY_ID) or password (AWS_SECRET_ACCESS_KEY)`);
  }
  let default_region = 'us-east-1';
  if (item.notes && item.notes.trim()) {
    const firstLine = item.notes.split(/\r?\n/)[0].trim();
    if (/^[a-z]{2}-[a-z]+-\d$/.test(firstLine)) default_region = firstLine;
  }
  ec2CredsCache.data = { access_key_id, secret_access_key, default_region };
  ec2CredsCache.fetchedAt = now;
  return ec2CredsCache.data;
}

// GET /api/lab/ec2/instances?region=us-east-1
router.get('/ec2/instances', async (req, res) => {
  let creds;
  try { creds = await resolveAwsCreds(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const region = String(req.query.region || creds.default_region).trim();
  const now = Date.now();
  const force = req.query.refresh === '1';
  const cached = ec2InstancesCache.get(region);
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return res.json({ region, instances: cached.data, cached: true, fetchedAt: cached.fetchedAt, defaultRegion: creds.default_region });
  }

  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.access_key_id,
    AWS_SECRET_ACCESS_KEY: creds.secret_access_key,
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    AWS_PAGER: '',
  };
  const result = await execProcess('aws', ['ec2', 'describe-instances', '--output', 'json'], { timeoutSeconds: 60, env });
  if (result.code !== 0) {
    return res.status(502).json({ error: 'aws ec2 describe-instances failed', details: result.stderr });
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { return res.status(502).json({ error: 'aws returned non-JSON' }); }

  const instances = (parsed.Reservations || []).flatMap((r) => r.Instances || []).map((inst) => {
    const tags = Array.isArray(inst.Tags) ? inst.Tags : [];
    const nameTag = tags.find((t) => t.Key === 'Name');
    return {
      instance_id: inst.InstanceId,
      name: nameTag ? nameTag.Value : null,
      state: inst.State?.Name,
      instance_type: inst.InstanceType,
      public_ip: inst.PublicIpAddress || null,
      private_ip: inst.PrivateIpAddress || null,
      key_name: inst.KeyName || null,
      availability_zone: inst.Placement?.AvailabilityZone || null,
      tags: Object.fromEntries(tags.map((t) => [t.Key, t.Value])),
    };
  });
  ec2InstancesCache.set(region, { data: instances, fetchedAt: now });
  res.json({ region, instances, cached: false, fetchedAt: now, defaultRegion: creds.default_region });
});

export default router;
