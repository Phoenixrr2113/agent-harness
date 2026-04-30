import { existsSync, readdirSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { loadDirectoryWithErrors } from '../primitives/loader.js';
import { fixCapability } from './intake.js';
import { buildLoadedContext } from './context-loader.js';
import { loadConfig } from '../core/config.js';
import { loadState } from './state.js';
import { validateMcpConfig } from './mcp.js';
import { getPrimitiveDirs } from '../core/types.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';
import type { ParseError } from '../primitives/loader.js';

export interface ValidationResult {
  ok: string[];
  warnings: string[];
  errors: string[];
  parseErrors: ParseError[];
  primitiveCounts: Map<string, number>;
  totalPrimitives: number;
}

/**
 * Comprehensive harness validation:
 * - Required/optional files
 * - Config validation
 * - State validation
 * - Primitive loading with parse error collection
 * - Cross-reference integrity (related: fields)
 * - Context budget check with warnings
 * - Memory directory structure
 * - API key presence
 */
export function validateHarness(dir: string): ValidationResult {
  const result: ValidationResult = {
    ok: [],
    warnings: [],
    errors: [],
    parseErrors: [],
    primitiveCounts: new Map(),
    totalPrimitives: 0,
  };

  // --- Required files ---
  // Per spec #1 (v0.9.0): IDENTITY.md replaces CORE.md, SYSTEM.md was deleted
  // (legacy infrastructure docs), state.md moved to memory/state.md.
  const requiredFiles = ['IDENTITY.md'];
  for (const file of requiredFiles) {
    if (existsSync(join(dir, file))) {
      result.ok.push(`${file} exists`);
    } else if (file === 'IDENTITY.md' && existsSync(join(dir, 'CORE.md'))) {
      // Legacy harness with CORE.md — point at the migration tool.
      result.errors.push(
        `Missing required file: IDENTITY.md (found legacy CORE.md — run \`harness doctor --migrate\` to update)`,
      );
    } else {
      result.errors.push(`Missing required file: ${file}`);
    }
  }

  const optionalFiles = ['config.yaml'];
  for (const file of optionalFiles) {
    if (existsSync(join(dir, file))) {
      result.ok.push(`${file} exists`);
    } else {
      result.warnings.push(`Optional file missing: ${file}`);
    }
  }

  // --- memory/state.md (new location) ---
  if (existsSync(join(dir, 'memory', 'state.md'))) {
    result.ok.push('memory/state.md exists');
  } else if (existsSync(join(dir, 'state.md'))) {
    result.warnings.push(
      'state.md found at top level — should be at memory/state.md (run `harness doctor --migrate` to fix)',
    );
  }

  // --- Config validation ---
  let config: HarnessConfig | undefined;
  try {
    config = loadConfig(dir);
    result.ok.push(`Config valid (agent: ${config.agent.name}, model: ${config.model.id})`);
  } catch (err: unknown) {
    result.errors.push(`Config error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- State validation ---
  try {
    const state = loadState(dir);
    result.ok.push(`State valid (mode: ${state.mode})`);
  } catch (err: unknown) {
    result.warnings.push(`State parse issue: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Primitive loading + parse errors ---
  const primitiveDirs = getPrimitiveDirs(config);
  const allDocs: HarnessDocument[] = [];

  for (const primDir of primitiveDirs) {
    const fullPath = join(dir, primDir);
    if (!existsSync(fullPath)) {
      result.primitiveCounts.set(primDir, 0);
      continue;
    }

    const { docs, errors } = loadDirectoryWithErrors(fullPath);
    result.primitiveCounts.set(primDir, docs.length);
    result.totalPrimitives += docs.length;
    allDocs.push(...docs);

    if (errors.length > 0) {
      result.parseErrors.push(...errors);
      for (const pe of errors) {
        const relPath = relative(dir, pe.path);
        result.errors.push(`Parse error in ${relPath}: ${pe.error}`);
      }
    }

    if (docs.length > 0) {
      result.ok.push(`${primDir}/: ${docs.length} valid file(s)`);
    }
  }

  // --- Cross-reference integrity ---
  const knownIds = new Set(allDocs.map((d) => d.id));
  for (const doc of allDocs) {
    const related = doc.related;
    if (!related || related.length === 0) continue;

    for (const ref of related) {
      // Check if reference is a known primitive ID
      if (knownIds.has(ref)) continue;

      // Check if reference is a valid file path
      const refPath = join(dir, ref);
      if (existsSync(refPath)) continue;

      // Check if reference is a file path with .md extension
      if (existsSync(refPath + '.md')) continue;

      const docRel = relative(dir, doc.path);
      result.warnings.push(`Broken reference in ${docRel}: "${ref}" not found (related: field)`);
    }
  }

  // --- Missing description warnings ---
  let missingDescription = 0;
  for (const doc of allDocs) {
    if (!doc.description) missingDescription++;
  }
  if (missingDescription > 0) {
    result.warnings.push(`${missingDescription} primitive(s) missing description`);
  }

  // --- Context budget ---
  if (config) {
    try {
      const ctx = buildLoadedContext(dir, config);
      const usagePercent = ((ctx.budget.used_tokens / ctx.budget.max_tokens) * 100).toFixed(1);
      result.ok.push(
        `Context budget: ${ctx.budget.used_tokens}/${ctx.budget.max_tokens} tokens (${usagePercent}%)`,
      );

      // Surface context-loader warnings
      for (const warning of ctx.warnings) {
        result.warnings.push(warning);
      }
    } catch (err) {
      if (process.env.DEBUG) console.error(`Validator config load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- API key ---
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    const keys: string[] = [];
    if (process.env.OPENROUTER_API_KEY) keys.push('OPENROUTER_API_KEY');
    if (process.env.ANTHROPIC_API_KEY) keys.push('ANTHROPIC_API_KEY');
    if (process.env.OPENAI_API_KEY) keys.push('OPENAI_API_KEY');
    result.ok.push(`API key(s) configured: ${keys.join(', ')}`);
  } else {
    result.warnings.push('No API key set (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)');
  }

  // --- MCP server validation ---
  if (config) {
    const servers = config.mcp?.servers ?? {};
    const serverCount = Object.keys(servers).length;
    if (serverCount > 0) {
      const mcpErrors = validateMcpConfig(config);
      const enabledCount = Object.values(servers).filter((s) => s.enabled !== false).length;

      if (mcpErrors.length === 0) {
        result.ok.push(`MCP: ${serverCount} server(s) configured (${enabledCount} enabled)`);
      } else {
        result.ok.push(`MCP: ${serverCount} server(s) configured (${enabledCount} enabled)`);
        for (const err of mcpErrors) {
          result.errors.push(`MCP server "${err.server}": ${err.error}`);
        }
      }
    }
  }

  // --- Memory directories ---
  const memoryDirs = ['memory', 'memory/sessions', 'memory/journal'];
  for (const memDir of memoryDirs) {
    if (!existsSync(join(dir, memDir))) {
      result.warnings.push(`Missing directory: ${memDir}/`);
    }
  }

  return result;
}

export interface DoctorResult extends ValidationResult {
  fixes: string[];
  directoriesCreated: string[];
}

/**
 * Run validation then auto-fix all fixable issues:
 * - Fix primitives with missing id/status/description/tags
 * - Create missing memory directories
 */
export function doctorHarness(dir: string): DoctorResult {
  // Phase 1: Validate
  const validation = validateHarness(dir);
  const result: DoctorResult = {
    ...validation,
    fixes: [],
    directoriesCreated: [],
  };

  // Phase 2: Create missing directories
  const dirsToCreate = ['memory', 'memory/sessions', 'memory/journal', 'intake'];
  for (const d of dirsToCreate) {
    const fullPath = join(dir, d);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      result.directoriesCreated.push(d);
      result.fixes.push(`Created directory: ${d}/`);
      // Remove the warning about this missing dir
      result.warnings = result.warnings.filter((w) => !w.includes(`Missing directory: ${d}/`));
    }
  }

  // Phase 3: Auto-fix primitives with fixable issues
  const primitiveDirs = getPrimitiveDirs();
  for (const primDir of primitiveDirs) {
    const fullPath = join(dir, primDir);
    if (!existsSync(fullPath)) continue;

    let files: string[];
    try {
      files = readdirSync(fullPath).filter(
        (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'),
      );
    } catch (_readErr) {
      continue;
    }

    for (const file of files) {
      const filePath = join(fullPath, file);
      const fixResult = fixCapability(filePath);

      if (fixResult.fixes_applied.length > 0) {
        const relPath = relative(dir, filePath);
        for (const fix of fixResult.fixes_applied) {
          result.fixes.push(`${relPath}: ${fix}`);
        }
      }
    }
  }

  // Recalculate description warnings after fixes
  if (result.fixes.length > 0) {
    result.warnings = result.warnings.filter(
      (w) => !w.includes('missing description'),
    );
    // Re-check description counts
    let missingDescription = 0;
    for (const primDir of primitiveDirs) {
      const fullPath = join(dir, primDir);
      if (!existsSync(fullPath)) continue;
      const { docs } = loadDirectoryWithErrors(fullPath);
      for (const doc of docs) {
        if (!doc.description) missingDescription++;
      }
    }
    if (missingDescription > 0) {
      result.warnings.push(`${missingDescription} primitive(s) still missing description`);
    }
  }

  return result;
}
