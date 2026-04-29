import { readdirSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';

export type MigrationKind =
  | 'rename-core-to-identity'
  | 'delete-system-md'
  | 'move-state-to-memory'
  | 'bundle-flat-skill';

export interface MigrationFinding {
  kind: MigrationKind;
  path: string;
  detail?: string;
}

export interface MigrationReport {
  findings: MigrationFinding[];
}

/**
 * Read-only inspection of a harness directory. Returns the list of migrations
 * that would be applied by `applyMigrations`. Idempotent and safe to run on a
 * clean harness.
 */
export function checkMigrations(harnessDir: string): MigrationReport {
  const findings: MigrationFinding[] = [];

  if (existsSync(join(harnessDir, 'CORE.md'))) {
    findings.push({ kind: 'rename-core-to-identity', path: join(harnessDir, 'CORE.md') });
  }

  if (existsSync(join(harnessDir, 'SYSTEM.md'))) {
    findings.push({ kind: 'delete-system-md', path: join(harnessDir, 'SYSTEM.md') });
  }

  if (existsSync(join(harnessDir, 'state.md'))) {
    findings.push({ kind: 'move-state-to-memory', path: join(harnessDir, 'state.md') });
  }

  const skillsDir = join(harnessDir, 'skills');
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      if (statSync(entryPath).isFile() && entry.endsWith('.md')) {
        findings.push({ kind: 'bundle-flat-skill', path: entryPath });
      }
    }
  }

  return { findings };
}

export interface ApplyResult {
  applied: MigrationFinding[];
  skipped: Array<MigrationFinding & { reason: string }>;
  errors: Array<MigrationFinding & { reason: string }>;
}

/**
 * Executes the findings from `checkMigrations` against the harness directory.
 * Each migration is idempotent: if the target state already exists, the step
 * is skipped with a reason instead of overwriting or erroring.
 */
export function applyMigrations(harnessDir: string, report: MigrationReport): ApplyResult {
  const applied: MigrationFinding[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const errors: ApplyResult['errors'] = [];

  for (const finding of report.findings) {
    try {
      switch (finding.kind) {
        case 'rename-core-to-identity': {
          const target = join(harnessDir, 'IDENTITY.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'IDENTITY.md exists; CORE.md left in place' });
            break;
          }
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'delete-system-md': {
          unlinkSync(finding.path);
          applied.push(finding);
          break;
        }
        case 'move-state-to-memory': {
          const target = join(harnessDir, 'memory', 'state.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'memory/state.md exists; top-level state.md left in place' });
            break;
          }
          mkdirSync(dirname(target), { recursive: true });
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'bundle-flat-skill': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const bundleDir = join(dirname(flatPath), baseName);
          if (existsSync(bundleDir)) {
            skipped.push({ ...finding, reason: `${baseName}/ already exists; flat skill left in place` });
            break;
          }
          mkdirSync(bundleDir, { recursive: true });
          renameSync(flatPath, join(bundleDir, 'SKILL.md'));
          applied.push(finding);
          break;
        }
        default: {
          // Exhaustiveness guard — future kinds added in Task 6.3+ will be handled here
          const _exhaustive: never = finding.kind;
          skipped.push({ ...finding, reason: `unknown migration kind: ${_exhaustive}` });
          break;
        }
      }
    } catch (err) {
      errors.push({ ...finding, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { applied, skipped, errors };
}
