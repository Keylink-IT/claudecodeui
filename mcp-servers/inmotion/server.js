#!/usr/bin/env node
/**
 * Inmotion Hosting MCP server — exposes WHM/cPanel account discovery + SSH
 * as tools for Claude. Calls the WHM JSON API directly (no CLI) and shells
 * out to /usr/bin/ssh for command execution.
 *
 * Multi-server auth via Vaultwarden. Each WHM server gets its own Login item
 * named `whm-server-<slug>` in the CloudCLI Tools collection, with:
 *   - URI:      WHM API hostname (e.g., "whm01.example.com" — port defaults to 2087)
 *   - Username: WHM admin user (typically "root")
 *   - Password: WHM API token (created in WHM > Manage API Tokens)
 *   - Notes:    root SSH private key body (PEM/OpenSSH format)
 *
 * The MCP resolves the slug at call time, caches the token + connection info
 * for the session, and lazily materializes the SSH key to a tempfile (mode 600)
 * for ssh invocations.
 *
 * Tools:
 *   inmotion_list_servers          — enumerate available `whm-server-*` slugs
 *   inmotion_list_accounts(server) — WHM listaccts for one server
 *   inmotion_get_account(server, account) — accountsummary for one cPanel acct
 *   inmotion_ssh_command(server, command, account?) — SSH root@server,
 *       optionally `su - <account> -c`, returns stdout/stderr/exit
 *
 * Designed for the lab.keylinkit cloudcli container. Auto-registered as
 * a user-scope MCP server by /usr/local/bin/claude-init.sh on every
 * container start.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const VAULT_PREFIX = 'whm-server-';
const DEFAULT_WHM_PORT = 2087;
const SKIP_TLS_VERIFY = process.env.INMOTION_SKIP_TLS_VERIFY === '1';

// In-process caches (per Claude session — server is spawned per session via
// stdio). Restart the session to refresh.
const serverConfigCache = new Map();   // slug -> { host, user, token }
const sshKeyPathCache = new Map();     // slug -> tempfile path of materialized key

const server = new Server(
  { name: 'lab-inmotion', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- shell helper --------------------------------------------------

function execProcess(cmd, args, { timeoutSeconds = 30, input } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

// ---------- vault resolution ----------------------------------------------

async function resolveServerConfig(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('server parameter is required (slug, e.g. "whm01"). Use inmotion_list_servers to discover.');
  }
  if (serverConfigCache.has(slug)) return serverConfigCache.get(slug);
  if (!process.env.BW_SESSION) {
    throw new Error('BW_SESSION not set — Vaultwarden CLI is not unlocked. Check `docker logs lab-cloudcli` for [bw-init].');
  }
  const itemName = `${VAULT_PREFIX}${slug}`;
  // Fetch the full item to get URI + username + password in one call.
  const result = await execProcess('bw', ['get', 'item', itemName], { timeoutSeconds: 30 });
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`vault item "${itemName}" not found: ${result.stderr || 'no output'}. Use inmotion_list_servers to see available slugs.`);
  }
  let item;
  try { item = JSON.parse(result.stdout); } catch (err) {
    throw new Error(`vault item "${itemName}" did not return JSON: ${err.message}`);
  }
  const login = item.login || {};
  const token = login.password;
  const user = login.username || 'root';
  const uri = (login.uris && login.uris[0] && login.uris[0].uri) || '';
  if (!token) {
    throw new Error(`vault item "${itemName}" has no password (WHM API token) set.`);
  }
  if (!uri) {
    throw new Error(`vault item "${itemName}" has no URI set — expected the WHM host (e.g. "whm01.example.com").`);
  }
  // Strip any scheme; we'll add https://. Port defaults to 2087 if not given.
  const hostPart = uri.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = hostPart.includes(':') ? hostPart : `${hostPart}:${DEFAULT_WHM_PORT}`;
  const config = { host, user, token };
  serverConfigCache.set(slug, config);
  return config;
}

async function resolveSshKeyPath(slug) {
  if (sshKeyPathCache.has(slug)) return sshKeyPathCache.get(slug);
  if (!process.env.BW_SESSION) {
    throw new Error('BW_SESSION not set — cannot fetch SSH key from vault.');
  }
  const itemName = `${VAULT_PREFIX}${slug}`;
  const result = await execProcess('bw', ['get', 'notes', itemName], { timeoutSeconds: 30 });
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`vault item "${itemName}" has no notes (SSH private key). Put the root key body in the Notes field.`);
  }
  // Write to a session-scoped tempfile with mode 600. Path includes a random
  // suffix so concurrent MCP sessions don't stomp each other.
  const hashSuffix = crypto.randomBytes(4).toString('hex');
  const tempPath = path.join(tmpdir(), `whm-${slug}-${hashSuffix}.key`);
  // bw's notes output sometimes drops the trailing newline OpenSSH expects;
  // append one if absent. Don't normalize line endings — let ssh complain
  // if the format is broken, with a clearer message than silent failure.
  let keyBody = result.stdout;
  if (!keyBody.endsWith('\n')) keyBody += '\n';
  await fs.writeFile(tempPath, keyBody, { mode: 0o600 });
  sshKeyPathCache.set(slug, tempPath);
  return tempPath;
}

// ---------- WHM API helper ------------------------------------------------

async function whmFetch(slug, fn, query = {}) {
  const { host, user, token } = await resolveServerConfig(slug);
  const url = new URL(`https://${host}/json-api/${fn}`);
  url.searchParams.set('api.version', '1');
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const opts = {
    headers: {
      Authorization: `whm ${user}:${token}`,
      Accept: 'application/json',
    },
  };
  if (SKIP_TLS_VERIFY) {
    // Allow self-signed certs when explicitly opted in. Default off.
    opts.agent = new (await import('node:https')).Agent({ rejectUnauthorized: false });
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  // WHM API returns 200 even on errors; status is in metadata.result (1 = ok).
  const meta = json?.metadata || {};
  if (!res.ok || meta.result === 0) {
    const reason = meta.reason || `HTTP ${res.status}`;
    throw new Error(`WHM ${fn} failed on ${slug}: ${reason}`);
  }
  return json.data || json;
}

// ---------- result wrappers -----------------------------------------------

function ok(content) {
  return {
    content: [{
      type: 'text',
      text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    }],
  };
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// ---------- tool registry --------------------------------------------------

const tools = [
  {
    name: 'inmotion_list_servers',
    description: 'List the WHM servers that have credentials stored in Vaultwarden. Returns slugs (e.g. "whm01") that can be passed as the `server` parameter to other inmotion_* tools. Convention: vault items named "whm-server-<slug>" in the CloudCLI Tools collection.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'inmotion_list_accounts',
    description: 'List all cPanel accounts on a WHM server via the WHM `listaccts` API. Returns user, domain, IP, package, owner, suspended status, etc. Use this to find the right `account` to pass to inmotion_ssh_command or inmotion_get_account.',
    inputSchema: {
      type: 'object',
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'WHM server slug (vault item suffix). Use inmotion_list_servers to discover.' },
        search: { type: 'string', description: 'Optional: WHM search string (matches across user/domain/owner). Equivalent to passing `search=<x>` in the WHM API.' },
        searchtype: { type: 'string', description: 'Optional: limit `search` to a field — one of "domain", "user", "owner", "ip", "package".' },
      },
    },
  },
  {
    name: 'inmotion_get_account',
    description: 'Get full account summary for one cPanel account on a WHM server (WHM `accountsummary` API). Returns user, domain, IP, disk usage, email count, etc.',
    inputSchema: {
      type: 'object',
      required: ['server', 'account'],
      properties: {
        server: { type: 'string', description: 'WHM server slug (vault item suffix)' },
        account: { type: 'string', description: 'cPanel username' },
      },
    },
  },
  {
    name: 'inmotion_ssh_command',
    description: 'Run a non-interactive command on a WHM server via SSH as root. If `account` is provided, the command is wrapped in `su - <account> -c "<command>"` so it executes as the cPanel user with that user\'s environment. Uses the root SSH private key stored in the vault item\'s Notes field. Returns stdout/stderr/exit_code as JSON.',
    inputSchema: {
      type: 'object',
      required: ['server', 'command'],
      properties: {
        server: { type: 'string', description: 'WHM server slug (vault item suffix)' },
        command: { type: 'string', description: 'Shell command to run on the remote' },
        account: { type: 'string', description: 'Optional: cPanel username to run AS via `su -`. Omit to run as root.' },
        timeout_seconds: { type: 'number', default: 30, description: 'Kill the SSH session after this many seconds.' },
      },
    },
  },
];

// ---------- request handlers ----------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'inmotion_list_servers': {
        if (!process.env.BW_SESSION) {
          return errorResult('BW_SESSION not set — Vaultwarden CLI is not unlocked.');
        }
        const result = await execProcess('bw', ['list', 'items', '--search', VAULT_PREFIX], { timeoutSeconds: 30 });
        if (result.code !== 0) return errorResult(`bw list failed: ${result.stderr}`);
        let items;
        try { items = JSON.parse(result.stdout || '[]'); } catch { items = []; }
        const servers = items
          .map((it) => it?.name || '')
          .filter((n) => n.startsWith(VAULT_PREFIX))
          .map((n) => n.slice(VAULT_PREFIX.length))
          .sort();
        return ok({ servers, count: servers.length, vault_prefix: VAULT_PREFIX });
      }

      case 'inmotion_list_accounts': {
        const query = {};
        if (args.search) query.search = args.search;
        if (args.searchtype) query.searchtype = args.searchtype;
        const data = await whmFetch(args.server, 'listaccts', query);
        const accounts = Array.isArray(data?.acct) ? data.acct : [];
        // Trim the response — listaccts returns 30+ fields per account, most
        // not useful. Return the high-signal ones; full record is one
        // inmotion_get_account call away.
        return ok(accounts.map((a) => ({
          user: a.user,
          domain: a.domain,
          ip: a.ip,
          owner: a.owner,
          plan: a.plan,
          suspended: a.suspended === 1 || a.suspended === '1',
          home: a.partition ? `/home/${a.user}` : undefined,
        })));
      }

      case 'inmotion_get_account': {
        if (!args.account) return errorResult('account is required');
        const data = await whmFetch(args.server, 'accountsummary', { user: args.account });
        return ok(data);
      }

      case 'inmotion_ssh_command': {
        const { server: slug, command, account, timeout_seconds = 30 } = args;
        if (!slug || !command) return errorResult('server and command are required');

        const config = await resolveServerConfig(slug);
        const keyPath = await resolveSshKeyPath(slug);

        // Strip the :port suffix for ssh — WHM API uses 2087 but SSH is 22.
        const sshHost = config.host.split(':')[0];

        // If `account` is given, wrap the command in `su - <account> -c "<command>"`
        // so it executes as that cPanel user. Otherwise run as root.
        // We single-quote-escape the command body to survive the shell wrap.
        const remoteCmd = account
          ? `su - ${account.replace(/[^A-Za-z0-9._-]/g, '')} -c ${shellQuoteSingle(command)}`
          : command;

        const sshArgs = [
          '-i', keyPath,
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'BatchMode=yes',
          '-o', `ConnectTimeout=${Math.min(timeout_seconds, 15)}`,
          '-o', 'LogLevel=ERROR',
          `${config.user}@${sshHost}`,
          '--',
          remoteCmd,
        ];

        const result = await execProcess('timeout', [String(timeout_seconds), 'ssh', ...sshArgs], {
          timeoutSeconds: timeout_seconds + 5,
        });
        return ok({
          server: slug,
          host: sshHost,
          user: config.user,
          account: account || null,
          exit_code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

function shellQuoteSingle(s) {
  // POSIX single-quote escape: end quote, escape any single quotes, reopen.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
