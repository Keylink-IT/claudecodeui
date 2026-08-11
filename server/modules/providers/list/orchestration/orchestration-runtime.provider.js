import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { getStrategy } from '@/modules/providers/list/orchestration/orchestration-strategies.js';

// Orchestration ("Agent SDK") reuses the Claude Code agent SDK harness with the
// user's ambient Claude auth (same ~/.claude config dir and OAuth as the claude
// provider — so, unlike DeepSeek, it does NOT override CLAUDE_CONFIG_DIR or inject
// an API-key env). The difference is purely how the turn is framed:
//
//   options.model arrives carrying a STRATEGY id (fan-out / pipeline / debate).
//   We resolve it to (a) the orchestrator's real model, (b) a strategy system
//   prompt appended via `appendSystemPrompt`, and (c) an `agents` roster of
//   per-role subagents. The orchestrator then delegates to those subagents via
//   the SDK's built-in Task tool. The claude runtime's mapCliOptionsToSDK honors
//   the `agents` and `appendSystemPrompt` fields (additive, null-safe).
//
// A provider tag is passed so the live stream renders under "Agent SDK".
export const orchestrationRuntime = {
  run(command, options, writer, context) {
    const strategy = getStrategy(options?.model);
    return claudeRuntime.run(
      command,
      {
        ...options,
        provider: 'orchestration',
        // Replace the strategy id with the orchestrator's real model.
        model: strategy.orchestratorModel,
        // Register the strategy's subagent roster (SDK `agents` option).
        agents: strategy.agents,
        // Layered onto the claude_code preset system prompt.
        appendSystemPrompt: strategy.systemPrompt,
      },
      writer,
      context,
    );
  },
  abort(sessionId) {
    return claudeRuntime.abort(sessionId);
  },
  permissions: claudeRuntime.permissions,
};
