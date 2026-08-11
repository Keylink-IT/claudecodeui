/**
 * Orchestration strategies for the "Agent SDK" provider.
 *
 * Each strategy turns a single Claude Agent SDK query into a multi-agent job: the
 * main query acts as an ORCHESTRATOR and delegates to a roster of subagents (each
 * with its own model) via the SDK's built-in `Task` tool.
 *
 * A strategy provides:
 *   - `label` / `description` — surfaced in the model dropdown catalog
 *   - `orchestratorModel`     — the model the orchestrator (main thread) runs at
 *   - `systemPrompt`          — appended to the orchestrator's system prompt; tells
 *                               it how to decompose and which agents to delegate to
 *   - `agents`                — a `Record<string, AgentDefinition>` passed straight
 *                               to the SDK `agents` option. `model` is limited by the
 *                               SDK to 'sonnet' | 'opus' | 'haiku' | 'inherit'.
 *
 * Models are strategy-pinned defaults; a per-role model picker is a future
 * enhancement. Shared by `orchestration-runtime.provider.js` (resolves a strategy
 * to SDK options) and `orchestration-models.provider.ts` (builds the catalog).
 */

/** Minimal shape of an SDK AgentDefinition (see @anthropic-ai/claude-agent-sdk). */
export interface OrchestrationAgentDefinition {
  description: string;
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
}

export interface OrchestrationStrategy {
  value: string;
  label: string;
  description: string;
  orchestratorModel: string;
  systemPrompt: string;
  agents: Record<string, OrchestrationAgentDefinition>;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

const fanOut: OrchestrationStrategy = {
  value: 'fan-out',
  label: 'Fan-out',
  description: 'Decompose into parallel subagents, then synthesize',
  orchestratorModel: 'opus',
  systemPrompt: [
    'You are operating in ORCHESTRATION mode with the **Fan-out** strategy.',
    '',
    'Your job is to coordinate, not to do all the work yourself:',
    '1. Break the request into independent subtasks that can run in parallel.',
    '2. Dispatch each subtask to the `worker` subagent using the Task tool.',
    '   Launch them CONCURRENTLY — emit multiple Task calls in a single message',
    "   so they run at the same time. Do NOT do a worker's work inline.",
    '3. Wait for all workers, then SYNTHESIZE their results into one coherent',
    '   answer for the user — reconcile overlaps, surface disagreements, and',
    '   note anything no worker could resolve.',
    '',
    'Keep the decomposition to a handful of well-scoped subtasks (typically 2–6).',
    'If the request is genuinely atomic, just answer it directly.',
  ].join('\n'),
  agents: {
    worker: {
      description:
        'Executes one independent, well-scoped subtask of a decomposed job and reports a concise, self-contained result.',
      model: 'sonnet',
      prompt: [
        'You are a Fan-out WORKER. You have been given ONE subtask of a larger job.',
        'Do exactly that subtask — thoroughly and independently — then report a',
        'concise, self-contained result the orchestrator can merge with other',
        "workers' results. Do not attempt the whole job; stay in your lane.",
      ].join('\n'),
    },
  },
};

const pipeline: OrchestrationStrategy = {
  value: 'pipeline',
  label: 'Pipeline',
  description: 'Sequential stages: scout → implement → verify',
  orchestratorModel: 'opus',
  systemPrompt: [
    'You are operating in ORCHESTRATION mode with the **Pipeline** strategy.',
    '',
    "Drive the work through ordered stages, passing each stage's output to the",
    'next via the Task tool:',
    '1. `scout` — investigate and gather the context/plan needed for the work.',
    "2. `implementer` — carry out the work using the scout's findings.",
    "3. `verifier` — check the implementer's output against the original request",
    '   and report problems.',
    '',
    'Run the stages in sequence (each depends on the previous). If the verifier',
    'finds issues, loop back to the implementer once with the specifics. Then',
    'give the user the final result plus a short note on what was verified.',
  ].join('\n'),
  agents: {
    scout: {
      description:
        'First pipeline stage: investigates the codebase/task and returns the context, files, and a concrete plan the implementer needs.',
      model: 'haiku',
      tools: READ_ONLY_TOOLS,
      prompt: [
        'You are the pipeline SCOUT. Investigate the task and return a concise,',
        'actionable brief: the relevant files/locations, key constraints, and a',
        'concrete step-by-step plan for the implementer. Do NOT make changes —',
        'you are read-only reconnaissance.',
      ].join('\n'),
    },
    implementer: {
      description:
        "Second pipeline stage: performs the actual work (edits, code, output) using the scout's brief.",
      model: 'sonnet',
      prompt: [
        "You are the pipeline IMPLEMENTER. Using the scout's brief, carry out the",
        'work end to end. Follow the plan, but adapt if you discover the brief was',
        'wrong. Report exactly what you changed/produced so the verifier can check it.',
      ].join('\n'),
    },
    verifier: {
      description:
        "Third pipeline stage: checks the implementer's output against the original request and reports any problems.",
      model: 'sonnet',
      tools: READ_ONLY_TOOLS,
      prompt: [
        "You are the pipeline VERIFIER. Check the implementer's output against the",
        'original request: does it actually do what was asked, and is it correct?',
        'Report a clear pass/fail with specific issues. Do NOT fix things yourself —',
        'report so the orchestrator can decide whether to loop back.',
      ].join('\n'),
    },
  },
};

const debate: OrchestrationStrategy = {
  value: 'debate',
  label: 'Debate',
  description: 'Independent attempts + adversarial critique, then merge',
  orchestratorModel: 'opus',
  systemPrompt: [
    'You are operating in ORCHESTRATION mode with the **Debate** strategy.',
    '',
    'Get to a well-vetted answer through independent attempts and adversarial',
    'critique:',
    '1. Spawn TWO `solver` subagents via the Task tool, each with a DIFFERENT',
    '   framing/approach to the request. Launch them concurrently.',
    '2. For each solution, spawn a `critic` subagent to adversarially find its',
    '   flaws, gaps, and failure cases.',
    '3. Weigh the solutions against their critiques, then produce ONE final',
    '   answer — pick the strongest, or merge the best parts of each. Briefly',
    '   explain why, and flag any concern the critics raised that remains open.',
  ].join('\n'),
  agents: {
    solver: {
      description:
        'Produces one independent solution attempt to the request from a given framing/approach.',
      model: 'sonnet',
      prompt: [
        'You are a Debate SOLVER. Produce your best independent solution to the',
        'request using the framing you were given. Commit to a clear position and',
        'justify it — do not hedge across every option. The orchestrator will pit',
        'your attempt against a rival attempt and a critic, so make it strong.',
      ].join('\n'),
    },
    critic: {
      description:
        'Adversarially critiques a proposed solution — finds flaws, gaps, unstated assumptions, and failure cases.',
      model: 'haiku',
      tools: READ_ONLY_TOOLS,
      prompt: [
        'You are a Debate CRITIC. You are given a proposed solution. Attack it:',
        'find its flaws, unstated assumptions, edge cases it breaks on, and',
        'anything it overlooks. Be specific and fair — cite concrete problems, not',
        'vague doubts. If it is genuinely solid, say so and explain why.',
      ].join('\n'),
    },
  },
};

/** All strategies, keyed by the value used in the UI strategy dropdown. */
export const STRATEGIES: Record<string, OrchestrationStrategy> = {
  'fan-out': fanOut,
  pipeline,
  debate,
};

export const DEFAULT_STRATEGY = 'fan-out';

/** Catalog options for the models provider ({ value, label, description }). */
export const STRATEGY_OPTIONS = Object.values(STRATEGIES).map(({ value, label, description }) => ({
  value,
  label,
  description,
}));

/**
 * Resolve a strategy id (from the UI dropdown) to its definition, falling back to
 * the default for unknown/empty ids.
 */
export function getStrategy(id?: string): OrchestrationStrategy {
  return (id && STRATEGIES[id]) || STRATEGIES[DEFAULT_STRATEGY];
}
