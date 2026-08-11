#!/usr/bin/env node
/**
 * Cloudflare MCP server — exposes Cloudflare zone, DNS, and tunnel
 * management as tools for Claude. Calls the Cloudflare REST API directly
 * via fetch — no CLI dependency.
 *
 * Multi-account: tokens are stored in Vaultwarden under items named
 * `cf-token-<account>` (slug). Every tool requires an `account` parameter;
 * the server resolves it via `bw get password "cf-token-${account}"` and
 * caches the resolved token in-process for the session. To rotate a token,
 * update the vault item and restart the cloudcli container (or the Claude
 * session — the MCP server is per-session).
 *
 * Tools:
 *   cf_list_accounts        — enumerate accounts available in the vault
 *   cf_token_verify         — verify token + show its scopes
 *   cf_account_list         — list CF accounts the token can see
 *   cf_zone_list            — list zones (optional name filter)
 *   cf_dns_record_list      — list DNS records in a zone
 *   cf_dns_record_create    — create a DNS record
 *   cf_dns_record_delete    — delete a DNS record (gated confirm=true)
 *   cf_tunnel_list          — list cfargo tunnels in an account
 *   cf_tunnel_create        — create a remotely-managed tunnel
 *   cf_tunnel_delete        — delete a tunnel (gated confirm=true)
 *   cf_tunnel_route_dns     — create CNAME hostname → <tunnel>.cfargotunnel.com
 *   cf_tunnel_config_put    — replace a remotely-managed tunnel's ingress
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

const CF_API = 'https://api.cloudflare.com/client/v4';
const VAULT_PREFIX = 'cf-token-';

// In-process caches (per Claude session, since the MCP server is spawned
// per session via stdio). Restart the session to refresh.
const tokenCache = new Map();      // account slug -> CF API token
const accountIdCache = new Map();  // account slug -> auto-resolved CF account_id

const server = new Server(
  { name: 'lab-cf', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- shell helper ---------------------------------------------------

function execProcess(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}` }));
    proc.stdin.end();
  });
}

// ---------- token resolution -----------------------------------------------

async function resolveToken(account) {
  if (!account || typeof account !== 'string') {
    throw new Error('account parameter is required (string slug, e.g. "keylinkit"). Use cf_list_accounts to discover available slugs.');
  }
  if (tokenCache.has(account)) return tokenCache.get(account);
  if (!process.env.BW_SESSION) {
    throw new Error('BW_SESSION env var not set — Vaultwarden CLI is not unlocked. The bw-init.sh entrypoint should have set this; check `docker logs lab-cloudcli` for the [bw-init] line.');
  }
  const itemName = `${VAULT_PREFIX}${account}`;
  const result = await execProcess('bw', ['get', 'password', itemName]);
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`vault item "${itemName}" not found or has no password field. Use cf_list_accounts to see available accounts.`);
  }
  tokenCache.set(account, result.stdout);
  return result.stdout;
}

// ---------- Cloudflare API helper -----------------------------------------

async function cfFetch(account, pathStr, { method = 'GET', body, query } = {}) {
  const token = await resolveToken(account);
  const url = new URL(`${CF_API}${pathStr}`);
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

  if (!res.ok || json?.success === false) {
    const errs = (json?.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare API ${method} ${pathStr} → HTTP ${res.status}${errs ? ` — ${errs}` : ''}`);
  }
  return json;
}

async function cfFetchAll(account, pathStr, { query } = {}) {
  const merged = [];
  let page = 1;
  const per_page = 50;
  while (true) {
    const resp = await cfFetch(account, pathStr, { query: { ...query, page, per_page } });
    const results = Array.isArray(resp.result) ? resp.result : [];
    merged.push(...results);
    const totalPages = resp.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
    if (page > 50) break; // safety
  }
  return merged;
}

// ---------- resolution helpers --------------------------------------------

async function resolveAccountId(account, accountIdHint) {
  if (accountIdHint) return accountIdHint;
  if (accountIdCache.has(account)) return accountIdCache.get(account);
  const accounts = await cfFetchAll(account, '/accounts');
  if (accounts.length === 0) {
    throw new Error(`token for "${account}" cannot see any Cloudflare accounts — check the token's permissions`);
  }
  if (accounts.length > 1) {
    const list = accounts.map((a) => `${a.id} (${a.name})`).join(', ');
    throw new Error(`token for "${account}" sees multiple accounts; pass account_id explicitly. Visible: ${list}`);
  }
  accountIdCache.set(account, accounts[0].id);
  return accounts[0].id;
}

async function resolveZoneId(account, zoneIdOrName) {
  if (!zoneIdOrName) throw new Error('zone (id or name) is required');
  // CF zone IDs are 32-char lowercase hex. Anything else is treated as a name.
  if (/^[0-9a-f]{32}$/i.test(zoneIdOrName)) return zoneIdOrName;
  const zones = await cfFetchAll(account, '/zones', { query: { name: zoneIdOrName } });
  if (zones.length === 0) {
    throw new Error(`zone "${zoneIdOrName}" not found in this account — use cf_zone_list to see available zones`);
  }
  return zones[0].id;
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
    name: 'cf_list_accounts',
    description: 'List the Cloudflare accounts that have API tokens stored in Vaultwarden. Returns slugs (e.g. "keylinkit") that can be passed as the `account` parameter to other cf_* tools. Convention: vault items named "cf-token-<slug>" with the API token in the password field.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cf_token_verify',
    description: "Verify the API token for an account is valid and show its status + scopes. Use this first if you suspect token issues — it catches the common 'wrong token type' mistake (e.g. a cloudflared connector token starting with 'cfut_' is NOT an API Bearer token and will fail every other tool).",
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix). Use cf_list_accounts to discover.' },
      },
    },
  },
  {
    name: 'cf_account_list',
    description: 'List the Cloudflare accounts this token can see. Useful for finding the account_id when a token has access to multiple accounts.',
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
      },
    },
  },
  {
    name: 'cf_zone_list',
    description: 'List zones (domains) the token can see. Optionally filter by exact name to look up a single zone.',
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        name: { type: 'string', description: 'Optional: exact zone name (e.g. "keylinkit.net")' },
      },
    },
  },
  {
    name: 'cf_dns_record_list',
    description: 'List DNS records in a zone. Pass either zone_id (32-char hex) or zone_name (e.g. "keylinkit.net") via `zone`.',
    inputSchema: {
      type: 'object',
      required: ['account', 'zone'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        zone: { type: 'string', description: 'Zone ID or zone name' },
        type: { type: 'string', description: 'Optional: filter by record type (A, AAAA, CNAME, TXT, MX, etc.)' },
        name: { type: 'string', description: 'Optional: filter by record name (FQDN)' },
      },
    },
  },
  {
    name: 'cf_dns_record_create',
    description: 'Create a DNS record in a zone. Returns the created record including its ID.',
    inputSchema: {
      type: 'object',
      required: ['account', 'zone', 'type', 'name', 'content'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        zone: { type: 'string', description: 'Zone ID or zone name' },
        type: { type: 'string', description: 'Record type (A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, etc.)' },
        name: { type: 'string', description: 'Record name (FQDN, e.g. "lab.keylinkit.net"). Use "@" for the zone apex.' },
        content: { type: 'string', description: 'Record value: IP address (A/AAAA), target hostname (CNAME), text content (TXT), etc.' },
        ttl: { type: 'number', default: 1, description: 'TTL in seconds. 1 = automatic.' },
        proxied: { type: 'boolean', default: false, description: 'Proxy through Cloudflare (orange cloud). Only valid for A/AAAA/CNAME.' },
        priority: { type: 'number', description: 'Required for MX records.' },
        comment: { type: 'string', description: 'Optional human-readable comment.' },
      },
    },
  },
  {
    name: 'cf_dns_record_delete',
    description: '⚠ Delete a DNS record. Get the record_id from cf_dns_record_list first. Pass confirm=true to actually proceed.',
    inputSchema: {
      type: 'object',
      required: ['account', 'zone', 'record_id', 'confirm'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        zone: { type: 'string', description: 'Zone ID or zone name' },
        record_id: { type: 'string', description: 'DNS record ID (from cf_dns_record_list)' },
        confirm: { type: 'boolean', description: 'Must be true to actually delete.' },
      },
    },
  },
  {
    name: 'cf_dns_record_update',
    description: 'Update an existing DNS record (PATCH semantics — only the fields you pass are changed). Use cf_dns_record_list to find the record_id first. Common use: flip the proxied flag, change a CNAME target, retarget an A record to a new IP without delete+recreate.',
    inputSchema: {
      type: 'object',
      required: ['account', 'zone', 'record_id'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        zone: { type: 'string', description: 'Zone ID or zone name' },
        record_id: { type: 'string', description: 'DNS record ID (from cf_dns_record_list)' },
        type: { type: 'string', description: 'Optional: new record type (rare — usually you want to delete+create instead)' },
        name: { type: 'string', description: 'Optional: new record name (FQDN)' },
        content: { type: 'string', description: 'Optional: new record value (IP, target hostname, TXT content, etc.)' },
        ttl: { type: 'number', description: 'Optional: new TTL in seconds. 1 = automatic.' },
        proxied: { type: 'boolean', description: 'Optional: new proxy setting (orange cloud). Only valid for A/AAAA/CNAME.' },
        priority: { type: 'number', description: 'Optional: new priority (MX records).' },
        comment: { type: 'string', description: 'Optional: new human-readable comment.' },
      },
    },
  },
  {
    name: 'cf_tunnel_list',
    description: 'List Cloudflare Tunnels (cfd_tunnel) in an account. By default includes tunnels in any state — use is_deleted=false to filter to only active ones.',
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        account_id: { type: 'string', description: 'Cloudflare account ID. Auto-resolved if the token sees exactly one account.' },
        is_deleted: { type: 'boolean', description: 'Optional: true = only deleted tunnels, false = only active.' },
        name: { type: 'string', description: 'Optional: filter to tunnels with this exact name.' },
      },
    },
  },
  {
    name: 'cf_tunnel_create',
    description: 'Create a new remotely-managed Cloudflare Tunnel. Returns the tunnel record + the connector token (the long string you pass to `cloudflared tunnel run --token <X>` on the host running the connector). After creation, set ingress rules with cf_tunnel_config_put and route hostnames with cf_tunnel_route_dns.',
    inputSchema: {
      type: 'object',
      required: ['account', 'name'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        account_id: { type: 'string', description: 'Cloudflare account ID. Auto-resolved if the token sees exactly one account.' },
        name: { type: 'string', description: 'Tunnel name (e.g. "lab-keylinkit")' },
      },
    },
  },
  {
    name: 'cf_tunnel_delete',
    description: '⚠ Delete a Cloudflare Tunnel. Connectors must be disconnected first or the API rejects the call (use cascade=true to detach connectors automatically). Pass confirm=true to actually proceed.',
    inputSchema: {
      type: 'object',
      required: ['account', 'tunnel_id', 'confirm'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        account_id: { type: 'string', description: 'Cloudflare account ID. Auto-resolved if the token sees exactly one account.' },
        tunnel_id: { type: 'string', description: 'Tunnel UUID' },
        cascade: { type: 'boolean', default: false, description: 'If true, detach any connected connectors before deleting.' },
        confirm: { type: 'boolean', description: 'Must be true to actually delete.' },
      },
    },
  },
  {
    name: 'cf_tunnel_route_dns',
    description: 'Create a CNAME pointing a hostname at a tunnel (proxied through Cloudflare) — equivalent to `cloudflared tunnel route dns <tunnel> <hostname>`. This is only the DNS half. For remotely-managed tunnels, also call cf_tunnel_config_put to add an ingress rule. For locally-managed tunnels (config.yml on a host), edit /etc/cloudflared/config.yml on that host.',
    inputSchema: {
      type: 'object',
      required: ['account', 'zone', 'hostname', 'tunnel_id'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        zone: { type: 'string', description: 'Zone ID or zone name (must contain the hostname)' },
        hostname: { type: 'string', description: 'FQDN to route (e.g. "lab.keylinkit.net")' },
        tunnel_id: { type: 'string', description: 'Tunnel UUID — the CNAME points to <tunnel_id>.cfargotunnel.com' },
        comment: { type: 'string', description: 'Optional comment on the DNS record.' },
      },
    },
  },
  {
    name: 'cf_tunnel_config_get',
    description: 'Read the current ingress configuration for a remotely-managed Cloudflare Tunnel. Use before cf_tunnel_config_put if you want to read-modify-write rather than overwrite the whole ingress array. Returns the full config block including ingress rules and warp_routing settings. Locally-managed tunnels return an empty config from this endpoint — their actual config lives in config.yml on the host.',
    inputSchema: {
      type: 'object',
      required: ['account', 'tunnel_id'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        account_id: { type: 'string', description: 'Cloudflare account ID. Auto-resolved if the token sees exactly one account.' },
        tunnel_id: { type: 'string', description: 'Tunnel UUID' },
      },
    },
  },
  {
    name: 'cf_tunnel_config_put',
    description: "Replace the ingress rule list for a remotely-managed Cloudflare Tunnel. ⚠ This OVERWRITES the entire ingress array — fetch the existing config first if you only want to add/modify a rule. Locally-managed tunnels (config.yml on a host) ignore this; use it only for tunnels created with cf_tunnel_create or another remotely-managed source. Last ingress entry MUST be a catch-all with no `hostname` field (e.g. {service: 'http_status:404'}).",
    inputSchema: {
      type: 'object',
      required: ['account', 'tunnel_id', 'ingress'],
      properties: {
        account: { type: 'string', description: 'Account slug (vault item suffix)' },
        account_id: { type: 'string', description: 'Cloudflare account ID. Auto-resolved if the token sees exactly one account.' },
        tunnel_id: { type: 'string', description: 'Tunnel UUID' },
        ingress: {
          type: 'array',
          description: 'Ordered ingress rule list. Last entry MUST be a catch-all (no hostname field).',
          items: {
            type: 'object',
            properties: {
              hostname: { type: 'string', description: 'Hostname this rule matches. Omit on the catch-all entry.' },
              path: { type: 'string', description: 'Optional path regex.' },
              service: { type: 'string', description: 'Origin URL (e.g. "http://localhost:3001") or built-in (e.g. "http_status:404").' },
              originRequest: { type: 'object', description: 'Optional per-rule origin overrides (httpHostHeader, noTLSVerify, etc.)' },
            },
          },
        },
        warp_routing: {
          type: 'object',
          description: 'Optional WARP routing config.',
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
  },
];

// ---------- request handlers -----------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'cf_list_accounts': {
        if (!process.env.BW_SESSION) {
          return errorResult('BW_SESSION not set — Vaultwarden CLI is not unlocked. Check `docker logs lab-cloudcli` for the [bw-init] line.');
        }
        const result = await execProcess('bw', ['list', 'items', '--search', VAULT_PREFIX]);
        if (result.code !== 0) return errorResult(`bw list failed: ${result.stderr}`);
        let items;
        try { items = JSON.parse(result.stdout || '[]'); } catch { items = []; }
        const accounts = items
          .map((it) => it?.name || '')
          .filter((n) => n.startsWith(VAULT_PREFIX))
          .map((n) => n.slice(VAULT_PREFIX.length))
          .sort();
        return ok({ accounts, count: accounts.length, vault_prefix: VAULT_PREFIX });
      }

      case 'cf_token_verify': {
        const resp = await cfFetch(args.account, '/user/tokens/verify');
        return ok(resp.result);
      }

      case 'cf_account_list': {
        const accounts = await cfFetchAll(args.account, '/accounts');
        return ok(accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })));
      }

      case 'cf_zone_list': {
        const zones = await cfFetchAll(args.account, '/zones', { query: { name: args.name } });
        return ok(zones.map((z) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          account: z.account?.id,
          plan: z.plan?.name,
          name_servers: z.name_servers,
        })));
      }

      case 'cf_dns_record_list': {
        const zoneId = await resolveZoneId(args.account, args.zone);
        const records = await cfFetchAll(args.account, `/zones/${zoneId}/dns_records`, {
          query: { type: args.type, name: args.name },
        });
        return ok(records);
      }

      case 'cf_dns_record_create': {
        const zoneId = await resolveZoneId(args.account, args.zone);
        const body = {
          type: args.type,
          name: args.name,
          content: args.content,
          ttl: args.ttl ?? 1,
          proxied: args.proxied ?? false,
        };
        if (args.priority !== undefined) body.priority = args.priority;
        if (args.comment) body.comment = args.comment;
        const resp = await cfFetch(args.account, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
        return ok(resp.result);
      }

      case 'cf_dns_record_delete': {
        if (args.confirm !== true) return errorResult('delete requires explicit confirm=true. Confirm with the user first.');
        const zoneId = await resolveZoneId(args.account, args.zone);
        const resp = await cfFetch(args.account, `/zones/${zoneId}/dns_records/${args.record_id}`, { method: 'DELETE' });
        return ok(resp.result);
      }

      case 'cf_dns_record_update': {
        const zoneId = await resolveZoneId(args.account, args.zone);
        const body = {};
        for (const k of ['type', 'name', 'content', 'ttl', 'proxied', 'priority', 'comment']) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        if (Object.keys(body).length === 0) return errorResult('cf_dns_record_update needs at least one field to change');
        const resp = await cfFetch(args.account, `/zones/${zoneId}/dns_records/${args.record_id}`, { method: 'PATCH', body });
        return ok(resp.result);
      }

      case 'cf_tunnel_list': {
        const accountId = await resolveAccountId(args.account, args.account_id);
        const tunnels = await cfFetchAll(args.account, `/accounts/${accountId}/cfd_tunnel`, {
          query: { is_deleted: args.is_deleted, name: args.name },
        });
        return ok(tunnels.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          created_at: t.created_at,
          deleted_at: t.deleted_at,
          connections: Array.isArray(t.connections) ? t.connections.length : 0,
          config_src: t.config_src,
        })));
      }

      case 'cf_tunnel_create': {
        const accountId = await resolveAccountId(args.account, args.account_id);
        const resp = await cfFetch(args.account, `/accounts/${accountId}/cfd_tunnel`, {
          method: 'POST',
          body: { name: args.name, config_src: 'cloudflare' },
        });
        let connectorToken = null;
        try {
          const tokenResp = await cfFetch(args.account, `/accounts/${accountId}/cfd_tunnel/${resp.result.id}/token`);
          connectorToken = tokenResp.result;
        } catch (_) { /* leave null; caller can re-fetch */ }
        return ok({
          tunnel: resp.result,
          connector_token: connectorToken,
          note: 'connector_token is the value to pass to `cloudflared tunnel run --token <X>` on the host running the connector. Treat as a secret.',
        });
      }

      case 'cf_tunnel_delete': {
        if (args.confirm !== true) return errorResult('delete requires explicit confirm=true. Confirm with the user first.');
        const accountId = await resolveAccountId(args.account, args.account_id);
        const resp = await cfFetch(args.account, `/accounts/${accountId}/cfd_tunnel/${args.tunnel_id}`, {
          method: 'DELETE',
          query: args.cascade ? { cascade: 'true' } : undefined,
        });
        return ok(resp.result);
      }

      case 'cf_tunnel_route_dns': {
        const zoneId = await resolveZoneId(args.account, args.zone);
        const body = {
          type: 'CNAME',
          name: args.hostname,
          content: `${args.tunnel_id}.cfargotunnel.com`,
          ttl: 1,
          proxied: true,
        };
        if (args.comment) body.comment = args.comment;
        const resp = await cfFetch(args.account, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
        return ok(resp.result);
      }

      case 'cf_tunnel_config_get': {
        const accountId = await resolveAccountId(args.account, args.account_id);
        const resp = await cfFetch(args.account, `/accounts/${accountId}/cfd_tunnel/${args.tunnel_id}/configurations`);
        return ok(resp.result);
      }

      case 'cf_tunnel_config_put': {
        const accountId = await resolveAccountId(args.account, args.account_id);
        const config = { ingress: args.ingress };
        if (args.warp_routing) config['warp-routing'] = args.warp_routing;
        const resp = await cfFetch(args.account, `/accounts/${accountId}/cfd_tunnel/${args.tunnel_id}/configurations`, {
          method: 'PUT',
          body: { config },
        });
        return ok(resp.result);
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
