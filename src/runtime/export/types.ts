import type { HarnessDocument } from '../../core/types.js';

export type ProviderName = 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents';

export interface ExportTarget {
  provider: ProviderName;
  path: string;
  auto?: boolean;
}

export interface ExportReport {
  provider: ProviderName;
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export interface DriftFinding {
  path: string;
  severity: 'info' | 'warning';
  kind: 'modified' | 'missing-marker' | 'missing-file' | 'orphan';
  detail: string;
}

export interface DriftReport {
  provider: ProviderName;
  findings: DriftFinding[];
}

export interface ExportContext {
  harnessDir: string;
  targetDir: string;
  skills: HarnessDocument[];
  rules: HarnessDocument[];
  identity: { content: string; source: string };
  harnessVersion: string;
}

export interface ProviderAdapter {
  name: ProviderName;
  exportAll(ctx: ExportContext): Promise<ExportReport>;
  detectDrift(ctx: ExportContext): Promise<DriftReport>;
  prune?(ctx: ExportContext): Promise<{ removed: string[] }>;
  resyncFile?(ctx: ExportContext, providerFile: string): Promise<{ updated: string }>;
}
