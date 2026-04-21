import type { LanguageModel } from 'ai';

export type ReflectionStrategy = 'none' | 'every-step' | 'periodic';

export interface ReflectionConfig {
  strategy: ReflectionStrategy;
  frequency?: number;
  prompt_template?: string;
}

export interface PrepareStepArgs {
  stepNumber: number;
  steps: unknown[];
  model?: LanguageModel;
  messages?: unknown[];
}

const DEFAULT_FREQUENCY = 3;

const EVERY_STEP_TEMPLATE = `<reflection>
Before proceeding, reflect on your progress:
1. What is the user's original goal?
2. What have you accomplished so far?
3. What is the most important next action to take?
4. Are you on track, or do you need to adjust your approach?
</reflection>`;

const PERIODIC_TEMPLATE = `<reflection>
Checkpoint — pause and evaluate:
1. Revisit the user's original request. Are you still aligned with their goal?
2. Summarize what you have done so far.
3. Identify any dead ends or wasted steps.
4. Plan your next 2-3 actions to reach completion efficiently.
</reflection>`;

/**
 * Return the reflection prompt string to inject for a given step, or
 * undefined if this step should skip reflection.
 *
 * Strategies:
 *   - none        → always undefined
 *   - every-step  → inject on every step AFTER the first (step 0 has nothing
 *                   to reflect on)
 *   - periodic    → inject every `frequency` steps (default 3), skipping step 0
 */
export function buildReflectionPrompt(
  config: ReflectionConfig,
  stepNumber: number,
): string | undefined {
  const { strategy } = config;
  if (strategy === 'none') return undefined;

  if (strategy === 'every-step') {
    if (stepNumber === 0) return undefined;
    return config.prompt_template ?? EVERY_STEP_TEMPLATE;
  }

  if (strategy === 'periodic') {
    const frequency = config.frequency ?? DEFAULT_FREQUENCY;
    if (stepNumber === 0 || stepNumber % frequency !== 0) return undefined;
    return config.prompt_template ?? PERIODIC_TEMPLATE;
  }

  return undefined;
}

/**
 * Build a prepareStep handler compatible with AI SDK's generateText /
 * streamText. When reflection fires for a given step, the handler returns a
 * system-prompt override that appends the reflection directive to the base
 * system prompt. Returns undefined on steps that should not reflect — the
 * AI SDK then uses its own defaults unchanged.
 *
 * @param baseSystem - The original system prompt (string or thunk).
 * @param config - Reflection strategy configuration.
 */
export function createReflectionPrepareStep(
  baseSystem: string | (() => string),
  config: ReflectionConfig,
): (input: PrepareStepArgs) => { system: string } | undefined {
  if (config.strategy === 'none') {
    return () => undefined;
  }
  return ({ stepNumber }) => {
    const reflection = buildReflectionPrompt(config, stepNumber);
    if (!reflection) return undefined;
    const base = typeof baseSystem === 'function' ? baseSystem() : baseSystem;
    return { system: `${base}\n\n${reflection}` };
  };
}

/**
 * Rough token estimate for the reflection directive alone (not including the
 * base system prompt). Useful for budgeting when deciding whether to enable
 * reflection on a context-sensitive run.
 */
export function estimateReflectionTokens(config: ReflectionConfig): number {
  const template =
    config.strategy === 'every-step'
      ? config.prompt_template ?? EVERY_STEP_TEMPLATE
      : config.strategy === 'periodic'
        ? config.prompt_template ?? PERIODIC_TEMPLATE
        : '';
  return Math.ceil(template.length / 4);
}
