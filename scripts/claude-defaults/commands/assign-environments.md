Help the user assign **production** and **development** environments to the current project, persisting the choice to `<project_path>/.lab/environments.json` so the cloudcli UI's header pills reflect it and future sessions know which infra to target.

## What an environment can be

Each slot (production OR development) is one of four kinds, discriminated by the `kind` field in the JSON:

| Kind | Discovery MCP | Use for |
|---|---|---|
| `do_droplet` | `do_list_droplets` (lab-do) | DigitalOcean droplets — the lab itself + client SaaS deployments |
| `kitvm3_vm` | `kitvm3_list_vms` (lab-kitvm3) | Hyper-V VMs on the office KITVM3 box — typical dev env |
| `inmotion_cpanel` | `inmotion_list_servers` + `inmotion_list_accounts(server)` (lab-inmotion) | Inmotion Hosting WHM/cPanel accounts — managed shared-hosting clients |
| `ec2_instance` | `ec2_list_instances` (lab-aws-ec2) | AWS EC2 instances — single-account, multi-region |

Any kind can go in either slot. A "production = EC2 + development = Hyper-V VM" assignment is normal; "production = Inmotion cPanel + development = DO droplet" is also fine.

## Steps

1. **Resolve the project path.** If you don't already have it, run `pwd` via Bash. That's the `project_path` for every subsequent tool call.

2. **Read current state.** Call `lab_get_environments` with the project_path. Summarize what's already set; ask the user what they want to change (one slot or both).

3. **Ask which kind for the slot.** If it isn't obvious from the user's prompt ("use the droplet I just made" → do_droplet, "the EC2 instance" → ec2_instance, etc.), present the four kinds and ask.

4. **List candidates from the appropriate MCP** and let the user pick. Filter aggressively if the list is long — match on tags/names/IPs that look like they belong to this project.

5. **Confirm before writing.** Echo the assignment as a one-liner: "I'll assign **prod = ec2_instance · i-0abc123 · 34.235.38.234** (us-east-1, ssh as ubuntu)." Wait for explicit OK.

6. **Capture rich details when you have them.** Each setter accepts an optional `extras` object — populate it when the user gives you useful info (or you discover it on the host):
   - `services`: list of systemd units / containers + ports + restart commands
   - `urls`: production / staging / admin URLs
   - `deploy_notes`: free-form markdown describing the deploy process or quirks

   AI sessions reading `.lab/environments.json` later will use these to know how to operate in the env without re-discovering everything.

7. **Write the assignment.** Use the right setter for the kind:
   - `lab_set_production` / `lab_set_development` — for DO droplets / KITVM3 VMs (existing tools)
   - `lab_set_production_inmotion` / `lab_set_development_inmotion` — for Inmotion cPanel accounts
   - `lab_set_production_ec2` / `lab_set_development_ec2` — for EC2 instances

8. **Verify.** Call `lab_get_environments` again to confirm the file matches. Tell the user the header pills will reflect the change on next page load.

## Kind-specific tips

- **EC2** — `ssh_key_path` should be a **relative** path from the project root (e.g. `./kitaws_openssh.pem`). The actual `.pem` file lives in the project, **gitignored**. Tell the user to drop the key in the project root and add it to `.gitignore` before they share the repo.
- **Inmotion** — `account` is the cPanel username, `server` is the WHM slug (the vault item suffix, e.g. `whm01`). SSH access goes through the WHM server's root key (managed by lab-inmotion); AI sessions use `inmotion_ssh_command(server, command, account?)` rather than direct ssh.
- **DO droplet** — pass `region` and `ip` when known; the UI badge displays better.
- **Hyper-V VM** — `state` is the integer (2 = Running, 3 = Off). cosmetic only.

## When the user says "deploy to prod" or "ssh into dev" later

Read `lab_get_environments` first to find out the kind, then dispatch:
- `do_droplet` → `do_ssh_command` with the droplet name/id
- `kitvm3_vm` → `kitvm3_run_powershell` / `kitvm3_run_in_vm` with the VM name
- `inmotion_cpanel` → `inmotion_ssh_command(server, command, account)`
- `ec2_instance` → shell out to `ssh -i <ssh_key_path> <ssh_user>@<public_ip> "<command>"` via Bash (per-project key, no central MCP for SSH)

The user shouldn't need to repeat the assignment every session — that's the whole point of persisting it.

## Edge cases

- **`.lab/environments.json` doesn't exist yet**: `lab_get_environments` returns `{production: null, development: null}` — fine, proceed.
- **User wants to clear an assignment**: use `lab_clear_environment` with `slot=production` or `slot=development`.
- **User wants to assign infra that doesn't exist yet**: tell them to create it first (via `do_create_droplet`, `kitvm3_create_vm`, the AWS console, or WHM > Create Account), then re-run `/assign-environments`.
- **Legacy environments.json without `kind`**: the lab-environments MCP backfills `kind: "do_droplet"` (for production) or `kind: "kitvm3_vm"` (for development) on read, so older projects work seamlessly.
