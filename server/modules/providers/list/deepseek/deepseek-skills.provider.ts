import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import type { ProviderSkill, ProviderSkillListOptions } from '@/shared/types.js';

/**
 * Skills provider for DeepSeek.
 *
 * DeepSeek runs the Claude Code CLI and shares claude's skill/plugin discovery
 * locations, so all discovery logic is inherited from {@link ClaudeSkillsProvider}.
 * The base claude provider stamps each {@link ProviderSkill} with its own
 * `claude` provider id (both for user/project skills and plugin skills), so this
 * subclass re-tags every returned skill as `deepseek` after discovery to avoid
 * silently inheriting the `claude` tag.
 */
export class DeepSeekSkillsProvider extends ClaudeSkillsProvider {
  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    return skills.map((skill) => ({ ...skill, provider: 'deepseek' }));
  }
}
