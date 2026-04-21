import os from 'node:os';
import { execSync } from 'node:child_process';
import { log } from '../core/logger.js';

/**
 * Detected hardware profile used to size local model recommendations.
 */
export interface SystemProfile {
  /** Total system RAM in GB, rounded to one decimal. */
  totalRAMGb: number;
  /** Estimated RAM available for model weights + activation cache. */
  usableForModelsGb: number;
  /** Node `os.platform()` value (darwin, linux, win32, ...). */
  platform: string;
  /** True on Apple Silicon (unified memory, MLX-capable). */
  isAppleSilicon: boolean;
  /** NVIDIA VRAM in GB if `nvidia-smi` is available, else null. */
  nvidiaVRAMGb: number | null;
}

export type OllamaModelTier = 'tiny' | 'small' | 'medium' | 'large';

/**
 * Recommended Ollama model names for each agent-harness model tier
 * (primary, summary, fast), scoped to the detected hardware profile.
 */
export interface OllamaModelRecommendation {
  tier: OllamaModelTier;
  primary: string;
  summary: string;
  fast: string;
  reason: string;
  noUsableModels?: boolean;
}

/** True if the tag refers to a Cerebras-hosted cloud model served via Ollama. */
export function isCloudModel(tag: string): boolean {
  const lower = tag.toLowerCase();
  return lower.includes('-cloud') || lower.endsWith(':cloud');
}

/**
 * True if the tag is a cloud model OR has a parameter-size marker of 4B or
 * larger. Used to filter out tiny models (0.6B, 1.7B) when picking a
 * fallback primary.
 */
export function isUsableSize(tag: string): boolean {
  if (isCloudModel(tag)) return true;
  const match = tag.match(/(\d+(?:\.\d+)?)b/i);
  if (!match) return true;
  return parseFloat(match[1]) >= 4;
}

const MODEL_TIERS: Record<OllamaModelTier, Omit<OllamaModelRecommendation, 'reason'>> = {
  tiny: {
    tier: 'tiny',
    primary: 'qwen3.5:4b',
    summary: 'qwen3.5:4b',
    fast: 'qwen3.5:4b',
  },
  small: {
    tier: 'small',
    primary: 'qwen3.5:9b',
    summary: 'qwen3.5:4b',
    fast: 'qwen3.5:4b',
  },
  medium: {
    tier: 'medium',
    primary: 'gemma4:26b',
    summary: 'qwen3.5:9b',
    fast: 'qwen3.5:4b',
  },
  large: {
    tier: 'large',
    primary: 'gemma4:26b',
    summary: 'gemma4:26b',
    fast: 'qwen3.5:4b',
  },
};

const MODEL_PREFERENCE = [
  'qwen3-coder:480b-cloud',
  'gpt-oss:120b-cloud',
  'qwen3-coder:30b',
  'qwen3.6:35b',
  'gemma4:26b',
  'qwen3.5:35b-a3b-coding-nvfp4',
  'qwen3.5:9b',
  'gemma4:12b',
  'qwen3.5:4b',
];

function detectAppleSilicon(): boolean {
  if (os.platform() !== 'darwin') return false;
  try {
    const brand = execSync('sysctl -n machdep.cpu.brand_string', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return brand.includes('Apple');
  } catch {
    return os.arch() === 'arm64';
  }
}

function detectNvidiaVRAM(): number | null {
  try {
    const output = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mb = parseInt(output.split('\n')[0] ?? '0', 10);
    if (!isNaN(mb) && mb > 0) {
      return Math.round((mb / 1024) * 10) / 10;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe the local machine's hardware and return a SystemProfile. Applies a
 * heuristic for usableForModelsGb based on platform:
 *   - NVIDIA: VRAM minus 1 GB
 *   - Apple Silicon: 65% of unified memory
 *   - Other: total RAM minus 3 GB for OS/working set
 */
export function detectSystem(): SystemProfile {
  const totalBytes = os.totalmem();
  const totalRAMGb = Math.round((totalBytes / 1024 ** 3) * 10) / 10;
  const platform = os.platform();
  const isAppleSilicon = detectAppleSilicon();
  const nvidiaVRAMGb = detectNvidiaVRAM();

  let usableForModelsGb: number;
  if (nvidiaVRAMGb !== null) {
    usableForModelsGb = nvidiaVRAMGb - 1;
  } else if (isAppleSilicon) {
    usableForModelsGb = totalRAMGb * 0.65;
  } else {
    usableForModelsGb = totalRAMGb - 3;
  }
  usableForModelsGb = Math.max(0, usableForModelsGb);

  const profile: SystemProfile = {
    totalRAMGb,
    usableForModelsGb,
    platform,
    isAppleSilicon,
    nvidiaVRAMGb,
  };
  log.debug(`system profile: ${JSON.stringify(profile)}`);
  return profile;
}

/**
 * Suggest Ollama model tags for each agent-harness tier (primary, summary,
 * fast) based on the detected hardware profile. Optionally clamps the
 * recommendation to the set of models actually installed locally.
 *
 * @param profile - Hardware profile from `detectSystem`. Detected when omitted.
 * @param installedModels - Array of model tags from `ollama list` / `/api/tags`.
 */
export function recommendOllamaModels(
  profile?: SystemProfile,
  installedModels?: string[],
): OllamaModelRecommendation {
  const sys = profile || detectSystem();
  const mem = sys.usableForModelsGb;

  let ideal: OllamaModelRecommendation;
  if (mem < 4) {
    log.warn(`very limited memory for local models: ${sys.totalRAMGb} GB total`);
    ideal = {
      ...MODEL_TIERS.tiny,
      reason: `Only ${sys.totalRAMGb} GB RAM — local models will be slow. Consider the agntk-free or cerebras provider instead.`,
    };
  } else if (mem < 10) {
    ideal = {
      ...MODEL_TIERS.small,
      reason: `${sys.totalRAMGb} GB RAM → qwen3.5:9b primary, qwen3.5:4b for summary/fast`,
    };
  } else if (mem < 24) {
    ideal = {
      ...MODEL_TIERS.medium,
      reason: `${sys.totalRAMGb} GB RAM → gemma4:26b primary, qwen3.5:9b summary, qwen3.5:4b fast`,
    };
  } else {
    ideal = {
      ...MODEL_TIERS.large,
      reason: `${sys.totalRAMGb} GB RAM → gemma4:26b primary + summary, qwen3.5:4b fast`,
    };
  }

  if (!installedModels || installedModels.length === 0) {
    return ideal;
  }

  const installed = new Set(installedModels.map((m) => m.toLowerCase()));
  const bestAvailable = pickBestAvailable(installed);
  if (!bestAvailable) {
    log.info(`no usable local models installed (need 4B+ or cloud tag)`);
    return {
      ...ideal,
      noUsableModels: true,
      reason: 'No usable models installed — pull one with `ollama pull gemma4:26b` (or similar).',
    };
  }

  const clamp = (model: string): string => {
    const norm = model.toLowerCase();
    if (installed.has(norm) || [...installed].some((m) => m.startsWith(norm))) {
      return model;
    }
    return bestAvailable;
  };

  const result: OllamaModelRecommendation = {
    tier: ideal.tier,
    primary: clamp(ideal.primary),
    summary: clamp(ideal.summary),
    fast: clamp(ideal.fast),
    reason: '',
  };
  const unique = [...new Set([result.primary, result.summary, result.fast])];
  result.reason = `${sys.totalRAMGb} GB RAM → ${unique.join(', ')}`;
  return result;
}

function pickBestAvailable(installed: Set<string>): string | null {
  for (const model of MODEL_PREFERENCE) {
    if (installed.has(model) || [...installed].some((m) => m.startsWith(model))) {
      return model;
    }
  }
  for (const model of installed) {
    if (isUsableSize(model)) {
      return model;
    }
  }
  return null;
}

/**
 * Fetch locally-installed Ollama model tags via the Ollama REST API at
 * /api/tags. Returns an empty array if Ollama is not running or the request
 * fails within 2 seconds.
 *
 * Note: /api/tags is Ollama's NATIVE endpoint, distinct from the
 * OpenAI-compat /v1/chat/completions used by `harness run`. Strips any /v1
 * or /api suffix from baseUrl before calling.
 */
export async function getOllamaModels(baseUrl?: string): Promise<string[]> {
  const rawUrl = baseUrl || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
  const url = rawUrl.replace(/\/(api|v1)\/?$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: controller.signal,
      method: 'GET',
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models || []).map((m) => m.name);
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

/**
 * Prefix-match check for a specific Ollama model tag. Returns false when
 * Ollama is not running or the model is not installed.
 */
export async function hasOllamaModel(model: string, baseUrl?: string): Promise<boolean> {
  const models = await getOllamaModels(baseUrl);
  const normalized = model.toLowerCase();
  return models.some((m) => m.toLowerCase().startsWith(normalized));
}
