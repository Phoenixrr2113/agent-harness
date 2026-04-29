import { readFileSync } from 'fs';
import { join } from 'path';
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

function harnessVersion(harnessDir: string): string {
  try {
    const raw = readFileSync(join(harnessDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return `${pkg.name ?? 'agent-harness'}@${pkg.version ?? 'unknown'}`;
  } catch {
    return 'agent-harness@unknown';
  }
}

function buildContext(harnessDir: string, targetDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
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
    const targetDir = targetPath ?? `.${name}`;
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
    const targetDir = targetPath ?? `.${name}`;
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
    const targetDir = targetPath ?? `.${name}`;
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
  const targetDir = targetPath ?? `.${provider}`;
  const ctx = buildContext(harnessDir, targetDir);
  return adapter.resyncFile(ctx, providerFile);
}
