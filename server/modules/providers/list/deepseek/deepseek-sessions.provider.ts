import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * Session/history provider for DeepSeek.
 *
 * DeepSeek reuses the Claude Code CLI and the identical on-disk JSONL transcript
 * format, so all parsing is inherited from {@link ClaudeSessionsProvider}. The
 * only difference is that every normalized message must be tagged with the
 * `deepseek` provider id instead of `claude`. `fetchHistory` is inherited and
 * calls back into this overridden `normalizeMessage`, so re-tagging here also
 * covers the history path.
 */
export class DeepSeekSessionsProvider extends ClaudeSessionsProvider {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const messages = super.normalizeMessage(rawMessage, sessionId);
    for (const message of messages) {
      message.provider = 'deepseek';
    }
    return messages;
  }
}
