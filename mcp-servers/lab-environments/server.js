#!/usr/bin/env node
/**
 * lab-environments MCP server — read/write per-project production +
 * development environment assignments. The state file lives at
 * <project_path>/.lab/environments.json so assignments travel with the
 * project's git repo. The cloudcli UI's header pills read the same file
 * via the /api/lab/projects/:name/environments routes.
 *
 * Each slot (production / development) is a polymorphic record discriminated
 * by `kind`. Supported kinds:
 *   do_droplet      — DigitalOcean droplet (use lab-do for discovery)
 *   kitvm3_vm       — Hyper-V VM on KITVM3 (use lab-kitvm3 for discovery)
 *   inmotion_cpanel — Inmotion WHM/cPanel account (use lab-inmotion)
 *   ec2_instance    — AWS EC2 instance (use lab-aws-ec2)
 *
 * Tools:
 *   lab_get_environments(project_path)
 *   lab_set_production(project_path, droplet_id, droplet_name, region?, ip?)
 *   lab_set_development(project_path, vm_name, state?)
 *   lab_set_production_inmotion / lab_set_development_inmotion
 *   lab_set_production_ec2      / lab_set_development_ec2
 *   lab_clear_environment(project_path, slot)
 *
 * Each typed setter takes the core identification fields plus an optional
 * `extras` object holding richer docs (services, urls, deploy_notes) for
 * AI sessions reading .lab/environments.json. Discovery of available
 * resources is delegated to the per-provider MCPs.
 *
 * Designed for the lab.keylinkit cloudcli container. Auto-registered by
 * /usr/local/bin/claude-init.sh on every container start.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENV_DIR = '.lab';
const ENV_FILE = 'environments.json';
const VALID_KINDS = new Set(['do_droplet', 'kitvm3_vm', 'inmotion_cpanel', 'ec2_instance']);

const server = new Server(
  { name: 'lab-environments', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

// ---------- helpers --------------------------------------------------------

function envFilePath(projectPath) {
  return path.join(projectPath, ENV_DIR, ENV_FILE);
}

async function ensureProjectPath(projectPath) {
  const stat = await fs.stat(projectPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`project_path "${projectPath}" does not exist or is not a directory`);
  }
}

async function readEnvironments(projectPath) {
  const filePath = envFilePath(projectPath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      production: backfillKind(parsed.production, 'production'),
      development: backfillKind(parsed.development, 'development'),
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { production: null, development: null };
    throw err;
  }
}

// Backward compat: pre-2026-05-13 environments.json entries didn't carry a
// `kind` discriminator (the field was added when we expanded beyond DO+VM).
// Infer it from the shape on read; new writes always set it explicitly.
function backfillKind(entry, slot) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.kind) return entry;
  if (slot === 'production' && (entry.id != null || entry.droplet_id != null)) {
    return { kind: 'do_droplet', ...entry };
  }
  if (slot === 'development' && entry.name) {
    return { kind: 'kitvm3_vm', ...entry };
  }
  return entry;
}

async function writeEnvironments(projectPath, envs) {
  const dir = path.join(projectPath, ENV_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ENV_FILE),
    JSON.stringify(envs, null, 2) + '\n',
    'utf-8',
  );
}

function mergeExtras(extras) {
  if (!extras || typeof extras !== 'object') return {};
  const out = {};
  if (Array.isArray(extras.services)) out.services = extras.services;
  if (extras.urls && typeof extras.urls === 'object') out.urls = extras.urls;
  if (typeof extras.deploy_notes === 'string') out.deploy_notes = extras.deploy_notes;
  return out;
}

function ok(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// ---------- tools ----------------------------------------------------------

// Reusable schema fragment for the optional `extras` object that enriches
// any environment entry with services / URLs / deploy notes. Used by every
// typed setter so the shape is consistent across kinds.
const extrasSchema = {
  type: 'object',
  description: 'Optional rich documentation that AI sessions read alongside the connection fields. Use this to capture how to deploy, what services run, and what URLs the env serves.',
  properties: {
    services: {
      type: 'array',
      description: 'Services running on this environment (informational + actionable). Each item: { name, port?, restart? }.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Systemd unit / docker container / process name.' },
          port: { type: 'number', description: 'Optional: TCP port the service listens on.' },
          restart: { type: 'string', description: 'Optional: full shell command to restart it (e.g. "sudo systemctl restart keylink-web").' },
        },
      },
    },
    urls: {
      type: 'object',
      description: 'Public URLs this environment serves. Free-form keys (e.g. "production", "staging", "admin").',
      additionalProperties: { type: 'string' },
    },
    deploy_notes: { type: 'string', description: 'Short markdown notes describing how to deploy / quirks specific to this env.' },
  },
};

const tools = [
  {
    name: 'lab_get_environments',
    description: 'Read the production + development environment assignments for a project. Returns { production: { kind, ... } | null, development: { kind, ... } | null }. Missing or unconfigured projects return both as null. Legacy entries without `kind` are backfilled on read.',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root (the directory that contains or will contain .lab/environments.json). Use the user\'s current working directory if they\'re asking about "this project".',
        },
      },
    },
  },
  {
    name: 'lab_set_production',
    description: 'Assign a DigitalOcean droplet as the project\'s production environment (kind: "do_droplet"). The droplet must already exist; use do_list_droplets first to discover valid IDs and names.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'droplet_id', 'droplet_name'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        droplet_id: { type: 'integer', description: 'DigitalOcean droplet numeric ID (from do_list_droplets).' },
        droplet_name: { type: 'string', description: 'DigitalOcean droplet name (display label).' },
        region: { type: 'string', description: 'Optional: region slug like "nyc2" for richer UI display.' },
        ip: { type: 'string', description: 'Optional: public IPv4 for richer UI display.' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_set_development',
    description: 'Assign a KITVM3 Hyper-V VM as the project\'s development environment (kind: "kitvm3_vm"). The VM must already exist on KITVM3; use kitvm3_list_vms first to discover valid names.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'vm_name'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        vm_name: { type: 'string', description: 'Hyper-V VM name on KITVM3 (from kitvm3_list_vms).' },
        state: { type: 'integer', description: 'Optional: VM state integer for richer UI display (2 = Running, 3 = Off).' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_set_production_inmotion',
    description: 'Assign an Inmotion Hosting WHM/cPanel account as the project\'s production environment (kind: "inmotion_cpanel"). Use inmotion_list_servers + inmotion_list_accounts first to discover the right server slug + account.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'server', 'account'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        server: { type: 'string', description: 'WHM server slug (the vault item suffix, e.g. "whm01").' },
        account: { type: 'string', description: 'cPanel account username (e.g. "acmecorp").' },
        domain: { type: 'string', description: 'Optional: primary domain on the account.' },
        ip: { type: 'string', description: 'Optional: WHM server IP for display.' },
        home_path: { type: 'string', description: 'Optional: cPanel home directory. Defaults to "/home/<account>".' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_set_development_inmotion',
    description: 'Same as lab_set_production_inmotion but assigns to the development slot.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'server', 'account'],
      properties: {
        project_path: { type: 'string' },
        server: { type: 'string', description: 'WHM server slug.' },
        account: { type: 'string', description: 'cPanel account username.' },
        domain: { type: 'string' },
        ip: { type: 'string' },
        home_path: { type: 'string' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_set_production_ec2',
    description: 'Assign an AWS EC2 instance as the project\'s production environment (kind: "ec2_instance"). Use ec2_list_instances first to discover instance details. The ssh_key_path is a path RELATIVE to the project root (e.g. "./kitaws_openssh.pem"); the key file itself should live in the project and be gitignored.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'instance_id', 'region', 'public_ip', 'ssh_user', 'ssh_key_path'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        instance_id: { type: 'string', description: 'EC2 instance ID (e.g. "i-0abc123...").' },
        region: { type: 'string', description: 'AWS region (e.g. "us-east-1").' },
        public_ip: { type: 'string', description: 'Instance public IPv4.' },
        ssh_user: { type: 'string', description: 'Default SSH user for the AMI (e.g. "ubuntu", "ec2-user").' },
        ssh_key_path: { type: 'string', description: 'Path to the SSH private key, relative to the project root (gitignored). E.g. "./kitaws_openssh.pem".' },
        code_path: { type: 'string', description: 'Optional: where the project\'s code lives on the instance (e.g. "/home/ubuntu/myapp").' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_set_development_ec2',
    description: 'Same as lab_set_production_ec2 but assigns to the development slot.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'instance_id', 'region', 'public_ip', 'ssh_user', 'ssh_key_path'],
      properties: {
        project_path: { type: 'string' },
        instance_id: { type: 'string' },
        region: { type: 'string' },
        public_ip: { type: 'string' },
        ssh_user: { type: 'string' },
        ssh_key_path: { type: 'string' },
        code_path: { type: 'string' },
        extras: extrasSchema,
      },
    },
  },
  {
    name: 'lab_clear_environment',
    description: 'Clear an assignment for a project (set production or development back to null).',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'slot'],
      properties: {
        project_path: { type: 'string' },
        slot: { type: 'string', enum: ['production', 'development'] },
      },
    },
  },
];

// ---------- handlers -------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'lab_get_environments': {
        if (!args.project_path) return fail('project_path is required');
        await ensureProjectPath(args.project_path);
        const envs = await readEnvironments(args.project_path);
        return ok({ project_path: args.project_path, environments: envs });
      }

      case 'lab_set_production': {
        const { project_path, droplet_id, droplet_name, region, ip, extras } = args;
        if (!project_path || droplet_id == null || !droplet_name) {
          return fail('project_path, droplet_id, and droplet_name are required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs.production = {
          kind: 'do_droplet',
          id: Number(droplet_id),
          name: String(droplet_name),
          region: region ?? null,
          ip: ip ?? null,
          ...mergeExtras(extras),
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_set_development': {
        const { project_path, vm_name, state, extras } = args;
        if (!project_path || !vm_name) {
          return fail('project_path and vm_name are required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs.development = {
          kind: 'kitvm3_vm',
          name: String(vm_name),
          state: state ?? null,
          ...mergeExtras(extras),
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_set_production_inmotion':
      case 'lab_set_development_inmotion': {
        const slot = name === 'lab_set_production_inmotion' ? 'production' : 'development';
        const { project_path, server: whmServer, account, domain, ip, home_path, extras } = args;
        if (!project_path || !whmServer || !account) {
          return fail('project_path, server, and account are required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs[slot] = {
          kind: 'inmotion_cpanel',
          server: String(whmServer),
          account: String(account),
          domain: domain ?? null,
          ip: ip ?? null,
          home_path: home_path || `/home/${account}`,
          ...mergeExtras(extras),
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_set_production_ec2':
      case 'lab_set_development_ec2': {
        const slot = name === 'lab_set_production_ec2' ? 'production' : 'development';
        const { project_path, instance_id, region, public_ip, ssh_user, ssh_key_path, code_path, extras } = args;
        if (!project_path || !instance_id || !region || !public_ip || !ssh_user || !ssh_key_path) {
          return fail('project_path, instance_id, region, public_ip, ssh_user, and ssh_key_path are all required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs[slot] = {
          kind: 'ec2_instance',
          instance_id: String(instance_id),
          region: String(region),
          public_ip: String(public_ip),
          ssh_user: String(ssh_user),
          ssh_key_path: String(ssh_key_path),
          code_path: code_path || null,
          ...mergeExtras(extras),
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_clear_environment': {
        const { project_path, slot } = args;
        if (!project_path || !slot) return fail('project_path and slot are required');
        if (slot !== 'production' && slot !== 'development') {
          return fail("slot must be 'production' or 'development'");
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs[slot] = null;
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
