Generate a task breakdown from the saved PRD using the task-master MCP tools.

1. Read `.taskmaster/docs/prd.md`. If the file doesn't exist, tell the user to run `/save-prd` first.
2. Call the task-master `parse_prd` MCP tool with the PRD content. The tool will produce a structured task list.
3. Save the result to `.taskmaster/tasks/tasks.json` in task-master's expected format (`{ master: { tasks: [...] } }`).
4. Show the user the generated tasks: count, top-level structure, any tasks marked high-priority. Ask if they want to refine before pushing to Console.

If task-master's `parse_prd` tool isn't available in this session, fall back to generating the task structure yourself by reading the PRD and producing a JSON file with this shape:

```json
{
  "master": {
    "tasks": [
      { "id": 1, "title": "...", "description": "...", "status": "pending", "priority": "high", "dependencies": [] }
    ]
  }
}
```

Use sequential IDs starting at 1, derive titles from PRD sections (one task per major requirement), set `status` to `pending` and `priority` based on the PRD's P0/P1/P2 markings (P0 → high, P1 → medium, P2 → low).
