Submit the saved PRD to the Forge pipeline by pushing it to the `keylink-studio/forge-prds` Gitea repo.

1. Read `.taskmaster/docs/prd.md`. If it doesn't exist, tell the user to run `/save-prd` first.
2. Determine a sensible filename slug from the project context (use the workspace directory name).
3. POST the PRD to the local Forge endpoint:

   ```bash
   curl -sS -X POST http://localhost:3001/api/forge/submit \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $CLOUDCLI_AUTH_TOKEN" \
     -d "$(jq -n --arg name "<slug>" --arg content "$(cat .taskmaster/docs/prd.md)" '{fileName: $name, content: $content}')"
   ```

   The auth token is the same one the browser session is using. If `CLOUDCLI_AUTH_TOKEN` isn't set in the environment, ask the user to set it (it's in their browser's localStorage as `auth-token`) — or run the curl from inside the cloudcli container where the request can come from `localhost` without auth.
4. The response includes `repoUrl` and `fileUrl`. Show those to the user so they can click through.
