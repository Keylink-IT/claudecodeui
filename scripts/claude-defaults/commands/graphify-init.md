Build a Graphify knowledge graph over the current project and register it as a project-scoped MCP server, so subsequent Claude sessions in this project can query the graph (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) instead of re-reading raw files.

## When to use

- Large codebases where Claude is repeatedly grepping/reading the same files.
- Cross-cutting questions ("what calls X?", "shortest path between auth and payments?") that get expensive in raw-file context.
- Mixed code + docs/papers/images projects where the LLM-extraction pass adds value beyond AST indexing.

Skip this for small projects — Read+Grep is faster than indexing for anything under a few hundred files.

## Steps

1. **Resolve the project root.** Run `pwd` via Bash. If the user is somewhere generic (`/home/node`, `/`), confirm the intended root before proceeding — graphify indexes everything below the path you give it, and the wrong root means a giant useless graph.

2. **Check for an existing graph.** If `./graphify-out/graph.json` already exists, ask whether to **rebuild** (full re-index) or **update** (`graphify --update .`, faster, captures recent changes only). Default to update if the user is ambivalent.

3. **Run the build.** From the project root:
   - First time: `graphify .`
   - Subsequent: `graphify --update .` (or `graphify .` if a full rebuild is wanted)

   Tree-sitter code extraction is local. Non-code content (docs, PDFs, images) is sent through whatever LLM the active Claude session has access to — no separate API key needed when run from inside cloudcli. Output lands in `./graphify-out/`.

4. **Register the MCP server (project scope).** Run:

   ```bash
   claude mcp add graphify --scope project -- python -m graphify.serve ./graphify-out/graph.json
   ```

   The registration goes into the project's `.mcp.json` so it travels with the repo. If the project is git-tracked, suggest the user commit `.mcp.json` (but NOT `graphify-out/` — that should typically be gitignored since it's regenerable and large).

5. **Confirm tools are live.** Run `claude mcp list` and verify `graphify ✓ Connected`. Tell the user:
   - The four query tools are now available in any chat from this project.
   - The HTML visualization is at `./graphify-out/graph.html` if they want to browse it.

6. **Suggest gitignore + post-commit hook (optional).** If the project is git-tracked, mention:
   - Add `graphify-out/` to `.gitignore` (regenerable, ~10s of MB).
   - `graphify hook install` writes a post-commit hook that re-indexes code on each commit (cheap — AST only, no LLM calls). Worth it for active projects.

## What NOT to do

- **Do NOT run `graphify claude install`.** It mutates `~/.claude/settings.json` with a PreToolUse hook and writes a section into CLAUDE.md. We register manually in step 4 to avoid those side effects. The lab's `~/.claude/` is a bind mount; surprising changes there leak to every future session.
- Don't register `graphify` at user scope. The server points at one fixed graph.json path, so user scope only makes sense if you have exactly one project. Project scope is right.

## Edge cases

- **Build fails on a file**: graphify's per-file errors are usually skippable. Check `graphify-out/GRAPH_REPORT.md` for what was indexed vs skipped before re-running.
- **`python -m graphify.serve` exits immediately**: typically means the path to `graph.json` is wrong (relative vs absolute) or the file doesn't exist. Confirm `ls graphify-out/graph.json` before debugging further.
- **Slow first build on a big repo**: expected — the LLM-extraction pass over docs is the long tail. Subsequent `--update` runs only hit changed files.
