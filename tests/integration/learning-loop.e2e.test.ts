/**
 * End-to-end integration test for the learning loop — the headline feature.
 *
 * This test exercises the FULL pipeline against a real LLM:
 *
 *   harness init → 7× harness run → harness journal → harness learn --install
 *   → verify instinct file written → verify next run loads it
 *
 * It uses **local Ollama** as the LLM backend so it costs $0/run and doesn't
 * need any API keys in CI. Skips automatically if Ollama isn't reachable or
 * the required model isn't pulled — so adding it to `tests/` doesn't break
 * `npm test` on machines without Ollama installed.
 *
 * To run this manually:
 *
 *   1. Start Ollama: `ollama serve` (or it auto-starts on Mac)
 *   2. Pull the model: `ollama pull qwen3:1.7b`
 *   3. `INTEGRATION=1 npm test -- tests/integration/learning-loop.e2e.test.ts`
 *
 * Without `INTEGRATION=1` this test self-skips even when Ollama is up,
 * because the full sequence takes 30–60 seconds and noisy log output isn't
 * appropriate for the regular `npm test` developer feedback loop. Set the
 * env var to opt in.
 *
 * To run as part of CI: add a separate workflow that installs Ollama, pulls
 * `qwen3:1.7b`, and runs `INTEGRATION=1 npm test`. The model is small (1.4 GB)
 * so the workflow setup is feasible on standard runners.
 *
 * If this test FAILS, it means the headline feature of the harness — the
 * learning loop that produces measurably different behavior over time — is
 * broken in some way the unit tests don't catch. Six releases shipped during
 * the v0.1.0 → v0.1.6 development cycle without an automated check for this,
 * relying on a single manual run. This test is the codification of that gap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import matter from 'gray-matter';

// Ollama's NATIVE API root (used to probe /api/tags for the model list).
// This is intentionally separate from the OpenAI-compatible endpoint that
// the harness's provider uses (which is at /v1 on the same host) — they're
// the same server but two different API surfaces.
const OLLAMA_NATIVE_URL = process.env.OLLAMA_NATIVE_URL ?? 'http://localhost:11434';
// OpenAI-compatible endpoint that the harness's provider passes to the
// OpenAI SDK as baseURL. This MUST end in /v1 because the SDK appends
// /chat/completions to it.
const OLLAMA_OPENAI_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
const TEST_MODEL = process.env.OLLAMA_TEST_MODEL ?? 'qwen3:1.7b';
const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');
const INTEGRATION_OPT_IN = process.env.INTEGRATION === '1';

/**
 * Probe Ollama and check the test model is available. Returns null if the
 * test should run, or a string reason if it should skip.
 */
async function checkOllamaReady(): Promise<string | null> {
  if (!INTEGRATION_OPT_IN) {
    return 'INTEGRATION env var not set (run with INTEGRATION=1 to enable)';
  }
  if (!existsSync(HARNESS_BIN)) {
    return `harness CLI not built at ${HARNESS_BIN} (run npm run build)`;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${OLLAMA_NATIVE_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return `Ollama responded with ${response.status} at ${OLLAMA_NATIVE_URL}`;
    }
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const modelNames = data.models?.map((m) => m.name ?? '').filter(Boolean) ?? [];
    if (!modelNames.includes(TEST_MODEL)) {
      return `model ${TEST_MODEL} not pulled (run \`ollama pull ${TEST_MODEL}\`). Available: ${modelNames.join(', ')}`;
    }
    return null;
  } catch (err) {
    return `Ollama not reachable at ${OLLAMA_NATIVE_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run the harness CLI as a subprocess. Captures stdout, stderr, exit code,
 * and walltime so test assertions can check both behavior and performance.
 */
function runHarness(args: string[], opts: { cwd?: string; timeout?: number } = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync('node', [HARNESS_BIN, ...args], {
    cwd: opts.cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, OLLAMA_BASE_URL: OLLAMA_OPENAI_URL },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

describe('learning loop end-to-end (Ollama)', () => {
  let skipReason: string | null = null;
  let harnessDir: string;
  let tmpBase: string;

  beforeAll(async () => {
    skipReason = await checkOllamaReady();
    if (skipReason) {
      // eslint-disable-next-line no-console
      console.log(`[learning-loop.e2e] SKIPPED: ${skipReason}`);
      return;
    }

    // Scaffold a fresh harness directory in a temp location
    tmpBase = mkdtempSync(join(tmpdir(), 'harness-e2e-'));
    harnessDir = join(tmpBase, 'agent');
    const initResult = runHarness([
      'init',
      harnessDir,
      '--no-discover-mcp',
      '--no-discover-env',
      '--no-discover-project',
      '--yes',
    ]);
    if (initResult.exitCode !== 0) {
      throw new Error(`harness init failed: ${initResult.stderr || initResult.stdout}`);
    }

    // Switch the scaffold's config to use Ollama with the test model.
    // The base scaffold defaults to openrouter+sonnet which would fail without an API key.
    // Use line-by-line replacement scoped to the `model:` section because there
    // are multiple `id:` and `version:` keys in the file at different levels —
    // a global regex would replace the wrong one.
    const configPath = join(harnessDir, 'config.yaml');
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    let inModelSection = false;
    const rewritten = lines.map((line) => {
      if (/^model:\s*$/.test(line)) {
        inModelSection = true;
        return line;
      }
      if (inModelSection && /^[a-zA-Z]/.test(line) && !line.startsWith(' ')) {
        // Top-level key reached — left the model section
        inModelSection = false;
        return line;
      }
      if (inModelSection) {
        if (/^\s+provider:/.test(line)) return '  provider: ollama';
        if (/^\s+id:/.test(line)) return `  id: ${TEST_MODEL}`;
      }
      return line;
    });
    writeFileSync(configPath, rewritten.join('\n'), 'utf-8');

    // Sanity check the rewrite landed — fail loud here rather than producing
    // a confusing 404 from Ollama 30 seconds into the test.
    const finalConfig = readFileSync(configPath, 'utf-8');
    if (!finalConfig.includes('provider: ollama')) {
      throw new Error(`Failed to rewrite config provider:\n${finalConfig}`);
    }
    if (!finalConfig.includes(`id: ${TEST_MODEL}`)) {
      throw new Error(`Failed to rewrite config model id:\n${finalConfig}`);
    }
  }, 60_000);

  afterAll(() => {
    if (tmpBase && existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('runs a single prompt against Ollama and writes a session', async () => {
    if (skipReason) return;

    const result = runHarness(['run', 'What can you do?', '-d', harnessDir], {
      timeout: 30_000,
    });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(50);

    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    const sessions = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('runs 6 more varied prompts to populate the session corpus', async () => {
    if (skipReason) return;

    const prompts = [
      'Plan a birthday party for a 7-year-old, budget $300, theme is dinosaurs',
      'What\'s the difference between SQLite and PostgreSQL in one paragraph',
      'Give me 5 hook angles for a blog post about agentic AI',
      'What\'s the best way to learn Spanish in 6 months as a working adult',
      'Recommend a weekend project for someone bored with their normal hobbies',
      'Help me decide: should I lease or buy a car for my commute',
    ];

    for (const prompt of prompts) {
      const result = runHarness(['run', prompt, '-d', harnessDir], { timeout: 60_000 });
      expect(result.exitCode, `prompt failed: "${prompt}"\nstderr: ${result.stderr}`).toBe(0);
    }

    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    const sessions = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
    expect(sessions.length).toBeGreaterThanOrEqual(7);
  }, 600_000); // 10 min budget — Ollama can be slow on cold start

  it('synthesizes a journal from the session corpus', async () => {
    if (skipReason) return;

    const result = runHarness(['journal', '-d', harnessDir], { timeout: 60_000 });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Sessions:\s*\d+/);
    expect(result.stdout).toContain('Instinct Candidates');

    const journalDir = join(harnessDir, 'memory', 'journal');
    const journals = readdirSync(journalDir).filter((f) => f.endsWith('.md'));
    expect(journals.length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('proposes and installs an instinct from the journal', async () => {
    if (skipReason) return;

    // Count instincts BEFORE installing — baseline is 4 from defaults
    const instinctsDir = join(harnessDir, 'instincts');
    const before = readdirSync(instinctsDir).filter((f) => f.endsWith('.md'));
    const beforeCount = before.length;
    expect(beforeCount).toBeGreaterThanOrEqual(4);

    const result = runHarness(['learn', '--install', '-d', harnessDir], { timeout: 90_000 });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/installed/i);

    // Verify at least one new instinct file appeared
    const after = readdirSync(instinctsDir).filter((f) => f.endsWith('.md'));
    expect(after.length).toBeGreaterThan(beforeCount);

    // Find the new file(s) and verify the frontmatter
    const newFiles = after.filter((f) => !before.includes(f));
    expect(newFiles.length).toBeGreaterThanOrEqual(1);

    const newInstinct = matter.read(join(instinctsDir, newFiles[0]));
    expect(newInstinct.data.id).toBeTruthy();
    expect(newInstinct.data.author).toBe('agent');
    expect(newInstinct.data.status).toBe('active');
    expect(newInstinct.data.source).toBe('auto-detected');
    expect(newInstinct.data.tags).toContain('instinct');
    expect(newInstinct.data.tags).toContain('auto-learned');
  }, 120_000);

  it('loads the new instinct on the next run (file count goes up)', async () => {
    if (skipReason) return;

    // harness info reports the loaded file count. The new instinct should appear.
    const result = runHarness(['info', '-d', harnessDir], { timeout: 30_000 });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const match = result.stdout.match(/Files loaded:\s*(\d+)/);
    expect(match, `info output did not contain Files loaded count:\n${result.stdout}`).toBeTruthy();
    const fileCount = match ? parseInt(match[1], 10) : 0;
    // Default scaffold loads ~10 files. After init we added at least 1 instinct
    // so the count should be at least 11.
    expect(fileCount).toBeGreaterThanOrEqual(11);
  }, 30_000);
});
