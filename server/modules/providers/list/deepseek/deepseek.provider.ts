import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { DeepSeekProviderAuth } from '@/modules/providers/list/deepseek/deepseek-auth.provider.js';
import { DeepSeekProviderModels } from '@/modules/providers/list/deepseek/deepseek-models.provider.js';
import { DeepSeekMcpProvider } from '@/modules/providers/list/deepseek/deepseek-mcp.provider.js';
import { DeepSeekSessionSynchronizer } from '@/modules/providers/list/deepseek/deepseek-session-synchronizer.provider.js';
import { DeepSeekSessionsProvider } from '@/modules/providers/list/deepseek/deepseek-sessions.provider.js';
import { DeepSeekSkillsProvider } from '@/modules/providers/list/deepseek/deepseek-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class DeepSeekProvider extends AbstractProvider {
  readonly models: IProviderModels = new DeepSeekProviderModels();
  readonly mcp = new DeepSeekMcpProvider();
  readonly auth: IProviderAuth = new DeepSeekProviderAuth();
  readonly skills: IProviderSkills = new DeepSeekSkillsProvider();
  readonly sessions: IProviderSessions = new DeepSeekSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new DeepSeekSessionSynchronizer();

  constructor() {
    super('deepseek');
  }
}
