Save the current PRD draft to `.taskmaster/docs/prd.md` so it can be picked up by task-master and downstream Forge tooling.

1. Assemble the complete PRD markdown from our conversation so far, using the 19-section format from your system prompt (CLAUDE.md). Include all sections that have content; for sections that haven't been discussed, write `_(not yet discussed)_` rather than padding with filler.
2. Write the markdown to `.taskmaster/docs/prd.md`. Overwrite if it already exists — this command is the "commit current state" gesture.
3. After saving, briefly summarize what's in the file (which sections are filled, which are still open) so the user knows what they have.
