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

export async function runExport(opts: RunExportOptions): Promise<ExportReport[]> {
  const { harnessDir, providers, targetPath, dryRun = false } = opts;
  const all = loadAllPrimitives(harnessDir);
  const skills = all.get('skills') ?? [];
  const rules = all.get('rules') ?? [];
  const identity = loadIdentity(harnessDir);

  const reports: ExportReport[] = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) {
      throw new Error(`unknown provider: ${name}`);
    }
    const targetDir = targetPath ?? `.${name}`;
    const ctx: ExportContext = {
      harnessDir,
      targetDir,
      skills,
      rules,
      identity: { content: identity.content, source: String(identity.source) },
      harnessVersion: harnessVersion(harnessDir),
    };
    if (dryRun) {
      reports.push({ provider: name, written: [], skipped: [], warnings: ['dry-run: no files written'] });
      continue;
    }
    const report = await adapter.exportAll(ctx);
    reports.push(report);
  }
  return reports;
}
