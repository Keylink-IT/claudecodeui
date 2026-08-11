// Project-scoped slash commands scaffolded into "From PRD" projects. Lands at
// `<project>/.claude/commands/*.md` so Claude Code picks them up automatically.
// Each file's content is the prompt that gets sent to Claude when the user
// types the matching slash command in chat.
//
// Source of truth lives at <app>/scripts/claude-defaults/commands/*.md (also
// read by /usr/local/bin/claude-init.sh at container start to populate
// user-scope ~/.claude/commands/). Single source means the wizard scaffolder
// and the rehydrate-on-boot path can never drift.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The path from this module to <app>/scripts differs between running from
// source (server/templates → up 2) and the 1.33 compiled bundle
// (dist-server/server/templates → up 3). Probe the known candidates and fall
// back to the process CWD (the container WORKDIR is the app root). A missing
// dir is non-fatal: PRD projects are simply scaffolded without slash commands
// instead of crashing the server when this module is imported at boot.
const CANDIDATE_DIRS = [
  join(__dirname, '..', '..', 'scripts', 'claude-defaults', 'commands'),
  join(__dirname, '..', '..', '..', 'scripts', 'claude-defaults', 'commands'),
  join(process.cwd(), 'scripts', 'claude-defaults', 'commands'),
];

function loadSlashCommands() {
  const commandsDir = CANDIDATE_DIRS.find((candidate) => existsSync(candidate));
  if (!commandsDir) {
    console.warn(
      '[prdSlashCommands] commands dir not found; PRD projects will be scaffolded ' +
        'without slash commands. Looked in: ' + CANDIDATE_DIRS.join(', '),
    );
    return {};
  }
  try {
    return Object.fromEntries(
      readdirSync(commandsDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => [name, readFileSync(join(commandsDir, name), 'utf-8')]),
    );
  } catch (error) {
    console.warn(`[prdSlashCommands] failed to read ${commandsDir}: ${error.message}`);
    return {};
  }
}

export const PRD_SLASH_COMMANDS = loadSlashCommands();
