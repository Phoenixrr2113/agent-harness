import { readdirSync, existsSync, statSync, chmodSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives } from '../primitives/loader.js';
import { ALL_SKILL_LINTS, lintRuleFile } from './lints/skill-lints.js';
import { ALL_SCRIPT_LINTS } from './lints/script-lints.js';
import type { LintResult } from './lint-types.js';

/**
 * D4: distinguish actual scripts from templates/assets that happen to live in
 * a `scripts/` directory. Files with executable extensions or a shebang line
 * are scripts; everything else (HTML, JSON, YAML, plain MD, raw data) is a
 * support resource the runtime won't try to spawn.
 */
const SCRIPT_EXTENSIONS = ['.sh', '.py', '.js', '.ts', '.rb', '.pl', '.bash', '.zsh', '.fish'];

function isScriptFile(scriptPath: string, entry: string): boolean {
  const ext = entry.includes('.') ? entry.slice(entry.lastIndexOf('.')).toLowerCase() : '';
  if (SCRIPT_EXTENSIONS.includes(ext)) return true;
  // Files without recognized extensions but with a shebang are also scripts
  try {
    const head = readFileSync(scriptPath, 'utf-8').slice(0, 256);
    if (head.startsWith('#!')) return true;
  } catch {
    // unreadable — treat as non-script
  }
  return false;
}

/**
 * Run all skill and script lints against every skill bundle in harnessDir.
 *
 * - Skill lints (description-quality, body-length, referenced-files-exist,
 *   required-sections) run once per loaded skill.
 * - Script lints (shebang, executable, helpSupported, noInteractive) run once
 *   per file found under the bundle's scripts/ directory.
 *
 * Skills that fail schema validation (and therefore fail to load) are skipped;
 * migration issues are reported separately via checkMigrations.
 */
export async function runLints(harnessDir: string): Promise<LintResult[]> {
  const all: LintResult[] = [];
  const primitives = loadAllPrimitives(harnessDir);
  const skills = primitives.get('skills') ?? [];
  const rules = primitives.get('rules') ?? [];

  for (const skill of skills) {
    const bundleDir = skill.bundleDir ?? '';
    if (!bundleDir) continue;

    for (const lint of ALL_SKILL_LINTS) {
      all.push(...lint(skill, bundleDir));
    }

    const scriptsDir = join(bundleDir, 'scripts');
    if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
      for (const entry of readdirSync(scriptsDir)) {
        const scriptPath = join(scriptsDir, entry);
        if (!statSync(scriptPath).isFile()) continue;
        // D4: only lint files that look like scripts. Templates and assets
        // (HTML, JSON, YAML, MD, plain data) get a free pass even if they
        // happen to live in scripts/.
        if (!isScriptFile(scriptPath, entry)) continue;
        for (const lint of ALL_SCRIPT_LINTS) {
          all.push(...(await lint(scriptPath)));
        }
      }
    }
  }

  // Rules: check for legacy L0/L1 markers (the description-in-frontmatter
  // mandate applies to all primitives, not just skills).
  for (const rule of rules) {
    all.push(...lintRuleFile(rule.path));
  }

  return all;
}

export interface ApplyFixesResult {
  applied: number;
  remaining: LintResult[];
}

/**
 * Apply auto-fixable lints from a runLints result set.
 *
 * Currently only handles NOT_EXECUTABLE (adds user-execute bit). All other
 * findings — including non-fixable ones — are returned in `remaining`.
 *
 * The `harnessDir` argument is unused for the current fix set but is included
 * so callers have a stable signature when additional fix kinds are added.
 */
export async function applyFixes(_harnessDir: string, lints: LintResult[]): Promise<ApplyFixesResult> {
  let applied = 0;
  const remaining: LintResult[] = [];

  for (const r of lints) {
    if (r.fixable && r.code === 'NOT_EXECUTABLE') {
      try {
        const stats = statSync(r.path);
        chmodSync(r.path, stats.mode | 0o755);
        applied++;
      } catch {
        remaining.push(r);
      }
    } else {
      remaining.push(r);
    }
  }

  return { applied, remaining };
}
