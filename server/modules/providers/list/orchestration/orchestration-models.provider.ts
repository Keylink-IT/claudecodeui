import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  STRATEGY_OPTIONS,
  DEFAULT_STRATEGY,
} from '@/modules/providers/list/orchestration/orchestration-strategies.js';

/**
 * The "Agent SDK" provider's model catalog is the list of orchestration
 * STRATEGIES (fan-out / pipeline / debate). The selected value is sent as
 * options.model on the chat turn and resolved server-side by the orchestration
 * runtime into an orchestrator model + subagent roster.
 */
export const ORCHESTRATION_MODELS: ProviderModelsDefinition = {
  OPTIONS: STRATEGY_OPTIONS,
  DEFAULT: DEFAULT_STRATEGY,
};

export class OrchestrationProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return ORCHESTRATION_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Strategies are not persisted per-session beyond the gateway's setSessionModel
    // record, so the catalog default is the authoritative active strategy.
    return { model: ORCHESTRATION_MODELS.DEFAULT };
  }
}
