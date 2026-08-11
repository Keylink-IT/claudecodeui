#!/usr/bin/env node
/**
 * KITDEV003 MCP server — exposes Hyper-V VM management on KITDEV003
 * (Windows Server + Hyper-V, office) as tools for Claude. All PowerShell
 * cmdlets run over SSH via Tailscale: Claude container → Tailscale mesh →
 * KITDEV003 OpenSSH Server → PowerShell.
 *
 * SSH config: relies on a "Host kitdev003" block in /home/node/.ssh/config.
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

const SSH_HOST = process.env.KITDEV003_SSH_HOST || 'kitdev003';
const SSH_TIMEOUT_DEFAULT = parseInt(process.env.KITDEV003_SSH_TIMEOUT || '60', 10);

const server = new Server(
  { name: 'lab-kitdev003', version: '0.1.0' },
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
  return spawnOnce(cmd, args, { timeoutSeconds });
}

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
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------- tool registry --------------------------------------------------

const tools = [
  {
    name: 'kitdev003_get_host_info',
    description: 'Return KITDEV003 Hyper-V host details: hostname, OS, total memory, logical processor count, virtualization extensions, etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitdev003_list_vms',
    description: 'List all Hyper-V VMs on KITDEV003 with name, state, assigned memory, vCPU count, uptime, and IP addresses.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitdev003_get_vm',
    description: 'Get full detail on a single VM on KITDEV003 including network adapters, integration services, and configured generation.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'VM name (Get-VM -Name argument)' } },
    },
  },
  {
    name: 'kitdev003_list_vswitches',
    description: 'List Hyper-V virtual switches on KITDEV003.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kitdev003_list_checkpoints',
    description: 'List checkpoints (snapshots) for a VM on KITDEV003, in chronological order.',
    inputSchema: {
      type: 'object',
      required: ['vm_name'],
      properties: { vm_name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_start_vm',
    description: 'Power on a VM on KITDEV003 (Start-VM). No-op if already running.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_stop_vm',
    description: 'Gracefully shut down a VM on KITDEV003 via Hyper-V Integration Services (Stop-VM).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_turn_off_vm',
    description: '⚠ Hard power-cut a VM on KITDEV003 (Stop-VM -TurnOff). Use only when graceful stop fails.',
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
    name: 'kitdev003_save_vm',
    description: 'Suspend a VM to disk on KITDEV003 (Save-VM). Resume with kitdev003_start_vm.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_pause_vm',
    description: 'Pause a VM on KITDEV003 (Suspend-VM). CPU is halted; use kitdev003_resume_vm to continue.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_resume_vm',
    description: 'Resume a paused VM on KITDEV003 (Resume-VM).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_restart_vm',
    description: 'Restart a VM on KITDEV003 (Restart-VM). Graceful by default.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        force: { type: 'boolean', default: false, description: 'If true, hard-restart (-Force).' },
      },
    },
  },
  {
    name: 'kitdev003_checkpoint_vm',
    description: 'Take a Hyper-V checkpoint (snapshot) of a VM on KITDEV003.',
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
    name: 'kitdev003_restore_checkpoint',
    description: '⚠ Restore a VM on KITDEV003 to a previous checkpoint. Discards state since the checkpoint. Always confirm with the user.',
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
    name: 'kitdev003_remove_checkpoint',
    description: 'Delete a checkpoint on KITDEV003. Hyper-V merges the differencing disk back into the parent VHD.',
    inputSchema: {
      type: 'object',
      required: ['vm_name', 'snapshot_name'],
      properties: {
        vm_name: { type: 'string' },
        snapshot_name: { type: 'string' },
      },
    },
  },
  {
    name: 'kitdev003_create_vm',
    description: 'Create a new Hyper-V VM on KITDEV003. Discover valid switch names with kitdev003_list_vswitches first.',
    inputSchema: {
      type: 'object',
      required: ['name', 'memory_mb', 'vhd_path', 'vhd_size_gb', 'vswitch'],
      properties: {
        name: { type: 'string' },
        generation: { type: 'integer', enum: [1, 2], default: 2 },
        memory_mb: { type: 'integer', description: 'Startup memory in MB' },
        vcpu_count: { type: 'integer', default: 2 },
        vhd_path: { type: 'string', description: 'Full Windows path to the new .vhdx' },
        vhd_size_gb: { type: 'integer', description: 'Maximum dynamic VHDX size in GB' },
        vswitch: { type: 'string', description: 'Name of the virtual switch' },
        boot_iso_path: { type: 'string', description: 'Optional Windows path to an .iso to mount as boot DVD' },
      },
    },
  },
  {
    name: 'kitdev003_destroy_vm',
    description: '⚠ PERMANENTLY destroy a VM on KITDEV003 (Remove-VM). Irreversible. Always confirm with the user.',
    inputSchema: {
      type: 'object',
      required: ['name', 'confirm'],
      properties: {
        name: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        delete_vhd: { type: 'boolean', default: false, description: 'If true, also delete the VHD files.' },
      },
    },
  },
  {
    name: 'kitdev003_rename_vm',
    description: 'Rename a VM on KITDEV003 (Rename-VM). Underlying VHD filenames are NOT renamed.',
    inputSchema: {
      type: 'object',
      required: ['old_name', 'new_name'],
      properties: { old_name: { type: 'string' }, new_name: { type: 'string' } },
    },
  },
  {
    name: 'kitdev003_run_in_vm',
    description: 'Run a PowerShell script inside a guest VM on KITDEV003 via Hyper-V Integration Services (Invoke-Command -VMName).',
    inputSchema: {
      type: 'object',
      required: ['vm_name', 'script', 'guest_username', 'guest_password_vault_item'],
      properties: {
        vm_name: { type: 'string' },
        script: { type: 'string' },
        guest_username: { type: 'string' },
        guest_password_vault_item: { type: 'string', description: 'Bitwarden vault item name whose password field holds the guest password.' },
      },
    },
  },
  {
    name: 'kitdev003_run_powershell',
    description: 'Run an arbitrary PowerShell command on KITDEV003 (NOT inside a guest). Escape hatch when no specific tool fits.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        json: { type: 'boolean', default: false, description: 'If true, pipe through ConvertTo-Json.' },
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
    case 'kitdev003_get_host_info':
      return runPS('Get-VMHost | Select-Object ComputerName, LogicalProcessorCount, MemoryCapacity, VirtualMachinePath, VirtualHardDiskPath, IovSupport, MacAddressMinimum, MacAddressMaximum');

    case 'kitdev003_list_vms':
      return runPS('Get-VM | Select-Object Name, State, MemoryAssigned, ProcessorCount, Uptime, @{n="IPAddresses";e={$_.NetworkAdapters.IPAddresses -join ","}}');

    case 'kitdev003_get_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State, Generation, MemoryAssigned, MemoryStartup, ProcessorCount, Uptime, AutomaticStartAction, AutomaticStopAction, @{n="NetworkAdapters";e={$_.NetworkAdapters | Select-Object Name, SwitchName, MacAddress, @{n="IP";e={$_.IPAddresses -join ","}}}}, @{n="HardDrives";e={$_.HardDrives | Select-Object Path, ControllerType, ControllerNumber, ControllerLocation}}`);

    case 'kitdev003_list_vswitches':
      return runPS('Get-VMSwitch | Select-Object Name, SwitchType, NetAdapterInterfaceDescription, AllowManagementOS');

    case 'kitdev003_list_checkpoints':
      if (!args.vm_name) return errorResult('vm_name is required');
      return runPS(`Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object Name, SnapshotType, CreationTime, ParentSnapshotName`);

    case 'kitdev003_start_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Start-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_stop_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Stop-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_turn_off_vm':
      if (!args.name) return errorResult('name is required');
      if (args.confirm !== true) return errorResult('turn_off requires confirm=true. Confirm with the user first.');
      return runPS(`Stop-VM -Name ${quotePS(args.name)} -TurnOff -Force; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_save_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Save-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_pause_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Suspend-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_resume_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Resume-VM -Name ${quotePS(args.name)}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_restart_vm':
      if (!args.name) return errorResult('name is required');
      return runPS(`Restart-VM -Name ${quotePS(args.name)} ${args.force ? '-Force' : ''}; Get-VM -Name ${quotePS(args.name)} | Select-Object Name, State`);

    case 'kitdev003_checkpoint_vm': {
      if (!args.vm_name) return errorResult('vm_name is required');
      const snap = args.snapshot_name || `${args.vm_name}-$(Get-Date -Format yyyy-MM-dd-HHmm)`;
      return runPS(`Checkpoint-VM -Name ${quotePS(args.vm_name)} -SnapshotName ${quotePS(snap)}; Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object -Last 1 Name, SnapshotType, CreationTime`);
    }

    case 'kitdev003_restore_checkpoint':
      if (!args.vm_name || !args.snapshot_name) return errorResult('vm_name and snapshot_name are required');
      if (args.confirm !== true) return errorResult('restore_checkpoint requires confirm=true. Confirm with the user first.');
      return runPS(`Restore-VMSnapshot -VMName ${quotePS(args.vm_name)} -Name ${quotePS(args.snapshot_name)} -Confirm:$false; Get-VM -Name ${quotePS(args.vm_name)} | Select-Object Name, State`);

    case 'kitdev003_remove_checkpoint':
      if (!args.vm_name || !args.snapshot_name) return errorResult('vm_name and snapshot_name are required');
      return runPS(`Remove-VMSnapshot -VMName ${quotePS(args.vm_name)} -Name ${quotePS(args.snapshot_name)} -Confirm:$false; Get-VMSnapshot -VMName ${quotePS(args.vm_name)} | Select-Object Name, CreationTime`);

    case 'kitdev003_create_vm': {
      const { name: vmName, generation = 2, memory_mb, vcpu_count = 2, vhd_path, vhd_size_gb, vswitch, boot_iso_path } = args;
      if (!vmName || !memory_mb || !vhd_path || !vhd_size_gb || !vswitch) {
        return errorResult('name, memory_mb, vhd_path, vhd_size_gb, and vswitch are required');
      }
      const lines = [
        `$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${quotePS(vhd_path)})`,
        `New-VHD -Path ${quotePS(vhd_path)} -SizeBytes ${vhd_size_gb}GB -Dynamic | Out-Null`,
        `New-VM -Name ${quotePS(vmName)} -Generation ${generation} -MemoryStartupBytes ${memory_mb}MB -VHDPath ${quotePS(vhd_path)} -SwitchName ${quotePS(vswitch)} | Out-Null`,
        `Set-VMProcessor -VMName ${quotePS(vmName)} -Count ${vcpu_count}`,
      ];
      if (boot_iso_path) {
        lines.push(`Add-VMDvdDrive -VMName ${quotePS(vmName)} -Path ${quotePS(boot_iso_path)}`);
        if (generation === 2) {
          lines.push(`$dvd = Get-VMDvdDrive -VMName ${quotePS(vmName)}; Set-VMFirmware -VMName ${quotePS(vmName)} -FirstBootDevice $dvd`);
        }
      }
      lines.push(`Get-VM -Name ${quotePS(vmName)} | Select-Object Name, State, Generation, MemoryAssigned, ProcessorCount`);
      return runPS(lines.join('; '));
    }

    case 'kitdev003_destroy_vm': {
      const { name: vmName, confirm, delete_vhd = false } = args;
      if (!vmName) return errorResult('name is required');
      if (confirm !== true) return errorResult('destroy_vm requires confirm=true. Confirm with the user first.');
      const lines = [
        `$vm = Get-VM -Name ${quotePS(vmName)}`,
        `if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }`,
      ];
      if (delete_vhd) {
        lines.push(`$paths = $vm.HardDrives.Path`, `Remove-VM -VM $vm -Force`, `$paths | ForEach-Object { if (Test-Path $_) { Remove-Item -Force $_ } }`);
      } else {
        lines.push(`Remove-VM -VM $vm -Force`);
      }
      lines.push(`Write-Output "destroyed VM ${vmName} (delete_vhd=${delete_vhd})"`);
      return runPS(lines.join('; '), { json: false });
    }

    case 'kitdev003_rename_vm':
      if (!args.old_name || !args.new_name) return errorResult('old_name and new_name are required');
      return runPS(`Rename-VM -Name ${quotePS(args.old_name)} -NewName ${quotePS(args.new_name)}; Get-VM -Name ${quotePS(args.new_name)} | Select-Object Name, State`);

    case 'kitdev003_run_in_vm': {
      const { vm_name, script, guest_username, guest_password_vault_item } = args;
      if (!vm_name || !script || !guest_username || !guest_password_vault_item) {
        return errorResult('vm_name, script, guest_username, and guest_password_vault_item are all required');
      }
      const ps = [
        `$pwText = bw get password ${quotePS(guest_password_vault_item)} 2>$null`,
        `if (-not $pwText) { Write-Error "vault item not found or bw not unlocked"; exit 2 }`,
        `$securePw = ConvertTo-SecureString -String $pwText -AsPlainText -Force`,
        `$cred = New-Object System.Management.Automation.PSCredential(${quotePS(guest_username)}, $securePw)`,
        `Invoke-Command -VMName ${quotePS(vm_name)} -Credential $cred -ScriptBlock { ${script} }`,
      ].join('; ');
      return runPS(ps, { json: false, timeoutSeconds: 120 });
    }

    case 'kitdev003_run_powershell': {
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
