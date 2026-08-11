#!/usr/bin/env node
/**
 * lab-wp — MCP server for WordPress fleet management across kitwebhost3 /
 * kitwebhost4 via wp-cli over SSH.
 *
 * Auth model (per design 2026-08-07): SSH as root using the root password from
 * Vaultwarden ("Kitwebhost3" / "Kitwebhost4"). wp-cli itself NEVER runs as
 * root — each command is discovered-owner'd and executed via
 * `su -s /bin/bash - <owner>` so file ownership stays correct on the cPanel
 * account. Connection is over the public hostname (container is not a mesh node).
 *
 * Tools: wp_list_sites, wp_core_check_update, wp_core_update, wp_plugin_list,
 *   wp_plugin_update, wp_theme_update, wp_user_list, wp_reset_password,
 *   wp_fix_permissions, wp_run
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSH_HELPER = path.join(__dirname, 'ssh_exec.py');

// Dedicated root key (primary auth), password fallback. See whm/server.js notes.
const SSH_KEY_PATH = process.env.WHM_SSH_KEY || '/home/node/.ssh/kitwebhost_root_ed25519';

// Two routes per server (public host first, then headscale mesh IP). Password
// fallback comes from the "Kitwebhost3" vault item (working root pw for both).
const SERVERS = {
  kw3: { hosts: ['kitwebhost3.com', '100.64.0.17'], vaultItem: 'Kitwebhost3', meshIp: '100.64.0.17', label: 'kitwebhost3' },
  kw4: { hosts: ['kitwebhost4.com', '100.64.0.18'], vaultItem: 'Kitwebhost3', meshIp: '100.64.0.18', label: 'kitwebhost4' },
};

const passwordCache = new Map();
const server = new Server({ name: 'lab-wp', version: '0.1.0' }, { capabilities: { tools: {} } });

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
  if (!s) throw new Error(`unknown server "${slug}". Valid: ${Object.keys(SERVERS).join(', ')} (use wp_list_servers-equivalent: kw3 / kw4).`);
  return s;
}

// Best-effort — key is primary auth, so a locked vault must not block access.
async function resolvePassword(slug) {
  if (passwordCache.has(slug)) return passwordCache.get(slug);
  if (!process.env.BW_SESSION) return '';
  const { vaultItem } = requireServer(slug);
  const r = await execProcess('bw', ['get', 'password', vaultItem], { timeoutSeconds: 30 });
  const pw = r.code === 0 ? r.stdout : '';
  passwordCache.set(slug, pw);
  return pw;
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

async function sshExec(slug, script, { timeout = 60 } = {}) {
  const s = requireServer(slug);
  const password = await resolvePassword(slug);
  const remote = `echo ${b64(script)}|base64 -d|bash`;
  const env = { ...process.env, SSH_HOSTS: s.hosts.join(','), SSH_USER: 'root', SSH_PORT: '22', SSH_KEY: SSH_KEY_PATH, SSH_PASSWORD: password, SSH_COMMAND: remote, SSH_TIMEOUT: String(timeout) };
  const r = await execProcess('python3', [SSH_HELPER], { timeoutSeconds: timeout + 10, env });
  try { return JSON.parse(r.stdout); }
  catch { return { exit_code: r.code, stdout: r.stdout, stderr: r.stderr || 'ssh helper produced no JSON' }; }
}

// Run a wp-cli subcommand against a specific install, AS the install's owner.
// `wpArgs` is a pre-tokenized array; dynamic values are q()-quoted here.
async function wpCli(slug, sitePath, wpArgs, { timeout = 120 } = {}) {
  const p = q(sitePath);
  const inner = `wp --path=${p} ${wpArgs.join(' ')}`;
  const script = [
    `p=${p}`,
    `cf="$p/wp-config.php"`,
    `owner=$(stat -c %U "$cf" 2>/dev/null || stat -c %U "$p" 2>/dev/null)`,
    `[ -n "$owner" ] || { echo "ERR: cannot determine owner for $p"; exit 3; }`,
    `su -s /bin/bash - "$owner" -c "echo ${b64(inner)}|base64 -d|bash"`,
  ].join('\n');
  return sshExec(slug, script, { timeout });
}

function ok(content) { return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] }; }
function errorResult(message) { return { isError: true, content: [{ type: 'text', text: message }] }; }
function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

const tools = [
  { name: 'wp_list_sites', description: 'Discover WordPress installs on a server by scanning /home for wp-config.php. Returns owner + docroot for each. Set include_version=true to also report core version (slower — runs wp-cli per site).', inputSchema: { type: 'object', required: ['server'], properties: { server: { type: 'string', description: 'kw3 or kw4' }, include_version: { type: 'boolean', default: false } } } },
  { name: 'wp_core_check_update', description: 'Check for available WordPress core updates for one install (wp core check-update).', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string', description: 'absolute docroot, e.g. /home/user/public_html' } } } },
  { name: 'wp_core_update', description: 'Update WordPress core for one install (wp core update). Optionally pin a version.', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' }, version: { type: 'string', description: 'optional exact version, e.g. 6.9.5' } } } },
  { name: 'wp_plugin_list', description: 'List plugins for one install with status and update availability (wp plugin list).', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' }, update_only: { type: 'boolean', description: 'only return plugins with updates available', default: false } } } },
  { name: 'wp_plugin_update', description: 'Update a plugin (or all plugins) for one install (wp plugin update).', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' }, plugin: { type: 'string', description: 'plugin slug, or omit / use "all" to update everything' } } } },
  { name: 'wp_theme_update', description: 'Update a theme (or all themes) for one install (wp theme update).', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' }, theme: { type: 'string', description: 'theme slug, or omit / use "all"' } } } },
  { name: 'wp_user_list', description: 'List WordPress users for one install (wp user list).', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'wp_reset_password', description: 'Set a new password for a WordPress user (wp user update --user_pass).', inputSchema: { type: 'object', required: ['server', 'path', 'user', 'password'], properties: { server: { type: 'string' }, path: { type: 'string' }, user: { type: 'string', description: 'WP username, email, or ID' }, password: { type: 'string' } } } },
  { name: 'wp_fix_permissions', description: 'Harden filesystem permissions for one WordPress install: chown to the site owner, directories 755, files 644, and wp-config.php 600. Runs as root.', inputSchema: { type: 'object', required: ['server', 'path'], properties: { server: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'wp_run', description: 'Run an arbitrary wp-cli subcommand against one install, executed as the site owner. Provide everything after "wp" (e.g. "cache flush" or "option get siteurl"). Guard: pass confirm=true for destructive verbs (db drop/reset, site empty, plugin delete).', inputSchema: { type: 'object', required: ['server', 'path', 'command'], properties: { server: { type: 'string' }, path: { type: 'string' }, command: { type: 'string', description: 'wp-cli args after "wp", e.g. "plugin status akismet"' }, confirm: { type: 'boolean' }, timeout_seconds: { type: 'number', default: 120 } } } },
];

const WP_DANGER = /\b(db\s+(drop|reset|clean)|site\s+empty|plugin\s+delete|theme\s+delete|user\s+delete|db\s+query)\b/;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    switch (name) {
      case 'wp_list_sites': {
        const withVer = a.include_version === true;
        const script = withVer
          ? [
              `find /home -mindepth 2 -maxdepth 6 -name wp-config.php 2>/dev/null | while read cf; do`,
              `  d=$(dirname "$cf"); o=$(stat -c %U "$cf");`,
              `  v=$(su -s /bin/bash - "$o" -c "wp --path=\\"$d\\" core version 2>/dev/null" 2>/dev/null);`,
              `  printf '%s\\t%s\\t%s\\n' "$o" "$d" "$v";`,
              `done`,
            ].join('\n')
          : [
              `find /home -mindepth 2 -maxdepth 6 -name wp-config.php 2>/dev/null | while read cf; do`,
              `  printf '%s\\t%s\\n' "$(stat -c %U "$cf")" "$(dirname "$cf")";`,
              `done`,
            ].join('\n');
        const res = await sshExec(a.server, script, { timeout: withVer ? 600 : 90 });
        const sites = (res.stdout || '').split('\n').filter(Boolean).map((line) => {
          const [owner, docroot, version] = line.split('\t');
          return withVer ? { owner, path: docroot, version: version || 'unknown' } : { owner, path: docroot };
        });
        return ok({ server: a.server, count: sites.length, sites });
      }

      case 'wp_core_check_update': {
        const res = await wpCli(a.server, a.path, ['core', 'check-update', '--format=json']);
        return ok(tryJson(res.stdout) ?? res);
      }

      case 'wp_core_update': {
        const args = ['core', 'update'];
        if (a.version) args.push(`--version=${q(a.version)}`);
        return ok(await wpCli(a.server, a.path, args, { timeout: 300 }));
      }

      case 'wp_plugin_list': {
        const res = await wpCli(a.server, a.path, ['plugin', 'list', '--format=json']);
        const list = tryJson(res.stdout);
        if (!list) return ok(res);
        return ok(a.update_only ? list.filter((p) => p.update === 'available') : list);
      }

      case 'wp_plugin_update': {
        const target = !a.plugin || a.plugin === 'all' ? '--all' : q(a.plugin);
        return ok(await wpCli(a.server, a.path, ['plugin', 'update', target, '--format=summary'], { timeout: 300 }));
      }

      case 'wp_theme_update': {
        const target = !a.theme || a.theme === 'all' ? '--all' : q(a.theme);
        return ok(await wpCli(a.server, a.path, ['theme', 'update', target, '--format=summary'], { timeout: 300 }));
      }

      case 'wp_user_list': {
        const res = await wpCli(a.server, a.path, ['user', 'list', '--format=json']);
        return ok(tryJson(res.stdout) ?? res);
      }

      case 'wp_reset_password':
        return ok(await wpCli(a.server, a.path, ['user', 'update', q(a.user), `--user_pass=${q(a.password)}`]));

      case 'wp_fix_permissions': {
        const p = q(a.path);
        const script = [
          `p=${p}`,
          `[ -f "$p/wp-config.php" ] || { echo "not a WordPress docroot: $p"; exit 2; }`,
          `owner=$(stat -c %U "$p/wp-config.php")`,
          `chown -R "$owner":"$owner" "$p"`,
          `find "$p" -type d -exec chmod 755 {} +`,
          `find "$p" -type f -exec chmod 644 {} +`,
          `chmod 600 "$p/wp-config.php"`,
          `echo "hardened $p owner=$owner (dirs 755, files 644, wp-config 600)"`,
        ].join('\n');
        return ok(await sshExec(a.server, script, { timeout: 180 }));
      }

      case 'wp_run': {
        if (!a.command) return errorResult('command is required');
        if (WP_DANGER.test(a.command) && a.confirm !== true) return errorResult('wp command looks destructive; re-call with confirm=true to proceed.');
        return ok(await wpCli(a.server, a.path, [a.command], { timeout: a.timeout_seconds || 120 }));
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
