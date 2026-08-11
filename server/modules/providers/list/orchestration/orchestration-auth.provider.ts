import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * Auth provider for Orchestration ("Agent SDK").
 *
 * Orchestration runs the real Claude Code agent SDK on the user's ambient Claude
 * credentials (same ~/.claude auth as the claude provider), so authentication is
 * identical to claude's. Delegate to {@link ClaudeProviderAuth} and re-tag the
 * status with the `orchestration` provider id.
 */
export class OrchestrationProviderAuth extends ClaudeProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const status = await super.getStatus();
    return { ...status, provider: 'orchestration' };
  }
}
