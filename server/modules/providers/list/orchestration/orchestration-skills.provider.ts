import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import type { ProviderSkill, ProviderSkillListOptions } from '@/shared/types.js';

/**
 * Skills provider for Orchestration ("Agent SDK").
 *
 * Orchestration shares claude's skill/plugin discovery locations, so discovery is
 * inherited from {@link ClaudeSkillsProvider}; each skill is re-tagged with the
 * `orchestration` provider id after discovery.
 */
export class OrchestrationSkillsProvider extends ClaudeSkillsProvider {
  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    return skills.map((skill) => ({ ...skill, provider: 'orchestration' }));
  }
}
