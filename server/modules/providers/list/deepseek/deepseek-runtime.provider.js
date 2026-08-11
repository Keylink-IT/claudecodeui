import path from 'path';
import os from 'os';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// DeepSeek reuses the Claude Code agent SDK harness run against DeepSeek's
// Anthropic-compatible endpoint. The only differences are the auth token, the
// selected model, and an isolated CLAUDE_CONFIG_DIR so its sessions/projects are
// kept separate from Claude. These are injected per-call via options.env (which
// the Claude runtime overlays onto the inherited host env) plus a provider tag so
// the live stream renders under DeepSeek.
//
// Ported from the fork's old server/index.js `queryDeepSeek` dispatch when
// upstream 1.37 moved provider dispatch to the provider registry + runtime.
export const deepseekRuntime = {
  run(command, options, writer, context) {
    const dsKey = process.env.DEEPSEEK_API_KEY || '';
    const dsModel = options?.model || 'deepseek-v4-pro';
    const configDir = process.env.DEEPSEEK_CONFIG_DIR
      || path.join(os.homedir(), '.cloudcli', 'deepseek-config');
    return claudeRuntime.run(
      command,
      {
        ...options,
        provider: 'deepseek',
        model: dsModel,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: dsKey,
          ANTHROPIC_API_KEY: dsKey,
          ANTHROPIC_MODEL: dsModel,
          CLAUDE_CONFIG_DIR: configDir,
        },
      },
      writer,
      context,
    );
  },
  abort(sessionId) {
    return claudeRuntime.abort(sessionId);
  },
  permissions: claudeRuntime.permissions,
};
