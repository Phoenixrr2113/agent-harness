import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { CONFIG_DEFAULTS, HarnessConfigSchema, type HarnessConfig, type DeepPartial } from './types.js';

const CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'harness.yaml', 'harness.yml'];

export function loadConfig(dir: string, overrides?: DeepPartial<HarnessConfig>): HarnessConfig {
  let raw: Record<string, unknown> = {};

  for (const filename of CONFIG_FILENAMES) {
    const configPath = join(dir, filename);
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      raw = YAML.parse(content) || {};
      break;
    }
  }

  // Deep merge: defaults <- file <- overrides
  let merged = deepMerge(
    CONFIG_DEFAULTS as unknown as Record<string, unknown>,
    raw,
  ) as unknown as Record<string, unknown>;

  if (overrides) {
    merged = deepMerge(
      merged,
      overrides as unknown as Record<string, unknown>,
    );
  }

  // Validate with Zod — parse applies defaults and coerces types
  const result = HarnessConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }

  return result.data;
}

export function writeDefaultConfig(_dir: string, agentName: string = 'my-agent'): string {
  return `# Agent Harness Configuration
agent:
  name: ${agentName}
  version: "0.1.0"

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
  max_tokens: 200000

runtime:
  scratchpad_budget: 10000
  timezone: America/New_York
  # heartbeat: "0 6-23 * * *"
  # daily_summary: "0 22 * * *"

memory:
  session_retention_days: 7
  journal_retention_days: 365

channels:
  primary: cli
`;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
