import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { orchestrationRuntime } from '@/modules/providers/list/orchestration/orchestration-runtime.provider.js';
import { OrchestrationProviderAuth } from '@/modules/providers/list/orchestration/orchestration-auth.provider.js';
import { OrchestrationProviderModels } from '@/modules/providers/list/orchestration/orchestration-models.provider.js';
import { OrchestrationMcpProvider } from '@/modules/providers/list/orchestration/orchestration-mcp.provider.js';
import { OrchestrationSessionSynchronizer } from '@/modules/providers/list/orchestration/orchestration-session-synchronizer.provider.js';
import { OrchestrationSessionsProvider } from '@/modules/providers/list/orchestration/orchestration-sessions.provider.js';
import { OrchestrationSkillsProvider } from '@/modules/providers/list/orchestration/orchestration-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

/**
 * "Agent SDK" provider — a multi-agent orchestration mode built on the Claude Code
 * agent SDK. Its "models" are orchestration strategies (fan-out / pipeline /
 * debate); the runtime frames the turn as an orchestrator + subagent roster. All
 * non-runtime facets mirror claude (shared ~/.claude auth/config), re-tagged
 * `orchestration`. See orchestration-runtime.provider.js + orchestration-strategies.ts.
 */
export class OrchestrationProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = orchestrationRuntime;
  readonly models: IProviderModels = new OrchestrationProviderModels();
  readonly mcp = new OrchestrationMcpProvider();
  readonly auth: IProviderAuth = new OrchestrationProviderAuth();
  readonly skills: IProviderSkills = new OrchestrationSkillsProvider();
  readonly sessions: IProviderSessions = new OrchestrationSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new OrchestrationSessionSynchronizer();

  constructor() {
    super('orchestration');
  }
}
