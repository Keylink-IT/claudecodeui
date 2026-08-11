#!/usr/bin/env node
/**
 * KITVM3 MCP server — exposes Hyper-V VM management on the office Hyper-V
 * host (KITVM3) as tools for Claude. All PowerShell cmdlets run over SSH
 * via Cloudflare Tunnel: lab droplet → cloudflared edge → KITVM3 cloudflared
 * service → localhost:22 → OpenSSH Server → PowerShell as default shell.
 *
 * Tools:
 *   kitvm3_get_host_info, kitvm3_list_vms, kitvm3_get_vm,
 *   kitvm3_list_vswitches, kitvm3_list_checkpoints,
 *   kitvm3_start_vm, kitvm3_stop_vm, kitvm3_turn_off_vm, kitvm3_save_vm,
 *   kitvm3_pause_vm, kitvm3_resume_vm, kitvm3_restart_vm,
 *   kitvm3_checkpoint_vm, kitvm3_restore_checkpoint, kitvm3_remove_checkpoint,
 *   kitvm3_create_vm, kitvm3_destroy_vm, kitvm3_rename_vm,
 *   kitvm3_run_in_vm, kitvm3_run_powershell
 *
 * SSH config: relies on a "Host kitvm3" block in /home/node/.ssh/config that
 * sets HostName, User, IdentityFile, ProxyCommand (cloudflared access ssh),
 * and BatchMode. Set up via the data/ssh/ bind mount on the droplet.
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

const SSH_HOST = process.env.KITVM3_SSH_HOST || 'kitvm3';
const SSH_TIMEOUT_DEFAULT = parseInt(process.env.KITVM3_SSH_TIMEOUT || '60', 10);

const server = new Server(
  { name: 'lab-kitvm3', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- helpers --------------------------------------------------------

function spawnOnce(cmd, args, { timeoutSeconds }) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        stderr += `\n[killed by timeout after ${timeoutSeconds}s]`;
      }, timeoutSeconds * 1000);
    }
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

async function execProcess(cmd, args, { timeoutSeconds = SSH_TIMEOUT_DEFAULT } = {}) {
  // Cold-start retry. The first ssh through cloudflared from a fresh process
  // can take 20-40s to establish the edge connection, well beyond ssh's
  // ConnectTimeout. Retry once on the specific banner-timeout failure.
  // Subsequent calls hit a warm cloudflared connection and finish in <2s.
  let result = await spawnOnce(cmd, args, { timeoutSeconds });
  const isBannerTimeout = result.code !== 0 && result.stderr.includes('banner exchange');
  if (isBannerTimeout && cmd === 'ssh') {
    process.stderr.write('[lab-kitvm3] cold cloudflared connection timed out, retrying once...\n');
    result = await spawnOnce(cmd, args, { timeoutSeconds });
  }
  return result;
}

/**
 * Run a PowerShell command on KITVM3 over SSH. Wraps with `| ConvertTo-Json
 * -Depth N -Compress` when json=true so the response is parseable structured
 * data. Cmdlets that already return strings (Format-Table output, etc.) skip
 * the wrapping with json=false.
 */
async function runPS(psCommand, { json = true, jsonDepth = 4, timeoutSeconds } = {}) {
  const wrapped = json
    ? `${psCommand} | ConvertTo-Json -Depth ${jsonDepth} -Compress`
    : psCommand;

  const result = await execProcess('ssh', [SSH_HOST, wrapped], { timeoutSeconds });

  if (result.code !== 0) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `ssh ${SSH_HOST} exited ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      }],
    };
  }

  return {
    content: [{ type: 'text', text: result.stdout || '(empty output)' }],
  };
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function quotePS(s) {
  // Single-quote a PowerShell literal; escape embedded single quotes by doubling.
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------- tool registry --------------------------------------------------

const tools = [
  // ---- read ----
  {
    name: 'kitvm3_get_host_info',
    description: 'Return KITVM3 Hyper-V host details: hostname, OS, total memory, logical processor count, virtualization extensions, etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitvm3_list_vms',
    description: 'List all Hyper-V VMs on KITVM3 with name, state, assigned memory, vCPU count, uptime, and IP addresses (if Integration Services are reporting).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitvm3_get_vm',
    description: 'Get full detail on a single VM including network adapters, integration services, automatic start/stop actions, and configured generation.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'VM name (Get-VM -Name argument)' } },
    },
  },
  {
    name: 'kitvm3_list_vswitches',
    description: 'List Hyper-V virtual switches on KITVM3. Use the Name field when calling kitvm3_create_vm.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitvm3_list_checkpoints',
    description: 'List checkpoints (snapshots) for a VM, in chronological order.',
    inputSchema: {
      type: 'object',
      required: ['vm_name'],
      properties: { vm_name: { type: 'string' } },
    },
  },

  // ---- power ----
  {
    name: 'kitvm3_start_vm',
    description: 'Power on a VM (Start-VM). No-op if already running.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitvm3_stop_vm',
    description: 'Gracefully shut down a VM via Hyper-V Integration Services (Stop-VM). Requires Integration Services running in the guest.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitvm3_turn_off_vm',
    description: '⚠ Hard power-cut a VM (Stop-VM -TurnOff). Equivalent to pulling the plug — guest doesn\'t get a chance to flush. Use only when graceful stop fails.',
    inputSchema: {
      type: 'object',
      required: ['name', 'confirm'],
      properties: {
        name: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true. Confirm with the user first.' },
      },
    },
  },
  {
    name: 'kitvm3_save_vm',
    description: 'Suspend a VM to disk (Save-VM). State is preserved; resume with kitvm3_start_vm.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitvm3_pause_vm',
    description: 'Pause a VM (Suspend-VM). VM remains in memory; CPU is halted. Use kitvm3_resume_vm to continue.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitvm3_resume_vm',
    description: 'Resume a paused VM (Resume-VM).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitvm3_restart_vm',
    description: 'Restart a VM (Restart-VM). Graceful by default.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        force: { type: 'boolean', default: false, description: 'If true, hard-restart (-Force).' },
      },
    },
  },

  // ---- snapshots ----
  {
    name: 'kitvm3_checkpoint_vm',
    description: 'Take a Hyper-V checkpoint (snapshot) of a VM. Captures current state including memory.',
    inputSchema: {
      type: 'object',
      required: ['vm_name'],
      properties: {
        vm_name: { type: 'string' },
        snapshot_name: { type: 'string', description: 'Optional name; defaults to "<vm_name>-YYYY-MM-DD-HHMM"' },
      },
    },
  },
  {
    name: 'kitvm3_restore_checkpoint',
    description: '⚠ Restore a VM to a previous checkpoint. Discards any state changes since the checkpoint. Irreversible without another checkpoint to roll back to. Always confirm with the user.',
    inputSchema: {
      type: 'object',
      required: ['vm_name', 'snapshot_name', 'confirm'],
      properties: {
        vm_name: { type: 'string' },
        snapshot_name: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true.' },
      },
    },
  },
  {
    name: 'kitvm3_remove_checkpoint',
    description: 'Delete a checkpoint. Hyper-V merges the differencing disk back into the parent VHD (can take a while for large VMs).',
    inputSchema: {
      type: 'object',
      required: ['vm_name', 'snapshot_name'],
      properties: {
        vm_name: { type: 'string' },
        snapshot_name: { type: 'string' },
      },
    },
  },

  // ---- lifecycle ----
  {
    name: 'kitvm3_create_vm',
    description: 'Create a new Hyper-V VM. Discover valid switch names with kitvm3_list_vswitches first. The new VHD is dynamic by default.',
    inputSchema: {
      type: 'object',
      required: ['name', 'memory_mb', 'vhd_path', 'vhd_size_gb', 'vswitch'],
      properties: {
        name: { type: 'string', description: 'VM name (also becomes the directory name under the Hyper-V root)' },
        generation: { type: 'integer', enum: [1, 2], default: 2, description: 'Gen 2 supports UEFI + Secure Boot, required for modern Linux + Windows Server 2016+' },
        memory_mb: { type: 'integer', description: 'Startup memory in MB (e.g., 4096 for 4 GB)' },
        vcpu_count: { type: 'integer', default: 2 },
        vhd_path: { type: 'string', description: 'Full Windows path to the new .vhdx (e.g., "D:\\\\HyperV\\\\new-vm\\\\disk.vhdx")' },
        vhd_size_gb: { type: 'integer', description: 'Maximum dynamic VHDX size in GB' },
        vswitch: { type: 'string', description: 'Name of the virtual switch (from kitvm3_list_vswitches)' },
        boot_iso_path: { type: 'string', description: 'Optional Windows path to an .iso to mount as boot DVD' },
      },
    },
  },
  {
    name: 'kitvm3_destroy_vm',
    description: '⚠ PERMANENTLY destroy a VM (Remove-VM). The VM config is deleted. Optionally also deletes the VHD file. Irreversible. Always confirm with the user.',
    inputSchema: {
      type: 'object',
      required: ['name', 'confirm'],
      properties: {
        name: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        delete_vhd: { type: 'boolean', default: false, description: 'If true, also rm -rf the VM\'s VHD files. Doubly irreversible.' },
      },
    },
  },
  {
    name: 'kitvm3_rename_vm',
    description: 'Rename a VM in Hyper-V (Rename-VM). The underlying directory and VHD filenames are NOT renamed (Hyper-V limitation).',
    inputSchema: {
      type: 'object',
      required: ['old_name', 'new_name'],
      properties: {
        old_name: { type: 'string' },
        new_name: { type: 'string' },
      },
    },
  },

  // ---- run inside guest ----
  {
    name: 'kitvm3_run_in_vm',
    description: 'Run a PowerShell script inside a guest VM via Hyper-V Integration Services (Invoke-Command -VMName). Works without network if Integration Services are running. Returns guest stdout/stderr/exit_code.',
    inputSchema: {
      type: 'object',
      required: ['vm_name', 'script', 'guest_username', 'guest_password_vault_item'],
      properties: {
        vm_name: { type: 'string', description: 'Hyper-V VM name (NOT the guest hostname)' },
        script: { type: 'string', description: 'PowerShell script to run inside the guest' },
        guest_username: { type: 'string', description: 'Guest OS username (e.g., "Administrator" or "DOMAIN\\\\user")' },
        guest_password_vault_item: { type: 'string', description: 'Name of the Bitwarden vault item whose password field holds the guest password. Looked up via `bw get password` on KITVM3 — KITVM3 must have bw installed and unlocked. If KITVM3 doesn\'t have bw, this tool can\'t run.' },
      },
    },
  },

  // ---- escape hatch ----
  {
    name: 'kitvm3_run_powershell',
    description: 'Run an arbitrary PowerShell command on KITVM3 (NOT inside a guest). Use when no specific tool fits. Returns stdout as text.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'PowerShell command. Use multi-line with `n separators if needed.' },
        json: { type: 'boolean', default: false, description: 'If true, wrap output with `| ConvertTo-Json -Depth 4 -Compress`.' },
        timeout_seconds: { type: 'number', default: 60 },
      },
    },
  },
];

// ---------- request handlers ----------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  switch (name) {
    case 'kitvm3_get_host_info':
      return runPS('Get-VMHost | Select-Object ComputerName, LogicalProcessorCount, MemoryCapacity, VirtualMachinePath, VirtualHardDiskPath, IovSupport, MacAddressMinimum, MacAddressMaximum');

    case 'kitvm3_list_vms':
      return runPS('Get-VM | Select-Object Name, State, MemoryAssigned, ProcessorCount, Uptime, @{n="IPAddresses";e={$_.NetworkAdapters.IPAddresses -join ","}}');

    case 'kitvm3_get_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State, Generation, MemoryAssigned, MemoryStartup, ProcessorCount, Uptime, AutomaticStartAction, AutomaticStopAction, @{n="NetworkAdapters";e={$_.NetworkAdapters | Select-Object Name, SwitchName, MacAddress, @{n="IP";e={$_.IPAddresses -join ","}}}}, @{n="HardDrives";e={$_.HardDrives | Select-Object Path, ControllerType, ControllerNumber, ControllerLocation}}`);

    case 'kitvm3_list_vswitches':
      return runPS('Get-VMSwitch | Select-Object Name, SwitchType, NetAdapterInterfaceDescription, AllowManagementOS');

    case 'kitvm3_list_checkpoints':
      if (!args.vm_name) return errorResult('vm_name is required');
      return runPS(`Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object Name, SnapshotType, CreationTime, ParentSnapshotName`);

    case 'kitvm3_start_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Start-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_stop_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Stop-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_turn_off_vm':
      if (!args.name) return errorResult('name is required');
      if (args.confirm !== true) return errorResult('turn_off requires confirm=true. Confirm with the user first.');
      return runPS(`Stop-VM -Name ${quotePS(args.name)} -TurnOff -Force; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_save_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Save-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_pause_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Suspend-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_resume_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Resume-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_restart_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Restart-VM -Name ${quotePS(args.name)} ${args.force ? '-Force' : ''}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitvm3_checkpoint_vm': {
      if (!args.vm_name) return errorResult('vm_name is required');
      const snap = args.snapshot_name || `${args.vm_name}-$(Get-Date -Format yyyy-MM-dd-HHmm)`;
      return runPS(`Checkpoint-VM -Name ${quotePS(args.vm_name)} -SnapshotName ${quotePS(snap)}; Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object -Last 1 Name, SnapshotType, CreationTime`);
    }

    case 'kitvm3_restore_checkpoint':
      if (!args.vm_name || !args.snapshot_name) return errorResult('vm_name and snapshot_name are required');
      if (args.confirm !== true) return errorResult('restore_checkpoint requires confirm=true. Confirm with the user first.');
      return runPS(`Restore-VMSnapshot -VMName ${quotePS(args.vm_name)} -Name ${quotePS(args.snapshot_name)} -Confirm:$false; Get-VM -Name ${quotePS(args.vm_name)} | Select-Object Name, State`);

    case 'kitvm3_remove_checkpoint':
      if (!args.vm_name || !args.snapshot_name) return errorResult('vm_name and snapshot_name are required');
      return runPS(`Remove-VMSnapshot -VMName ${quotePS(args.vm_name)} -Name ${quotePS(args.snapshot_name)} -Confirm:$false; Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object Name, CreationTime`);

    case 'kitvm3_create_vm': {
      const { name: vmName, generation = 2, memory_mb, vcpu_count = 2, vhd_path, vhd_size_gb, vswitch, boot_iso_path } = args;
      if (!vmName || !memory_mb || !vhd_path || !vhd_size_gb || !vswitch) {
        return errorResult('name, memory_mb, vhd_path, vhd_size_gb, and vswitch are required');
      }
      const memoryBytes = `${memory_mb}MB`;
      const vhdSizeBytes = `${vhd_size_gb}GB`;
      const lines = [
        `$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${quotePS(vhd_path)})`,
        `New-VHD -Path ${quotePS(vhd_path)} -SizeBytes ${vhdSizeBytes} -Dynamic | Out-Null`,
        `New-VM -Name ${quotePS(vmName)} -Generation ${generation} -MemoryStartupBytes ${memoryBytes} -VHDPath ${quotePS(vhd_path)} -SwitchName ${quotePS(vswitch)} | Out-Null`,
        `Set-VMProcessor -VMName ${quotePS(vmName)} -Count ${vcpu_count}`,
      ];
      if (boot_iso_path) {
        lines.push(`Add-VMDvdDrive -VMName ${quotePS(vmName)} -Path ${quotePS(boot_iso_path)}`);
        if (generation === 2) {
          // For Gen2 boot from DVD, set the DVD as first boot device
          lines.push(`$dvd = Get-VMDvdDrive -VMName ${quotePS(vmName)}; Set-VMFirmware -VMName ${quotePS(vmName)} -FirstBootDevice $dvd`);
        }
      }
      lines.push(`Get-VM -Name ${quotePS(vmName)} | Select-Object Name, State, Generation, MemoryAssigned, ProcessorCount`);
      return runPS(lines.join('; '));
    }

    case 'kitvm3_destroy_vm': {
      const { name: vmName, confirm, delete_vhd = false } = args;
      if (!vmName) return errorResult('name is required');
      if (confirm !== true) return errorResult('destroy_vm requires confirm=true. Confirm with the user first.');
      const lines = [
        `$vm = Get-VM -Name ${quotePS(vmName)}`,
        `if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }`,
      ];
      if (delete_vhd) {
        lines.push(`$paths = $vm.HardDrives.Path`);
        lines.push(`Remove-VM -VM $vm -Force`);
        lines.push(`$paths | ForEach-Object { if (Test-Path $_) { Remove-Item -Force $_ } }`);
      } else {
        lines.push(`Remove-VM -VM $vm -Force`);
      }
      lines.push(`Write-Output "destroyed VM ${vmName} (delete_vhd=${delete_vhd})"`);
      return runPS(lines.join('; '), { json: false });
    }

    case 'kitvm3_rename_vm':
      if (!args.old_name || !args.new_name) return errorResult('old_name and new_name are required');
      return runPS(`Rename-VM -Name ${quotePS(args.old_name)} -NewName ${quotePS(args.new_name)}; Get-VM -Name ${quotePS(args.new_name)} | Select-Object Name, State`);

    case 'kitvm3_run_in_vm': {
      const { vm_name, script, guest_username, guest_password_vault_item } = args;
      if (!vm_name || !script || !guest_username || !guest_password_vault_item) {
        return errorResult('vm_name, script, guest_username, and guest_password_vault_item are all required');
      }
      // Resolve guest password from a vault item on KITVM3 (KITVM3 must have bw configured).
      // The PowerShell script that runs on KITVM3 fetches the password, builds a credential,
      // then Invoke-Command -VMName the script INSIDE the guest.
      const escapedScript = script.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '\\"');
      const ps = [
        `$pwText = bw get password ${quotePS(guest_password_vault_item)} 2>$null`,
        `if (-not $pwText) { Write-Error "vault item not found or bw not unlocked"; exit 2 }`,
        `$securePw = ConvertTo-SecureString -String $pwText -AsPlainText -Force`,
        `$cred = New-Object System.Management.Automation.PSCredential(${quotePS(guest_username)}, $securePw)`,
        `Invoke-Command -VMName ${quotePS(vm_name)} -Credential $cred -ScriptBlock { ${script} }`,
      ].join('; ');
      return runPS(ps, { json: false, timeoutSeconds: 120 });
    }

    case 'kitvm3_run_powershell': {
      const { command, json: useJson = false, timeout_seconds = 60 } = args;
      if (!command) return errorResult('command is required');
      return runPS(command, { json: useJson, timeoutSeconds: timeout_seconds });
    }

    default:
      return errorResult(`unknown tool: ${name}`);
  }
});

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
