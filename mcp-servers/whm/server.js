#!/usr/bin/env node
/**
 * lab-whm — MCP server for WHM/cPanel administration of the Keylink WordPress
 * fleet (kitwebhost3 / kitwebhost4).
 *
 * Auth model (per design 2026-08-07): pure SSH as root using the root password
 * stored in Vaultwarden (items "Kitwebhost3" / "Kitwebhost4", same password).
 * No WHM API tokens — every WHM operation runs `whmapi1` / `uapi` over SSH and
 * parses the JSON output. Connection is over the PUBLIC hostname (the cloudcli
 * container is not itself a mesh node); the servers are on the kit headscale
 * mesh for other consumers.
 *
 * SSH password auth is done via the bundled ssh_exec.py (paramiko) because no
 * sshpass is installed. Secrets travel to the helper via env, never argv.
 *
 * Tools: whm_list_servers, whm_list_accounts, whm_get_account,
 *   whm_create_account, whm_suspend_account, whm_unsuspend_account,
 *   whm_list_email_accounts, whm_create_email_account, whm_reset_email_password,
 *   whm_list_dns_zone, whm_add_dns_record, whm_run_autossl,
 *   whm_fix_permissions, whm_exec
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSH_HELPER = path.join(__dirname, 'ssh_exec.py');

// Dedicated root key for these boxes (primary auth; deployed to /root/.ssh/
// authorized_keys on both, backed up in Vaultwarden). Password is the fallback.
const SSH_KEY_PATH = process.env.WHM_SSH_KEY || '/home/node/.ssh/kitwebhost_root_ed25519';

// Built-in server registry. Two stable servers, each reachable by TWO routes —
// public hostname first, then the headscale mesh IP — for redundancy.
// vaultItem: Vaultwarden Login holding the fallback root password. NOTE: the
// "Kitwebhost4" vault item password is stale; the working root password (same
// on both boxes) lives in "Kitwebhost3", so both use it as the password fallback.
const SERVERS = {
  kw3: { hosts: ['kitwebhost3.com', '100.64.0.17'], vaultItem: 'Kitwebhost3', meshIp: '100.64.0.17', label: 'kitwebhost3' },
  kw4: { hosts: ['kitwebhost4.com', '100.64.0.18'], vaultItem: 'Kitwebhost3', meshIp: '100.64.0.18', label: 'kitwebhost4' },
};

const passwordCache = new Map(); // slug -> root password

const server = new Server({ name: 'lab-whm', version: '0.1.0' }, { capabilities: { tools: {} } });

// ---------- helpers --------------------------------------------------------

function execProcess(cmd, args, { timeoutSeconds = 30, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); stderr += `\n[timeout after ${timeoutSeconds}s]`; }, timeoutSeconds * 1000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: `spawn: ${err.message}` }); });
  });
}

function requireServer(slug) {
  const s = SERVERS[slug];
  if (!s) throw new Error(`unknown server "${slug}". Valid: ${Object.keys(SERVERS).join(', ')} (use whm_list_servers).`);
  return s;
}

// Best-effort: the SSH key is primary auth, so a locked/empty vault must NOT
// block access. Return '' on any failure and let key auth carry the connection.
async function resolvePassword(slug) {
  if (passwordCache.has(slug)) return passwordCache.get(slug);
  if (!process.env.BW_SESSION) return '';
  const { vaultItem } = requireServer(slug);
  const r = await execProcess('bw', ['get', 'password', vaultItem], { timeoutSeconds: 30 });
  const pw = r.code === 0 ? r.stdout : '';
  passwordCache.set(slug, pw);
  return pw;
}

// POSIX single-quote escape for embedding a dynamic value inside a bash script.
function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// Run a bash script on the server. If asUser is set, the script runs as that
// cPanel user via `su`. Both transport layers are base64-wrapped so no quoting
// from su/ssh can corrupt the script; dynamic VALUES inside `script` must still
// be q()-quoted by the caller to stay injection-safe.
async function sshExec(slug, script, { asUser, timeout = 60 } = {}) {
  const s = requireServer(slug);
  const password = await resolvePassword(slug);
  let outer = script;
  if (asUser) {
    const safe = String(asUser).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe) throw new Error('invalid asUser');
    outer = `su -s /bin/bash - ${safe} -c "echo ${b64(script)}|base64 -d|bash"`;
  }
  const remote = `echo ${b64(outer)}|base64 -d|bash`;
  const env = { ...process.env, SSH_HOSTS: s.hosts.join(','), SSH_USER: 'root', SSH_PORT: '22', SSH_KEY: SSH_KEY_PATH, SSH_PASSWORD: password, SSH_COMMAND: remote, SSH_TIMEOUT: String(timeout) };
  const r = await execProcess('python3', [SSH_HELPER], { timeoutSeconds: timeout + 10, env });
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch { return { exit_code: r.code, stdout: r.stdout, stderr: r.stderr || 'ssh helper produced no JSON' }; }
  return parsed;
}

// Run a whmapi1 function (as root) and return parsed data.
async function whmapi1(slug, fn, params = {}, { timeout = 60 } = {}) {
  const parts = ['whmapi1', fn, '--output=jsonpretty'];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${q(v)}`);
  }
  const res = await sshExec(slug, parts.join(' '), { timeout });
  if (res.exit_code !== 0 && !res.stdout) throw new Error(`whmapi1 ${fn} transport failed: ${res.stderr}`);
  let json;
  try { json = JSON.parse(res.stdout); } catch { throw new Error(`whmapi1 ${fn} non-JSON output: ${(res.stdout || res.stderr).slice(0, 400)}`); }
  const meta = json.metadata || {};
  if (meta.result === 0 || meta.result === '0') throw new Error(`whmapi1 ${fn} failed: ${meta.reason || 'unknown'}`);
  return json.data || {};
}

// Run a uapi function AS a cPanel user (invoked by root via `uapi --user=`).
async function uapi(slug, account, mod, fn, params = {}, { timeout = 60 } = {}) {
  const acct = String(account).replace(/[^A-Za-z0-9._-]/g, '');
  const parts = ['uapi', `--user=${acct}`, mod, fn, '--output=jsonpretty'];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${q(v)}`);
  }
  const res = await sshExec(slug, parts.join(' '), { timeout });
  let json;
  try { json = JSON.parse(res.stdout); } catch { throw new Error(`uapi ${mod}::${fn} non-JSON output: ${(res.stdout || res.stderr).slice(0, 400)}`); }
  const r = json.result || {};
  if (r.status === 0 || r.status === '0') throw new Error(`uapi ${mod}::${fn} failed: ${(r.errors || ['unknown']).join('; ')}`);
  return r.data;
}

function ok(content) { return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] }; }
function errorResult(message) { return { isError: true, content: [{ type: 'text', text: message }] }; }

// Light guard for whm_exec — refuse obviously destructive one-liners unless confirmed.
const DANGER = /\brm\s+-rf?\s+\/(?:\s|$|home|etc|var|usr|boot|root)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bshutdown\b|\breboot\b|>\s*\/dev\/[sh]d/;

// ---------- tools ----------------------------------------------------------

const tools = [
  { name: 'whm_list_servers', description: 'List the WHM servers this MCP manages (kitwebhost3=kw3, kitwebhost4=kw4), with their public host and headscale mesh IP. Returns the slugs to pass as `server` to every other whm_* tool.', inputSchema: { type: 'object', properties: {} } },
  { name: 'whm_list_accounts', description: 'List cPanel accounts on a server (WHM listaccts). Returns user, domain, ip, owner, plan, suspended.', inputSchema: { type: 'object', required: ['server'], properties: { server: { type: 'string', description: 'kw3 or kw4' }, search: { type: 'string', description: 'optional WHM search string (user/domain/owner)' } } } },
  { name: 'whm_get_account', description: 'Full account summary for one cPanel account (WHM accountsummary).', inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string', description: 'cPanel username' } } } },
  { name: 'whm_create_account', description: 'Create a new cPanel account (WHM createacct).', inputSchema: { type: 'object', required: ['server', 'domain', 'username', 'password'], properties: { server: { type: 'string' }, domain: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, plan: { type: 'string', description: 'WHM package name (optional)' }, contactemail: { type: 'string' } } } },
  { name: 'whm_suspend_account', description: 'Suspend a cPanel account (WHM suspendacct).', inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string' }, reason: { type: 'string' } } } },
  { name: 'whm_unsuspend_account', description: 'Unsuspend a cPanel account (WHM unsuspendacct).', inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string' } } } },
  { name: 'whm_list_email_accounts', description: 'List email accounts for a cPanel user (UAPI Email::list_pops).', inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string', description: 'cPanel username that owns the mailboxes' } } } },
  { name: 'whm_create_email_account', description: 'Create an email account under a cPanel user (UAPI Email::add_pop). Provide the full email; the domain is derived from it.', inputSchema: { type: 'object', required: ['server', 'account', 'email', 'password'], properties: { server: { type: 'string' }, account: { type: 'string', description: 'cPanel username' }, email: { type: 'string', description: 'full email address, e.g. info@example.com' }, password: { type: 'string' }, quota: { type: 'number', description: 'mailbox quota in MB (0 = unlimited)', default: 0 } } } },
  { name: 'whm_reset_email_password', description: 'Reset an email account password (UAPI Email::passwd_pop).', inputSchema: { type: 'object', required: ['server', 'account', 'email', 'password'], properties: { server: { type: 'string' }, account: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } } } },
  { name: 'whm_list_dns_zone', description: 'Dump a DNS zone (WHM dumpzone). Returns all records for the domain.', inputSchema: { type: 'object', required: ['server', 'domain'], properties: { server: { type: 'string' }, domain: { type: 'string' } } } },
  { name: 'whm_add_dns_record', description: 'Add a DNS record to a zone (WHM addzonerecord). Supports A, AAAA, CNAME, TXT, MX.', inputSchema: { type: 'object', required: ['server', 'domain', 'name', 'type', 'value'], properties: { server: { type: 'string' }, domain: { type: 'string', description: 'zone/domain' }, name: { type: 'string', description: 'record name (e.g. "www" or "@")' }, type: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'TXT', 'MX'] }, value: { type: 'string', description: 'record data: IP for A/AAAA, target for CNAME/MX, text for TXT' }, ttl: { type: 'number', default: 14400 }, preference: { type: 'number', description: 'MX priority (MX only)', default: 10 } } } },
  { name: 'whm_run_autossl', description: 'Trigger an AutoSSL check/issuance for one cPanel user (WHM start_autossl_check_for_one_user).', inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string' } } } },
  { name: 'whm_fix_permissions', description: "Normalize file ownership and permissions for a cPanel account's public_html: chown to the account user, directories 755, files 644. Use this to repair 'insecure permissions' warnings.", inputSchema: { type: 'object', required: ['server', 'account'], properties: { server: { type: 'string' }, account: { type: 'string' } } } },
  { name: 'whm_exec', description: 'Run an arbitrary shell command on a server via SSH. Runs as root unless `account` is given (then via `su - <account>`). Destructive commands require confirm=true.', inputSchema: { type: 'object', required: ['server', 'command'], properties: { server: { type: 'string' }, command: { type: 'string' }, account: { type: 'string', description: 'optional cPanel user to run as' }, confirm: { type: 'boolean', description: 'set true to allow potentially destructive commands' }, timeout_seconds: { type: 'number', default: 60 } } } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    switch (name) {
      case 'whm_list_servers':
        return ok(Object.entries(SERVERS).map(([slug, s]) => ({ slug, label: s.label, routes: s.hosts, mesh_ip: s.meshIp, auth: 'key (primary) + password (fallback)' })));

      case 'whm_list_accounts': {
        const data = await whmapi1(a.server, 'listaccts', a.search ? { search: a.search, searchtype: 'user' } : {});
        const acct = Array.isArray(data.acct) ? data.acct : [];
        return ok(acct.map((x) => ({ user: x.user, domain: x.domain, ip: x.ip, owner: x.owner, plan: x.plan, suspended: x.suspended === 1 || x.suspended === '1' })));
      }

      case 'whm_get_account':
        if (!a.account) return errorResult('account is required');
        return ok(await whmapi1(a.server, 'accountsummary', { user: a.account }));

      case 'whm_create_account':
        return ok(await whmapi1(a.server, 'createacct', { username: a.username, domain: a.domain, password: a.password, plan: a.plan, contactemail: a.contactemail }, { timeout: 120 }));

      case 'whm_suspend_account':
        return ok(await whmapi1(a.server, 'suspendacct', { user: a.account, reason: a.reason }));

      case 'whm_unsuspend_account':
        return ok(await whmapi1(a.server, 'unsuspendacct', { user: a.account }));

      case 'whm_list_email_accounts':
        return ok(await uapi(a.server, a.account, 'Email', 'list_pops'));

      case 'whm_create_email_account': {
        const [local, domain] = String(a.email).split('@');
        if (!local || !domain) return errorResult('email must be a full address like info@example.com');
        return ok(await uapi(a.server, a.account, 'Email', 'add_pop', { email: local, domain, password: a.password, quota: a.quota ?? 0 }));
      }

      case 'whm_reset_email_password': {
        const [local, domain] = String(a.email).split('@');
        if (!local || !domain) return errorResult('email must be a full address like info@example.com');
        return ok(await uapi(a.server, a.account, 'Email', 'passwd_pop', { email: local, domain, password: a.password }));
      }

      case 'whm_list_dns_zone':
        return ok(await whmapi1(a.server, 'dumpzone', { domain: a.domain }));

      case 'whm_add_dns_record': {
        const p = { zone: a.domain, name: a.name, type: a.type, ttl: a.ttl ?? 14400, class: 'IN' };
        switch (a.type) {
          case 'A': case 'AAAA': p.address = a.value; break;
          case 'CNAME': p.cname = a.value; break;
          case 'TXT': p.txtdata = a.value; break;
          case 'MX': p.exchange = a.value; p.preference = a.preference ?? 10; break;
          default: return errorResult(`unsupported record type ${a.type}`);
        }
        return ok(await whmapi1(a.server, 'addzonerecord', p));
      }

      case 'whm_run_autossl':
        return ok(await whmapi1(a.server, 'start_autossl_check_for_one_user', { username: a.account }, { timeout: 90 }));

      case 'whm_fix_permissions': {
        const acct = String(a.account).replace(/[^A-Za-z0-9._-]/g, '');
        if (!acct) return errorResult('valid account is required');
        const script = [
          `set -e`,
          `dir=/home/${acct}/public_html`,
          `[ -d "$dir" ] || { echo "no public_html for ${acct}"; exit 2; }`,
          `chown -R ${acct}:${acct} "$dir"`,
          `find "$dir" -type d -exec chmod 755 {} +`,
          `find "$dir" -type f -exec chmod 644 {} +`,
          `echo "fixed: dirs=$(find "$dir" -type d|wc -l) files=$(find "$dir" -type f|wc -l) owner=${acct}"`,
        ].join('\n');
        const res = await sshExec(a.server, script, { timeout: 180 });
        return ok(res);
      }

      case 'whm_exec': {
        if (!a.command) return errorResult('command is required');
        if (DANGER.test(a.command) && a.confirm !== true) return errorResult('command looks destructive; re-call with confirm=true if you really mean it.');
        const res = await sshExec(a.server, a.command, { asUser: a.account, timeout: a.timeout_seconds || 60 });
        return ok(res);
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
