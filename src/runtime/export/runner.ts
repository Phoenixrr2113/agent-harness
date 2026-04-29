import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { loadIdentity } from '../context-loader.js';
import { getAdapter } from './registry.js';
import type { ExportContext, ExportReport, ProviderName } from './types.js';

export interface RunExportOptions {
  harnessDir: string;
  providers: ProviderName[];
  targetPath?: string;
  dryRun?: boolean;
  force?: boolean;
}

/**
 * Default target directory for each provider. Resolved relative to harnessDir
 * unless the user passes --target. Per-provider defaults match the canonical
 * paths that each upstream tool reads from (copilot's `.github/`, etc.).
 */
const DEFAULT_PROVIDER_TARGET: Record<ProviderName, string> = {
  claude: '.claude',
  codex: '.codex',
  cursor: '.cursor',
  copilot: '.github',
  gemini: '.gemini',
  agents: '.agents',
};

/**
 * Resolve the running CLI's package version. The bundle is flat in dist/, so
 * we walk multiple candidate paths and validate via pkg.name (per CLAUDE.md §10).
 * Falls back to 'agent-harness@unknown' only when running outside any package.
 */
function resolveCliVersion(): string {
  const here = fileURLToPath(import.meta.url);
  const require = createRequire(import.meta.url);
  const candidates = [
    '../../package.json',           // src/runtime/export/runner.ts → repo root
    '../../../package.json',         // dist/runtime/export/runner.js → repo root (ESM bundles)
    '../package.json',               // dist/cli/index.js (flat tsup output) → repo root
  ];
  for (const candidate of candidates) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === '@agntk/agent-harness' && pkg.version) {
        return `${pkg.name}@${pkg.version}`;
      }
    } catch {
      // try next
    }
  }
  // Walk up from import.meta.url looking for a sibling package.json
  let dir = dirname(here);
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === '@agntk/agent-harness' && pkg.version) {
          return `${pkg.name}@${pkg.version}`;
        }
      } catch {
        // try parent
      }
    }
    dir = dirname(dir);
  }
  return 'agent-harness@unknown';
}

const _CLI_VERSION = resolveCliVersion();

function harnessVersion(_harnessDir: string): string {
  return _CLI_VERSION;
}

export function defaultTargetFor(provider: ProviderName): string {
  return DEFAULT_PROVIDER_TARGET[provider];
}

/**
 * Resolve a provider target directory. Relative paths are anchored at the
 * project root (not at process.cwd()), so `harness export` works the same
 * regardless of the directory it's invoked from. The project root is the
 * harness's parent for subdirectory installs (e.g. `<project>/.harness/`),
 * or the harness directory itself for standalone installs.
 */
export function resolveTargetDir(harnessDir: string, provider: ProviderName, targetPath?: string): string {
  const path = targetPath ?? defaultTargetFor(provider);
  if (isAbsolute(path)) return path;
  return join(detectProjectRoot(harnessDir), path);
}

/**
 * Resolve the host project root. If `harnessDir`'s parent has any
 * project-level sentinel (AGENTS.md, CLAUDE.md, GEMINI.md, package.json,
 * .git), treat it as a subdirectory install and return the parent.
 * Otherwise treat the harness directory itself as the project root.
 */
export function detectProjectRoot(harnessDir: string): string {
  const parent = dirname(harnessDir);
  if (parent === harnessDir) return harnessDir; // already at filesystem root
  const sentinels = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'package.json', '.git'];
  for (const f of sentinels) {
    if (existsSync(join(parent, f))) {
      return parent;
    }
  }
  return harnessDir;
}

function buildContext(harnessDir: string, targetDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    projectRoot: detectProjectRoot(harnessDir),
    targetDir,
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: harnessVersion(harnessDir),
  };
}

export async function runExport(opts: RunExportOptions): Promise<ExportReport[]> {
  const { harnessDir, providers, targetPath, dryRun = false } = opts;

  const reports: ExportReport[] = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) {
      throw new Error(`unknown provider: ${name}`);
    }
    const targetDir = resolveTargetDir(harnessDir, name, targetPath);
    const ctx = buildContext(harnessDir, targetDir);
    if (dryRun) {
      reports.push({ provider: name, written: [], skipped: [], warnings: ['dry-run: no files written'] });
      continue;
    }
    const report = await adapter.exportAll(ctx);
    reports.push(report);
  }
  return reports;
}

export interface DriftRunResult {
  provider: ProviderName;
  findings: { path: string; severity: string; kind: string; detail: string }[];
}

export async function runDrift(harnessDir: string, providers: ProviderName[], targetPath?: string): Promise<DriftRunResult[]> {
  const out: DriftRunResult[] = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) throw new Error(`unknown provider: ${name}`);
    const targetDir = resolveTargetDir(harnessDir, name, targetPath);
    const ctx = buildContext(harnessDir, targetDir);
    const report = await adapter.detectDrift(ctx);
    out.push({ provider: name, findings: report.findings });
  }
  return out;
}

export async function runPrune(harnessDir: string, providers: ProviderName[], targetPath?: string): Promise<{ provider: ProviderName; removed: string[] }[]> {
  const out: { provider: ProviderName; removed: string[] }[] = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) throw new Error(`unknown provider: ${name}`);
    if (!adapter.prune) {
      out.push({ provider: name, removed: [] });
      continue;
    }
    const targetDir = resolveTargetDir(harnessDir, name, targetPath);
    const ctx = buildContext(harnessDir, targetDir);
    const result = await adapter.prune(ctx);
    out.push({ provider: name, removed: result.removed });
  }
  return out;
}

export async function runResync(harnessDir: string, provider: ProviderName, providerFile: string, targetPath?: string): Promise<{ updated: string }> {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`unknown provider: ${provider}`);
  if (!adapter.resyncFile) throw new Error(`provider ${provider} does not support resync`);
  const targetDir = resolveTargetDir(harnessDir, provider, targetPath);
  const ctx = buildContext(harnessDir, targetDir);
  return adapter.resyncFile(ctx, providerFile);
}
