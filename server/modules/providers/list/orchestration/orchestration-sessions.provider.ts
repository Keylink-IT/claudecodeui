import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * Session/history provider for Orchestration ("Agent SDK").
 *
 * Orchestration runs the Claude Code CLI against the same ~/.claude config dir and
 * on-disk JSONL transcript format as claude, so all parsing is inherited from
 * {@link ClaudeSessionsProvider}. Only the provider tag differs. `fetchHistory` is
 * inherited and calls back into this overridden `normalizeMessage`, so re-tagging
 * here also covers the history path.
 */
export class OrchestrationSessionsProvider extends ClaudeSessionsProvider {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const messages = super.normalizeMessage(rawMessage, sessionId);
    for (const message of messages) {
      message.provider = 'orchestration';
    }
    return messages;
  }
}
