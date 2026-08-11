import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { writeProviderSessionActiveModelChange } from '@/shared/utils.js';

export const DEEPSEEK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'DeepSeek V4 Pro (reasoning)',
    },
    {
      value: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'DeepSeek V4 Flash (fast)',
    },
  ],
  DEFAULT: 'deepseek-v4-pro',
};

export class DeepSeekProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return DEEPSEEK_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // DeepSeek runs through the Claude Code CLI against DeepSeek's endpoint and
    // does not persist a session-scoped active model lookup of its own, so the
    // provider catalog default is the authoritative active model.
    return { model: DEEPSEEK_FALLBACK_MODELS.DEFAULT };
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('deepseek', input);
  }
}
