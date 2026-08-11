import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class DeepSeekProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   *
   * DeepSeek reuses the Claude Code CLI run against DeepSeek's Anthropic-compatible
   * endpoint, so the same executable resolution used by Claude applies here.
   */
  private checkInstalled(): boolean {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns DeepSeek installation and credential status.
   *
   * Authentication is driven entirely by the DEEPSEEK_API_KEY environment value
   * that is injected per-call as the Anthropic auth token.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'deepseek',
        authenticated: false,
        email: null,
        method: 'api_key',
        error: 'Claude Code CLI is not installed',
      };
    }

    const authenticated = Boolean(process.env.DEEPSEEK_API_KEY?.trim());

    return {
      installed,
      provider: 'deepseek',
      authenticated,
      email: authenticated ? 'DeepSeek API Key' : null,
      method: 'api_key',
      error: authenticated ? undefined : 'DEEPSEEK_API_KEY is not set',
    };
  }
}
