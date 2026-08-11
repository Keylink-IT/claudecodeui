Push the generated tasks to the Console Projects API ([console.keylinkit.com](https://console.keylinkit.com)) so they land on the linked project's task board.

The cloudcli server proxies this — it pulls the Console API token from Vaultwarden and POSTs to Console with a Bearer header. You shell out to `curl` against the local cloudcli proxy; nothing fancier is needed.

## Steps

1. **Read `.lab/console-project.json`.** This is the link captured during the project creation wizard.
   - If missing or empty → tell the user: *"This project isn't linked to a Console board yet. Run the project-creation wizard's Console step, or create the file manually with `{ \"id\": \"<console-project-id>\", \"name\": \"...\", \"linked_at\": \"...\" }`."* Then stop.
   - If present, capture `id` (Console project id) and `name`.

2. **Read `.taskmaster/tasks/tasks.json`.** If missing → tell the user to run `/generate-tasks` first.
   - The file uses task-master's shape: `{ master: { tasks: [...] } }`. Extract the `tasks` array.

3. **Decide replace vs upsert.**
   - **Default: `replace: false`** (upsert by id, append new). This preserves any in-Console edits (e.g., status moves a teammate made) when re-pushing after a PRD edit.
   - If the user explicitly says "replace" / "wipe" / "rewrite from scratch" / passes a `--replace` flag, use `replace: true`. Confirm before doing this — it deletes any tasks the team moved on the board.

4. **Confirm with the user before pushing.** Show:
   - Console project name + id
   - Number of tasks being pushed
   - replace mode (false=upsert, true=wipe-and-replace)
   - Then ask "Push now?" Wait for explicit OK.

5. **POST via the cloudcli proxy.** Run from Bash:
   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $(cat ~/.cloudcli/auth-token 2>/dev/null || echo '$AUTH_TOKEN')" \
     -H 'Content-Type: application/json' \
     -d "$(jq -c --argjson tasks "$(jq '.master.tasks' .taskmaster/tasks/tasks.json)" \
            --arg replace "false" \
            '{tasks: $tasks, source: "cloudcli-task-master", replace: ($replace == "true")}' <<< '{}')" \
     "http://localhost:3001/api/console/projects/<id>/tasks"
   ```
   (Substitute the project id from step 1, flip `--arg replace "true"` if needed.)

6. **Surface the response.** A successful push returns `{ "created": N, "updated": N, "deleted": N }`. Tell the user the counts and link them to the board: `https://console.keylinkit.com/projects/<id>` (or whatever Console's deep-link convention is — adjust if you know it).

## Edge cases

- **`tasks.json` exists but the array is empty**: tell the user there's nothing to push; suggest running `/generate-tasks` to populate.
- **Proxy returns 401/403**: the cloudcli auth token expired. Refresh the browser session and retry — the slash command runs in the same authenticated context as the chat.
- **Proxy returns 502/connection failed**: Console may be down or the Vaultwarden token couldn't be resolved. Suggest the user check `docker logs lab-cloudcli` for `[bw-init]` lines.
- **`X-Cloudcli-Unknown-Statuses` response header**: cloudcli's status translation didn't recognize one or more task statuses. They got mapped to `backlog` as a fallback. Show the user which statuses were unknown so they can fix the source.

## What gets translated server-side (don't worry about it here)

cloudcli's `/api/console/projects/:id/tasks` proxy translates task-master status enums to Console board columns:
- `pending` → `backlog`
- `in_progress` → `in_progress`
- `done` → `done`
- `deferred` → `backlog`
- `blocked` → `review`

Priority (`high`/`medium`/`low`) passes through unchanged.
