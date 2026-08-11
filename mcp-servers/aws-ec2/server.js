#!/usr/bin/env node
/**
 * AWS EC2 MCP server — exposes EC2 instance discovery as tools for Claude.
 *
 * Wraps the `aws` CLI (already in the image). Single-account: AWS access key
 * lives in one Vaultwarden item, `aws-creds-prod`, in the CloudCLI Tools
 * collection:
 *   - Username: AWS_ACCESS_KEY_ID
 *   - Password: AWS_SECRET_ACCESS_KEY
 *   - Notes:    (optional) default region as the first line, e.g. "us-east-1"
 *
 * Discovery-only by design. AI sessions doing actual SSH/work on an EC2
 * instance use the per-project SSH key (stored at the project root,
 * gitignored — see .lab/environments.json convention).
 *
 * Tools:
 *   ec2_list_regions               — list EC2-enabled regions
 *   ec2_list_instances(region?, state?) — describe-instances in one region
 *   ec2_get_instance(instance_id, region?) — full record for one instance
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

const VAULT_ITEM = process.env.AWS_CREDS_VAULT_ITEM || 'aws-creds-prod';
const FALLBACK_REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';

// In-process credential cache (per Claude session — server is spawned per
// session via stdio). Restart the session to refresh.
let credsCache = null; // { access_key_id, secret_access_key, default_region }

const server = new Server(
  { name: 'lab-aws-ec2', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- shell helper --------------------------------------------------

function execProcess(cmd, args, { timeoutSeconds = 30, env = process.env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

// ---------- credential resolution -----------------------------------------

async function resolveCreds() {
  if (credsCache) return credsCache;
  if (!process.env.BW_SESSION) {
    throw new Error('BW_SESSION not set — Vaultwarden CLI is not unlocked. Check `docker logs lab-cloudcli` for [bw-init].');
  }

  const itemResult = await execProcess('bw', ['get', 'item', VAULT_ITEM], { timeoutSeconds: 30 });
  if (itemResult.code !== 0 || !itemResult.stdout) {
    throw new Error(`vault item "${VAULT_ITEM}" not found: ${itemResult.stderr || 'no output'}`);
  }
  let item;
  try { item = JSON.parse(itemResult.stdout); } catch (err) {
    throw new Error(`vault item "${VAULT_ITEM}" did not return JSON: ${err.message}`);
  }
  const login = item.login || {};
  const access_key_id = login.username;
  const secret_access_key = login.password;
  if (!access_key_id || !secret_access_key) {
    throw new Error(`vault item "${VAULT_ITEM}" missing username (AWS_ACCESS_KEY_ID) or password (AWS_SECRET_ACCESS_KEY).`);
  }
  // Region: first line of notes if set, else env fallback, else us-east-1.
  let default_region = FALLBACK_REGION;
  if (item.notes && item.notes.trim()) {
    const firstLine = item.notes.split(/\r?\n/)[0].trim();
    if (/^[a-z]{2}-[a-z]+-\d$/.test(firstLine)) default_region = firstLine;
  }
  credsCache = { access_key_id, secret_access_key, default_region };
  return credsCache;
}

async function awsCli(args, { region } = {}) {
  const creds = await resolveCreds();
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.access_key_id,
    AWS_SECRET_ACCESS_KEY: creds.secret_access_key,
    AWS_DEFAULT_REGION: region || creds.default_region,
    AWS_REGION: region || creds.default_region,
    // Quiet the pager and force JSON for parseable output.
    AWS_PAGER: '',
  };
  const result = await execProcess('aws', [...args, '--output', 'json'], { env, timeoutSeconds: 60 });
  if (result.code !== 0) {
    throw new Error(`aws ${args.join(' ')} failed: ${result.stderr || `exit ${result.code}`}`);
  }
  if (!result.stdout) return null;
  try { return JSON.parse(result.stdout); } catch (err) {
    throw new Error(`aws ${args[0]} returned non-JSON: ${err.message}`);
  }
}

// ---------- shape helpers -------------------------------------------------

function summarizeInstance(inst, region) {
  // describe-instances returns deeply nested records — flatten to the fields
  // an AI session actually wants when picking + connecting to an instance.
  const tags = Array.isArray(inst.Tags) ? inst.Tags : [];
  const nameTag = tags.find((t) => t.Key === 'Name');
  return {
    instance_id: inst.InstanceId,
    name: nameTag ? nameTag.Value : null,
    state: inst.State?.Name,
    instance_type: inst.InstanceType,
    region,
    availability_zone: inst.Placement?.AvailabilityZone,
    public_ip: inst.PublicIpAddress || null,
    private_ip: inst.PrivateIpAddress || null,
    public_dns: inst.PublicDnsName || null,
    key_name: inst.KeyName || null,
    image_id: inst.ImageId,
    launch_time: inst.LaunchTime,
    vpc_id: inst.VpcId,
    subnet_id: inst.SubnetId,
    security_groups: (inst.SecurityGroups || []).map((g) => ({ id: g.GroupId, name: g.GroupName })),
    tags: Object.fromEntries(tags.map((t) => [t.Key, t.Value])),
  };
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
    name: 'ec2_list_regions',
    description: 'List EC2-enabled AWS regions on the account. Useful when looking for instances across regions (each ec2_list_instances call is single-region).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ec2_list_instances',
    description: 'List EC2 instances in a single AWS region. Returns a compact per-instance summary (instance_id, Name tag, state, IPs, key_name, region, etc.) suitable for picking the right one to assign to a project environment.',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'AWS region (e.g. "us-east-1"). Defaults to the value in the vault item notes, or AWS_DEFAULT_REGION env, or us-east-1.' },
        state: {
          type: 'string',
          description: 'Optional: filter by instance state — pending, running, shutting-down, terminated, stopping, stopped.',
        },
        name: { type: 'string', description: 'Optional: filter by Name tag (exact match, case-sensitive).' },
      },
    },
  },
  {
    name: 'ec2_get_instance',
    description: 'Get full detail on a single EC2 instance by instance_id. Returns the same shape as ec2_list_instances but for one instance.',
    inputSchema: {
      type: 'object',
      required: ['instance_id'],
      properties: {
        instance_id: { type: 'string', description: 'EC2 instance ID (e.g. "i-0abc123...")' },
        region: { type: 'string', description: 'AWS region the instance lives in. Defaults to the vault-configured default region.' },
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
      case 'ec2_list_regions': {
        const data = await awsCli(['ec2', 'describe-regions']);
        const regions = (data?.Regions || []).map((r) => ({
          name: r.RegionName,
          endpoint: r.Endpoint,
          opt_in_status: r.OptInStatus,
        }));
        return ok({ regions, count: regions.length });
      }

      case 'ec2_list_instances': {
        const region = args.region || (await resolveCreds()).default_region;
        const cliArgs = ['ec2', 'describe-instances'];
        const filters = [];
        if (args.state) filters.push(`Name=instance-state-name,Values=${args.state}`);
        if (args.name) filters.push(`Name=tag:Name,Values=${args.name}`);
        if (filters.length) {
          cliArgs.push('--filters', ...filters);
        }
        const data = await awsCli(cliArgs, { region });
        const reservations = data?.Reservations || [];
        const instances = reservations.flatMap((r) => r.Instances || []).map((i) => summarizeInstance(i, region));
        return ok(instances);
      }

      case 'ec2_get_instance': {
        if (!args.instance_id) return errorResult('instance_id is required');
        const region = args.region || (await resolveCreds()).default_region;
        const data = await awsCli(['ec2', 'describe-instances', '--instance-ids', args.instance_id], { region });
        const inst = data?.Reservations?.[0]?.Instances?.[0];
        if (!inst) return errorResult(`instance ${args.instance_id} not found in region ${region}`);
        return ok(summarizeInstance(inst, region));
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
