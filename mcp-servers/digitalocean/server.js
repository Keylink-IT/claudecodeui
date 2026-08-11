#!/usr/bin/env node
/**
 * DigitalOcean MCP server — exposes droplet management as tools for Claude.
 *
 * Wraps doctl (the official DO CLI) over JSON output. doctl handles auth via
 * the DIGITALOCEAN_ACCESS_TOKEN env var — no per-call token plumbing.
 *
 * Tools:
 *   do_account_info, do_list_regions, do_list_sizes, do_list_images,
 *   do_list_ssh_keys, do_list_droplets, do_get_droplet, do_create_droplet,
 *   do_droplet_action, do_destroy_droplet, do_ssh_command
 *
 * Designed for the lab.keylinkit cloudcli container. Registered as user-scope
 * MCP server by /usr/local/bin/claude-init.sh on every container start.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';

// SSH key path used by do_ssh_command. Bind-mounted from the host's
// ./data/ssh/. Default is id_ed25519 (the droplet's outgoing key set up
// during initial provisioning); override with DO_SSH_KEY_PATH env var if
// a different key is registered with the target droplets.
const SSH_KEY_PATH = process.env.DO_SSH_KEY_PATH || '/home/node/.ssh/id_ed25519';

const server = new Server(
  { name: 'lab-do', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- helpers --------------------------------------------------------

function execProcess(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}` });
    });
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

async function execDoctl(args) {
  if (!process.env.DIGITALOCEAN_ACCESS_TOKEN) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: 'DIGITALOCEAN_ACCESS_TOKEN env var is not set. Container init should populate it from the vault item "DigitalOcean API Token", or it can be set via .env on the droplet.',
      }],
    };
  }
  const result = await execProcess('doctl', args);
  if (result.code !== 0) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `doctl exited ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      }],
    };
  }
  return {
    content: [{ type: 'text', text: result.stdout || '(empty output)' }],
  };
}

async function resolveDropletIp(dropletRef) {
  // Accept either numeric ID or name. Returns the public IPv4.
  const lookup = await execDoctl(['compute', 'droplet', 'get', dropletRef, '-o', 'json']);
  if (lookup.isError) return null;
  try {
    const data = JSON.parse(lookup.content[0].text);
    const droplet = Array.isArray(data) ? data[0] : data;
    const v4 = droplet?.networks?.v4 || [];
    const pub = v4.find((n) => n.type === 'public');
    return pub?.ip_address || null;
  } catch {
    return null;
  }
}

// ---------- tool registry --------------------------------------------------

const tools = [
  {
    name: 'do_account_info',
    description: 'Return the DigitalOcean account record: email, status, droplet limit, etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'do_list_regions',
    description: 'List available DO regions. Use the slug field (e.g. "nyc2") when calling do_create_droplet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'do_list_sizes',
    description: 'List available droplet sizes. Use the slug field (e.g. "s-2vcpu-4gb") when calling do_create_droplet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'do_list_images',
    description: 'List available distribution images. Use the slug field (e.g. "ubuntu-24-04-x64") when calling do_create_droplet.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['distribution', 'application', 'all'],
          default: 'distribution',
          description: 'distribution = base OS images (Ubuntu, Debian, etc.), application = preconfigured stacks (LAMP, Node, etc.), all = both',
        },
      },
    },
  },
  {
    name: 'do_list_ssh_keys',
    description: 'List SSH keys registered on the DO account. Use the fingerprint field when calling do_create_droplet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'do_list_droplets',
    description: 'List all droplets in the account. Returns name, id, status, region, size, public IP, tags, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional: filter to droplets with this tag' },
      },
    },
  },
  {
    name: 'do_get_droplet',
    description: 'Get full detail on a single droplet by name or numeric ID.',
    inputSchema: {
      type: 'object',
      required: ['droplet'],
      properties: {
        droplet: { type: 'string', description: 'Droplet name or numeric ID' },
      },
    },
  },
  {
    name: 'do_create_droplet',
    description: 'Create a new droplet. Returns the new droplet record once ready (waits for provisioning). Use do_list_regions/sizes/images/ssh_keys first to discover valid slugs.',
    inputSchema: {
      type: 'object',
      required: ['name', 'region', 'size', 'image'],
      properties: {
        name: { type: 'string', description: 'Hostname for the droplet (e.g. "lab-test-1")' },
        region: { type: 'string', description: 'Region slug (e.g. "nyc2")' },
        size: { type: 'string', description: 'Size slug (e.g. "s-2vcpu-4gb")' },
        image: { type: 'string', description: 'Image slug (e.g. "ubuntu-24-04-x64")' },
        ssh_keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'SSH key fingerprints or numeric IDs (use do_list_ssh_keys to discover). At least one is strongly recommended; without it the droplet auto-generates a root password emailed to the account owner.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply (e.g. ["managed-by-cloudcli"])',
        },
        user_data: {
          type: 'string',
          description: 'Optional cloud-init user-data script to run at first boot',
        },
      },
    },
  },
  {
    name: 'do_droplet_action',
    description: 'Perform a power/snapshot action on a droplet. Use carefully on live droplets.',
    inputSchema: {
      type: 'object',
      required: ['droplet', 'action'],
      properties: {
        droplet: { type: 'string', description: 'Droplet name or numeric ID' },
        action: {
          type: 'string',
          enum: ['power_on', 'power_off', 'reboot', 'shutdown', 'snapshot'],
          description: 'power_off is a hard cutoff; shutdown is a graceful ACPI request',
        },
        snapshot_name: { type: 'string', description: 'Required when action=snapshot' },
      },
    },
  },
  {
    name: 'do_destroy_droplet',
    description: '⚠ PERMANENTLY destroy a droplet. Irreversible. Always confirm with the user before calling. Pass confirm=true to actually proceed; without it the call is rejected.',
    inputSchema: {
      type: 'object',
      required: ['droplet', 'confirm'],
      properties: {
        droplet: { type: 'string', description: 'Droplet name or numeric ID' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually destroy. Use after explicit user confirmation.',
        },
      },
    },
  },
  {
    name: 'do_ssh_command',
    description: 'Run a non-interactive command via SSH on a droplet. Returns stdout, stderr, and exit code as JSON. Uses the lab\'s SSH key (mounted from the host).',
    inputSchema: {
      type: 'object',
      required: ['droplet', 'command'],
      properties: {
        droplet: { type: 'string', description: 'Droplet name or numeric ID' },
        command: { type: 'string', description: 'Shell command to run on the remote' },
        user: { type: 'string', default: 'root', description: 'SSH user (defaults to root)' },
        timeout_seconds: { type: 'number', default: 30, description: 'Kill the SSH session if the command runs longer than this' },
      },
    },
  },
];

// ---------- request handlers ----------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  switch (name) {
    case 'do_account_info':
      return execDoctl(['account', 'get', '-o', 'json']);

    case 'do_list_regions':
      return execDoctl(['compute', 'region', 'list', '-o', 'json']);

    case 'do_list_sizes':
      return execDoctl(['compute', 'size', 'list', '-o', 'json']);

    case 'do_list_images': {
      const filter = args.type || 'distribution';
      const flag = filter === 'distribution' ? ['--public'] : filter === 'application' ? ['--application'] : [];
      return execDoctl(['compute', 'image', 'list', ...flag, '-o', 'json']);
    }

    case 'do_list_ssh_keys':
      return execDoctl(['compute', 'ssh-key', 'list', '-o', 'json']);

    case 'do_list_droplets': {
      const tagArgs = args.tag ? ['--tag-name', args.tag] : [];
      return execDoctl(['compute', 'droplet', 'list', ...tagArgs, '-o', 'json']);
    }

    case 'do_get_droplet':
      if (!args.droplet) return errorResult('droplet (name or ID) is required');
      return execDoctl(['compute', 'droplet', 'get', args.droplet, '-o', 'json']);

    case 'do_create_droplet': {
      const { name: dropletName, region, size, image, ssh_keys, tags, user_data } = args;
      if (!dropletName || !region || !size || !image) {
        return errorResult('name, region, size, and image are all required');
      }
      const cmd = [
        'compute', 'droplet', 'create', dropletName,
        '--region', region,
        '--size', size,
        '--image', image,
        '--wait',
        '-o', 'json',
      ];
      if (Array.isArray(ssh_keys) && ssh_keys.length) cmd.push('--ssh-keys', ssh_keys.join(','));
      if (Array.isArray(tags) && tags.length) cmd.push('--tag-names', tags.join(','));
      if (user_data) cmd.push('--user-data', user_data);
      return execDoctl(cmd);
    }

    case 'do_droplet_action': {
      const { droplet, action, snapshot_name } = args;
      if (!droplet || !action) return errorResult('droplet and action are required');
      const map = {
        power_on: ['compute', 'droplet-action', 'power-on', droplet, '--wait', '-o', 'json'],
        power_off: ['compute', 'droplet-action', 'power-off', droplet, '--wait', '-o', 'json'],
        reboot: ['compute', 'droplet-action', 'reboot', droplet, '--wait', '-o', 'json'],
        shutdown: ['compute', 'droplet-action', 'shutdown', droplet, '--wait', '-o', 'json'],
        snapshot: ['compute', 'droplet-action', 'snapshot', droplet, '--snapshot-name', snapshot_name || `${droplet}-${new Date().toISOString().slice(0, 10)}`, '--wait', '-o', 'json'],
      };
      const cmd = map[action];
      if (!cmd) return errorResult(`unknown action: ${action}`);
      return execDoctl(cmd);
    }

    case 'do_destroy_droplet': {
      const { droplet, confirm } = args;
      if (!droplet) return errorResult('droplet (name or ID) is required');
      if (confirm !== true) {
        return errorResult('destroy requires explicit confirm=true. Confirm with the user first.');
      }
      return execDoctl(['compute', 'droplet', 'delete', droplet, '--force', '-o', 'json']);
    }

    case 'do_ssh_command': {
      const { droplet, command, user = 'root', timeout_seconds = 30 } = args;
      if (!droplet || !command) return errorResult('droplet and command are required');
      const ip = await resolveDropletIp(droplet);
      if (!ip) return errorResult(`could not resolve a public IP for droplet "${droplet}"`);

      const sshArgs = [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${Math.min(timeout_seconds, 15)}`,
        '-o', 'LogLevel=ERROR',
        `${user}@${ip}`,
        '--',
        command,
      ];

      const result = await execProcess('timeout', [String(timeout_seconds), 'ssh', ...sshArgs]);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            droplet, ip, user, command,
            exit_code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2),
        }],
      };
    }

    default:
      return errorResult(`unknown tool: ${name}`);
  }
});

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
