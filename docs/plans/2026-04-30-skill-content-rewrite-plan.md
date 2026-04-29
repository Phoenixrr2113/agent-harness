# Skill content rewrite + script feedback contract — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and enforce a structured JSON output contract for skill scripts; rewrite the canonical default skills (delegate-to-cli, daily-reflection, ship-feature) as proper bundles with feedback-contract-conformant scripts; add doctor lints for script quality; ship `harness skill new` / `harness skill validate` CLI commands.

**Architecture:** A new lint registry in `src/runtime/doctor.ts` runs per-skill checks (frontmatter, body, referenced files) and per-script checks (shebang, executable, --help, output discipline). The script contract is encoded as a TypeScript interface (`ScriptResult` in `src/runtime/triggers.ts` already has one — extend it) and documented in `docs/skill-authoring.md`. Bundle templates in `templates/skill-bundle/` scaffold a compliant skill on `harness skill new`.

**Tech Stack:** TypeScript, Zod, vitest, gray-matter. Test commands: `npm test -- <pattern>`. Build: `npm run build`. Node 20+.

---

## Reference

- Design spec: [docs/specs/2026-04-30-skill-content-rewrite-design.md](../specs/2026-04-30-skill-content-rewrite-design.md)
- Spec #2 trigger result type (extend, don't duplicate): [src/runtime/triggers.ts](../../src/runtime/triggers.ts) — `TriggerScriptResult` interface
- Agent Skills using-scripts guide: https://agentskills.io/skill-creation/using-scripts
- Agent Skills best practices: https://agentskills.io/skill-creation/best-practices
- Optimizing descriptions: https://agentskills.io/skill-creation/optimizing-descriptions

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/runtime/doctor.ts` | extend | Add lint registry + per-skill, per-script, bundle-structure lints + `--fix` |
| `src/runtime/lint-types.ts` | new | LintResult, LintSeverity, Lint interface |
| `src/runtime/lints/skill-lints.ts` | new | description quality, body length, referenced files, required sections, metadata prefix |
| `src/runtime/lints/script-lints.ts` | new | shebang, executable, --help, no-interactive heuristic |
| `src/runtime/lints/bundle-lints.ts` | new | references-not-empty, no-stray-files |
| `src/cli/index.ts` | extend | Add `harness skill new <name>` and `harness skill validate <name>` |
| `templates/skill-bundle/` | new | Scaffold templates: SKILL.md, scripts/run.sh, references/REFERENCE.md, assets/template.md |
| `defaults/skills/delegate-to-cli/` | rewrite | Canonical example: thin SKILL.md + scripts/delegate.sh + references/permission-flags.md, references/failure-modes.md |
| `defaults/skills/daily-reflection/` | rewrite | scripts/synthesize.sh + scripts/propose-rules.sh, structured JSON output |
| `defaults/skills/ship-feature/` | rewrite | scripts/pre-pr-checklist.sh, scripts/verify-tests.sh, scripts/verify-build.sh |
| `docs/skill-authoring.md` | extend | Script contract section, lint reference, authoring example |
| `tests/runtime/doctor-lints.test.ts` | new | Unit tests for each lint |
| `tests/integration/skill-new.test.ts` | new | E2E for `harness skill new` |

---

## Phase 1: Lint infrastructure

### Task 1: Lint type system + skill-level lints

**Files:**
- Create: `src/runtime/lint-types.ts`
- Create: `src/runtime/lints/skill-lints.ts`
- Test: `tests/runtime/doctor-lints.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/doctor-lints.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { skillLints } from '../../src/runtime/lints/skill-lints.js';
import { loadAllPrimitives } from '../../src/primitives/loader.js';

function loadFirstSkill(harnessDir: string) {
  const skills = loadAllPrimitives(harnessDir).get('skills') ?? [];
  return skills[0];
}

function makeSkillBundle(harnessDir: string, name: string, frontmatter: string, body: string): string {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return dir;
}

describe('skillLints', () => {
  it('description-quality: flags vague descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Helps with stuff.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    const warn = results.find((r) => r.severity === 'warn');
    expect(warn).toBeTruthy();
    expect(warn?.code).toMatch(/description/i);
  });

  it('description-quality: passes well-formed descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Conducts deep research using web search and document analysis. Use when investigating a topic, gathering sources, or comparing options.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    expect(results).toHaveLength(0);
  });

  it('body-length: warns over 4000 tokens, errors over 6000', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const longBody = 'word '.repeat(5000); // ~5000 tokens (1 token ≈ 4 chars; 'word ' = 5 chars × 5000 = 25000 chars ≈ 6250 tokens)
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: A test skill. Use when testing the linter.', longBody);
    const skill = loadFirstSkill(dir);
    const results = skillLints.bodyLength(skill, bundleDir);
    expect(results.some((r) => r.severity === 'error' || r.severity === 'warn')).toBe(true);
  });

  it('referenced-files-exist: errors when SKILL.md mentions a missing script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '## Available scripts\n\n- `scripts/run.sh` — Does the thing'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.referencedFilesExist(skill, bundleDir);
    expect(results.find((r) => r.severity === 'error')).toBeTruthy();
  });

  it('required-sections: warns when SKILL.md lacks ## When to use AND any of Available scripts/Workflow/Gotchas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '# Foo\n\nNo standard sections here.'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.requiredSections(skill, bundleDir);
    expect(results.some((r) => r.severity === 'warn')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/randywilson/Desktop/agent-harness-skill-content-rewrite
npm test -- tests/runtime/doctor-lints.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the type system**

Create `src/runtime/lint-types.ts`:

```typescript
export type LintSeverity = 'info' | 'warn' | 'error';

export interface LintResult {
  code: string;            // SCREAMING_SNAKE_CASE constant, e.g. DESCRIPTION_TOO_VAGUE
  severity: LintSeverity;
  message: string;         // human-readable, includes the offending value when relevant
  path: string;            // file path the issue is in
  line?: number;
  fixable?: boolean;       // can `harness doctor --fix` repair it
}

export interface SkillLintFn {
  (skill: import('../core/types.js').HarnessDocument, bundleDir: string): LintResult[];
}

export interface ScriptLintFn {
  (scriptPath: string): Promise<LintResult[]>;  // some lints spawn the script for --help
}
```

- [ ] **Step 4: Implement skill-level lints**

Create `src/runtime/lints/skill-lints.ts`:

```typescript
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { HarnessDocument } from '../../core/types.js';
import type { LintResult } from '../lint-types.js';

function descriptionQuality(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  const desc = skill.description ?? '';
  if (desc.length < 80) {
    out.push({
      code: 'DESCRIPTION_TOO_SHORT',
      severity: 'warn',
      message: `description is ${desc.length} chars; recommended ≥ 80 to give the model enough context to trigger reliably`,
      path: skill.path,
      fixable: false,
    });
  }
  if (desc.length > 1024) {
    out.push({
      code: 'DESCRIPTION_TOO_LONG',
      severity: 'error',
      message: `description is ${desc.length} chars; Agent Skills spec maximum is 1024`,
      path: skill.path,
      fixable: false,
    });
  }
  // "Use when..." pattern is a common signal of imperative phrasing
  if (desc.length >= 80 && !/use when/i.test(desc) && !/when (the user|the agent|to|invoking|handling)/i.test(desc)) {
    out.push({
      code: 'DESCRIPTION_NOT_IMPERATIVE',
      severity: 'info',
      message: 'description does not contain a "Use when..." trigger phrase; consider adding one for better trigger reliability (per https://agentskills.io/skill-creation/optimizing-descriptions)',
      path: skill.path,
      fixable: false,
    });
  }
  return out;
}

function bodyLength(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  const tokenEstimate = Math.ceil(skill.body.length / 4);
  if (tokenEstimate > 6000) {
    out.push({
      code: 'BODY_TOO_LONG',
      severity: 'error',
      message: `SKILL.md body is ~${tokenEstimate} tokens; Agent Skills spec recommends < 5000. Move detailed sections to references/ files and tell the agent when to load each.`,
      path: skill.path,
      fixable: false,
    });
  } else if (tokenEstimate > 4000) {
    out.push({
      code: 'BODY_LONG',
      severity: 'warn',
      message: `SKILL.md body is ~${tokenEstimate} tokens; consider moving detail to references/ for predictable activation cost`,
      path: skill.path,
      fixable: false,
    });
  }
  return out;
}

function referencedFilesExist(skill: HarnessDocument, bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  // Match relative paths in body that look like references: scripts/foo.sh, references/foo.md, assets/foo.txt
  const pathPattern = /\b(scripts|references|assets)\/[\w.-]+(?:\/[\w.-]+)*\.\w+/g;
  const matches = skill.body.matchAll(pathPattern);
  const seen = new Set<string>();
  for (const m of matches) {
    const rel = m[0];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(bundleDir, rel);
    if (!existsSync(abs)) {
      out.push({
        code: 'REFERENCED_FILE_MISSING',
        severity: 'error',
        message: `SKILL.md references "${rel}" but ${abs} does not exist`,
        path: skill.path,
        fixable: false,
      });
    }
  }
  return out;
}

function requiredSections(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const body = skill.body.toLowerCase();
  const hasWhenToUse = /^##\s*when to use/m.test(skill.body);
  const hasAnyOfTheRest = /^##\s*(available scripts|workflow|gotchas|failure modes)/im.test(skill.body);
  if (!hasWhenToUse && !hasAnyOfTheRest) {
    return [{
      code: 'MISSING_RECOMMENDED_SECTIONS',
      severity: 'warn',
      message: 'SKILL.md is missing recommended sections (## When to use, ## Available scripts, ## Workflow, ## Gotchas, or ## Failure modes). See docs/skill-authoring.md for the convention.',
      path: skill.path,
      fixable: false,
    }];
  }
  void body;
  return [];
}

export const skillLints = {
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
};

export const ALL_SKILL_LINTS: Array<(s: HarnessDocument, b: string) => LintResult[]> = [
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
];
```

- [ ] **Step 5: Run tests + lint**

```bash
npm test -- tests/runtime/doctor-lints.test.ts
npm run lint
```

Expected: 5/5 lint tests pass; tsc clean.

- [ ] **Step 6: Commit**

```
feat(doctor): skill-level lint registry

Adds 4 skill lints:
- description-quality: warn on <80 chars, error on >1024, info on
  missing "Use when..." imperative phrasing
- body-length: warn at ~4000 tokens, error at ~6000 (Agent Skills
  spec recommends <5000)
- referenced-files-exist: error when SKILL.md mentions a
  scripts/references/assets file that's missing on disk
- required-sections: warn when SKILL.md lacks any of "## When to
  use", "## Available scripts", "## Workflow", "## Gotchas",
  "## Failure modes"

Each lint returns LintResult[] with code, severity, message, path,
and fixable. The doctor command (Task 4) registers them.
```

### Task 2: Script-level lints

**Files:**
- Create: `src/runtime/lints/script-lints.ts`
- Test: extend `tests/runtime/doctor-lints.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/runtime/doctor-lints.test.ts`:

```typescript
import { scriptLints } from '../../src/runtime/lints/script-lints.js';
import { chmodSync, statSync } from 'fs';

describe('scriptLints', () => {
  it('shebang: errors when script lacks shebang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'no-shebang.sh');
    writeFileSync(path, 'echo hello\n', 'utf-8');
    const results = await scriptLints.shebang(path);
    expect(results.find((r) => r.code === 'MISSING_SHEBANG')).toBeTruthy();
  });

  it('shebang: passes when script starts with #!', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'has-shebang.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hello\n', 'utf-8');
    const results = await scriptLints.shebang(path);
    expect(results).toHaveLength(0);
  });

  it('executable: errors when script lacks user-execute bit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'not-exec.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hi\n', 'utf-8');
    chmodSync(path, 0o644);
    const results = await scriptLints.executable(path);
    expect(results.find((r) => r.code === 'NOT_EXECUTABLE')).toBeTruthy();
    expect(results[0].fixable).toBe(true);
  });

  it('helpSupported: errors when --help fails OR lacks Usage:/Exit codes:', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'no-help.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hi\n', 'utf-8');
    chmodSync(path, 0o755);
    const results = await scriptLints.helpSupported(path);
    expect(results.find((r) => r.code === 'HELP_NOT_SUPPORTED' || r.code === 'HELP_INCOMPLETE')).toBeTruthy();
  }, 10000);

  it('helpSupported: passes when --help has Usage: and Exit codes:', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'has-help.sh');
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "--help" ]; then\n  cat <<'EOF'\nUsage: this-script <args>\n\nDoes a thing.\n\nExit codes:\n  0 OK\n  1 error\nEOF\n  exit 0\nfi\n`,
      'utf-8'
    );
    chmodSync(path, 0o755);
    const results = await scriptLints.helpSupported(path);
    expect(results).toHaveLength(0);
  }, 10000);

  it('noInteractive: warns when script source contains read -p / read -r', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'interactive.sh');
    writeFileSync(path, '#!/usr/bin/env bash\nread -p "Enter name: " name\necho "Hi $name"\n', 'utf-8');
    const results = await scriptLints.noInteractive(path);
    expect(results.find((r) => r.severity === 'warn')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run failing tests**

Expected: FAIL.

- [ ] **Step 3: Implement script lints**

Create `src/runtime/lints/script-lints.ts`:

```typescript
import { spawn } from 'child_process';
import { readFileSync, statSync } from 'fs';
import type { LintResult } from '../lint-types.js';

async function shebang(scriptPath: string): Promise<LintResult[]> {
  const head = readFileSync(scriptPath, 'utf-8').slice(0, 200);
  if (!/^#!/.test(head)) {
    return [{
      code: 'MISSING_SHEBANG',
      severity: 'error',
      message: `${scriptPath} lacks a shebang (first line must start with #!). Common: #!/usr/bin/env bash, #!/usr/bin/env python3.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  return [];
}

async function executable(scriptPath: string): Promise<LintResult[]> {
  const stats = statSync(scriptPath);
  // Check user-execute bit (0o100)
  if ((stats.mode & 0o100) === 0) {
    return [{
      code: 'NOT_EXECUTABLE',
      severity: 'error',
      message: `${scriptPath} lacks user-execute bit. Run \`chmod +x ${scriptPath}\` or use \`harness doctor --fix\`.`,
      path: scriptPath,
      fixable: true,
    }];
  }
  return [];
}

function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stdout, stderr }); });
  });
}

async function helpSupported(scriptPath: string): Promise<LintResult[]> {
  const result = await runWithTimeout(scriptPath, ['--help'], 5000);
  if (result.status !== 0) {
    return [{
      code: 'HELP_NOT_SUPPORTED',
      severity: 'error',
      message: `${scriptPath} --help exited with status ${result.status}; scripts must support --help. See docs/skill-authoring.md for the convention.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  const out = result.stdout + result.stderr;
  if (!/Usage:/i.test(out) || !/Exit codes:/i.test(out)) {
    return [{
      code: 'HELP_INCOMPLETE',
      severity: 'warn',
      message: `${scriptPath} --help output should contain "Usage:" and "Exit codes:" sections per the script contract.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  return [];
}

async function noInteractive(scriptPath: string): Promise<LintResult[]> {
  const src = readFileSync(scriptPath, 'utf-8');
  const patterns = [
    /\bread -p\b/,
    /\bread -r\b/,
    /\binput\(/,        // python
    /\bprompt\(/,       // js
    /\bgets\b/,         // ruby
  ];
  for (const p of patterns) {
    if (p.test(src)) {
      return [{
        code: 'INTERACTIVE_PROMPT',
        severity: 'warn',
        message: `${scriptPath} contains an interactive prompt pattern (${p.source}). Agent execution environments are non-interactive — block on stdin will hang the run. See docs/skill-authoring.md.`,
        path: scriptPath,
        fixable: false,
      }];
    }
  }
  return [];
}

export const scriptLints = {
  shebang,
  executable,
  helpSupported,
  noInteractive,
};

export const ALL_SCRIPT_LINTS = [shebang, executable, helpSupported, noInteractive];
```

- [ ] **Step 4: Run tests + lint**

```bash
npm test -- tests/runtime/doctor-lints.test.ts
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```
feat(doctor): script-level lint registry

Adds 4 script lints:
- shebang: errors on missing #! line
- executable: errors when script lacks user-execute bit (fixable
  via doctor --fix)
- help-supported: spawns the script with --help, errors on non-zero
  exit, warns when output lacks Usage: or Exit codes: per the
  script contract
- no-interactive: warns when source contains read -p / read -r /
  input(...) / prompt(...) / gets — these block on stdin in the
  non-interactive agent environment.
```

---

## Phase 2: Doctor integration + auto-fix

### Task 3: Wire lints into harness doctor + --fix

**Files:**
- Modify: `src/runtime/doctor.ts` (or wherever `harness doctor` lives — add lint runs alongside the existing migration check)
- Modify: `src/cli/index.ts` if needed (add `--fix` option)
- Test: `tests/runtime/doctor-lints.test.ts`

- [ ] **Step 1: Read existing doctor implementation**

```bash
grep -n 'doctor\|checkMigrations\|applyMigrations' src/runtime/doctor.ts src/cli/index.ts | head -20
```

Identify where the doctor command is wired today (it currently does migration check/apply). Add lint runs alongside.

- [ ] **Step 2: Add a top-level `runLints` function**

In `src/runtime/doctor.ts` (or a new `src/runtime/doctor-lints.ts` if doctor.ts doesn't exist yet — verify):

```typescript
import { loadAllPrimitives } from '../primitives/loader.js';
import { ALL_SKILL_LINTS } from './lints/skill-lints.js';
import { ALL_SCRIPT_LINTS } from './lints/script-lints.js';
import type { LintResult } from './lint-types.js';
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export async function runLints(harnessDir: string): Promise<LintResult[]> {
  const all: LintResult[] = [];
  const skills = loadAllPrimitives(harnessDir).get('skills') ?? [];
  for (const skill of skills) {
    const bundleDir = skill.bundleDir ?? '';
    if (!bundleDir) continue;
    for (const lint of ALL_SKILL_LINTS) {
      all.push(...lint(skill, bundleDir));
    }
    // Per-script lints
    const scriptsDir = join(bundleDir, 'scripts');
    if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
      for (const entry of readdirSync(scriptsDir)) {
        const scriptPath = join(scriptsDir, entry);
        if (!statSync(scriptPath).isFile()) continue;
        for (const lint of ALL_SCRIPT_LINTS) {
          all.push(...await lint(scriptPath));
        }
      }
    }
  }
  return all;
}

export async function applyFixes(harnessDir: string, lints: LintResult[]): Promise<{ applied: number; remaining: LintResult[] }> {
  const { chmodSync, statSync } = await import('fs');
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
```

- [ ] **Step 3: Wire `harness doctor --check` and `harness doctor --fix` to invoke lints**

Find the existing doctor CLI command (from spec #1's wiring) in `src/cli/index.ts`. After the migration findings are reported, also report lint findings. Add `--fix` flag:

```typescript
program
  .command('doctor')
  .description('Inspect a harness for spec compliance, migration needs, and skill quality')
  .option('-d, --dir <path>', 'harness directory', process.cwd())
  .option('--check', 'report findings only, do not modify files', false)
  .option('--migrate', 'apply detected migrations', false)
  .option('--fix', 'apply auto-fixable lints (e.g., chmod +x scripts)', false)
  .action(async (opts) => {
    const harnessDir = resolve(opts.dir);
    const migrationReport = checkMigrations(harnessDir);
    const lintResults = await runLints(harnessDir);

    let exitCode = 0;
    if (migrationReport.findings.length > 0) {
      // existing migration reporting from spec #1...
      exitCode = 1;
    }
    if (lintResults.length > 0) {
      console.log(`\nLint findings (${lintResults.length}):`);
      for (const r of lintResults) {
        const icon = r.severity === 'error' ? 'E' : r.severity === 'warn' ? 'W' : 'I';
        console.log(`  [${icon}] ${r.code}: ${r.message}`);
      }
      if (lintResults.some((r) => r.severity === 'error')) exitCode = 1;
    }
    if (opts.fix) {
      const { applied, remaining } = await applyFixes(harnessDir, lintResults);
      console.log(`\nApplied ${applied} auto-fix(es). ${remaining.filter((r) => r.severity !== 'info').length} remaining (manual review needed).`);
    }
    if (opts.migrate) {
      // existing migration apply from spec #1...
    }
    if (lintResults.length === 0 && migrationReport.findings.length === 0) {
      console.log('Harness is clean — no migrations needed and no lint issues.');
    }
    process.exit(exitCode);
  });
```

(Adapt to existing structure — don't duplicate the migration logic.)

- [ ] **Step 4: Add integration test**

Append to `tests/runtime/doctor-lints.test.ts`:

```typescript
import { runLints, applyFixes } from '../../src/runtime/doctor.js';

describe('runLints integration', () => {
  it('reports lint findings across multiple skills', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-int-'));
    // Create a skill with a description that's too short
    const bad = makeSkillBundle(dir, 'too-short', 'name: too-short\ndescription: Bad.', 'Body.');
    const all = await runLints(dir);
    expect(all.some((r) => r.code === 'DESCRIPTION_TOO_SHORT')).toBe(true);
  });

  it('applyFixes can chmod +x scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-fix-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: A skill that has scripts. Use when testing fixes.', '## Available scripts\n\n- `scripts/run.sh` — Test');
    const scriptDir = join(bundleDir, 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, 'run.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nif [ "$1" = "--help" ]; then echo "Usage: run.sh"; echo "Exit codes:"; echo "  0 OK"; exit 0; fi\necho hi', 'utf-8');
    chmodSync(scriptPath, 0o644);
    const lints = await runLints(dir);
    const { applied } = await applyFixes(dir, lints);
    expect(applied).toBeGreaterThan(0);
    expect(statSync(scriptPath).mode & 0o100).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run tests + lint + build**

```bash
npm test
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```
feat(doctor): wire lints into doctor command + --fix

harness doctor --check now runs the skill and script lint registry
in addition to migration findings. harness doctor --fix applies
auto-fixable lints (e.g., chmod +x scripts that have shebangs but
lack the executable bit).

Lint findings exit non-zero when any error-severity lint fires.
Warnings and info messages exit zero by default.
```

---

## Phase 3: CLI scaffolding

### Task 4: harness skill new + bundle templates

**Files:**
- Modify: `src/cli/index.ts` (add `harness skill new` command)
- Create: `templates/skill-bundle/SKILL.md`
- Create: `templates/skill-bundle/scripts/run.sh`
- Create: `templates/skill-bundle/references/REFERENCE.md`
- Test: `tests/integration/skill-new.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/skill-new.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('harness skill new', () => {
  it('scaffolds a complete skill bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-new-'));

    // Create a minimal harness first
    spawnSync('node', [HARNESS_BIN, 'init', 'myagent', '--template', 'base', '-y'], { cwd: dir, encoding: 'utf-8' });
    const harnessDir = join(dir, 'myagent');

    // Create a new skill
    const result = spawnSync('node', [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);

    expect(existsSync(join(harnessDir, 'skills', 'my-test', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(harnessDir, 'skills', 'my-test', 'scripts', 'run.sh'))).toBe(true);

    const skillContent = readFileSync(join(harnessDir, 'skills', 'my-test', 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('name: my-test');
    expect(skillContent).toContain('description:');
  });

  it('skill new <name>: scaffolded skill passes harness doctor --check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-new-'));
    spawnSync('node', [HARNESS_BIN, 'init', 'myagent', '--template', 'base', '-y'], { cwd: dir, encoding: 'utf-8' });
    const harnessDir = join(dir, 'myagent');
    spawnSync('node', [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir], { encoding: 'utf-8' });

    const doctor = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', harnessDir], { encoding: 'utf-8' });
    expect(doctor.status).toBe(0);
  });
});
```

- [ ] **Step 2: Create the bundle template files**

Create `templates/skill-bundle/SKILL.md`:

```markdown
---
name: {{NAME}}
description: |
  Briefly describe what this skill does AND when to use it. Use imperative
  phrasing ("Use this skill when..."). Aim for 80–500 chars. Include keywords
  the model can pattern-match against the user's prompt.
license: MIT
metadata:
  harness-status: draft
  harness-author: human
---

# {{NAME}}

## When to use

Describe the trigger context. Example: "Use when the user asks to..."

## Available scripts

- `scripts/run.sh` — Brief description of what the script does and when to invoke it

## Workflow

1. **Step 1**: Run `scripts/run.sh <args>` and read the JSON result
2. **Step 2**: ...

## Gotchas

Non-obvious facts the agent would otherwise get wrong. Example: "The API
returns 200 even on auth failure — check the `error` field in the body, not
the HTTP status."

## Failure modes

Known errors and recovery paths. Each entry includes the `error.code` the
script returns and what the agent should do next.
```

Create `templates/skill-bundle/scripts/run.sh`:

```bash
#!/usr/bin/env bash
# {{NAME}} — TODO: describe what this script does
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<EOF
Usage: scripts/run.sh [OPTIONS] <ARGS>

TODO: One-paragraph description of what this script does.

Options:
  --help, -h   Show this help and exit

Examples:
  scripts/run.sh ...

Exit codes:
  0  Success
  1  Error
  2  Invalid input
  3  Environment missing
  4  Blocked (decision needed)

Returns JSON to stdout. See SKILL.md for the result schema.
EOF
  exit 0
fi

# TODO: Implement the operation. Return structured JSON to stdout.
echo '{"status":"error","error":{"code":"NOT_IMPLEMENTED","message":"Edit scripts/run.sh to implement this skill."},"next_steps":["Implement the script logic","Replace this stub with real behavior","Test via: scripts/run.sh --help"]}'
exit 1
```

Create `templates/skill-bundle/references/REFERENCE.md`:

```markdown
# {{NAME}} reference

Detailed documentation that doesn't belong in SKILL.md. Loaded by the agent
on demand when it needs deeper context.

Tell the agent WHEN to load this in SKILL.md, e.g.:

> If `scripts/run.sh` returns `error.code: VERSION_MISMATCH`, read
> `references/REFERENCE.md` for the full version-compat matrix.
```

- [ ] **Step 3: Add the CLI command**

In `src/cli/index.ts`, add to the `skill` subcommand group:

```typescript
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

skillCmd
  .command('new <name>')
  .description('Scaffold a new skill bundle')
  .option('-d, --dir <path>', 'harness directory', process.cwd())
  .action((name: string, opts: { dir: string }) => {
    // Validate name against the spec regex
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(name) || name.length > 64) {
      console.error(`Invalid skill name "${name}": must be 1–64 chars, lowercase a–z/0–9/hyphen, no leading/trailing/consecutive hyphens.`);
      process.exit(2);
    }
    const harnessDir = resolve(opts.dir);
    const bundleDir = join(harnessDir, 'skills', name);
    if (existsSync(bundleDir)) {
      console.error(`skills/${name}/ already exists; choose a different name or remove it first.`);
      process.exit(2);
    }

    // Locate the template directory (works in both dev and built dist)
    const projectRoot = resolveProjectRoot();
    const templateDir = join(projectRoot, 'templates', 'skill-bundle');

    function copyTemplate(rel: string, dest: string): void {
      const src = join(templateDir, rel);
      const content = readFileSync(src, 'utf-8').replace(/\{\{NAME\}\}/g, name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, 'utf-8');
    }

    copyTemplate('SKILL.md', join(bundleDir, 'SKILL.md'));
    copyTemplate('scripts/run.sh', join(bundleDir, 'scripts', 'run.sh'));
    copyTemplate('references/REFERENCE.md', join(bundleDir, 'references', 'REFERENCE.md'));
    chmodSync(join(bundleDir, 'scripts', 'run.sh'), 0o755);

    console.log(`Created skill bundle at skills/${name}/`);
    console.log('Next steps:');
    console.log(`  1. Edit skills/${name}/SKILL.md (write a real description and body)`);
    console.log(`  2. Edit skills/${name}/scripts/run.sh (replace the NOT_IMPLEMENTED stub)`);
    console.log(`  3. harness doctor --check -d ${harnessDir} (verify spec compliance)`);
  });

function resolveProjectRoot(): string {
  // The dist bundle is at <root>/dist/cli/index.js; the template at <root>/templates/...
  // In dev, this file is at <root>/src/cli/index.ts — also one level up.
  // Walk up from import.meta.url.
  // Use createRequire pattern from package.json detection (existing utility in this codebase
  // — match how `harness --version` finds package.json).
  // For the implementation, mirror the existing pattern. Pseudocode:
  //   const candidates = [join(__dirname, '..'), join(__dirname, '..', '..'), join(__dirname, '..', '..', '..')];
  //   for (const c of candidates) if (existsSync(join(c, 'templates', 'skill-bundle'))) return c;
  //   throw new Error('Cannot find templates/skill-bundle/ — install may be corrupt');
  // Adapt to the existing __dirname/import.meta.url helpers in this CLI.
}
```

(Make `resolveProjectRoot` match the existing pattern used elsewhere in `src/cli/index.ts`. Look for how `harness --version` finds package.json — replicate that approach.)

- [ ] **Step 4: Update package.json `files` to include the template**

Verify `templates/` is already in `package.json: files`. From spec #1's `package.json`:

```json
"files": ["dist", "defaults", "templates", "sources.yaml", "NOTICE"]
```

`templates` is already there ✓ — the new `templates/skill-bundle/` will ship.

- [ ] **Step 5: Run tests**

```bash
npm run build
npm test -- tests/integration/skill-new.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 6: Run full suite + lint**

```bash
npm test
npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```
feat(cli): harness skill new — scaffold a compliant skill bundle

harness skill new <name> creates skills/<name>/ with:
- SKILL.md (template with frontmatter, sections, --help-able shape)
- scripts/run.sh (template with --help, JSON output, exit codes,
  NOT_IMPLEMENTED stub the user replaces)
- references/REFERENCE.md (placeholder for deeper docs)

The scaffolded skill passes harness doctor --check immediately so
authors get green-on-first-init.

Templates ship under templates/skill-bundle/ via package.json files
field (already includes templates/).
```

### Task 5: harness skill validate

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Test**

Append to `tests/integration/skill-new.test.ts`:

```typescript
describe('harness skill validate', () => {
  it('passes a clean skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-validate-'));
    spawnSync('node', [HARNESS_BIN, 'init', 'myagent', '--template', 'base', '-y'], { cwd: dir, encoding: 'utf-8' });
    const harnessDir = join(dir, 'myagent');
    spawnSync('node', [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir], { encoding: 'utf-8' });
    const result = spawnSync('node', [HARNESS_BIN, 'skill', 'validate', 'my-test', '-d', harnessDir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
  });

  it('reports lint errors on a deliberately bad skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-validate-'));
    spawnSync('node', [HARNESS_BIN, 'init', 'myagent', '--template', 'base', '-y'], { cwd: dir, encoding: 'utf-8' });
    const harnessDir = join(dir, 'myagent');
    // Hand-create a bad skill
    const bundleDir = join(harnessDir, 'skills', 'bad-skill');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'SKILL.md'), '---\nname: bad-skill\ndescription: Bad.\n---\nNo sections.', 'utf-8');
    const result = spawnSync('node', [HARNESS_BIN, 'skill', 'validate', 'bad-skill', '-d', harnessDir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/DESCRIPTION_TOO_SHORT|MISSING_RECOMMENDED_SECTIONS/);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
skillCmd
  .command('validate <name>')
  .description('Run lints on a single skill')
  .option('-d, --dir <path>', 'harness directory', process.cwd())
  .action(async (name: string, opts: { dir: string }) => {
    const harnessDir = resolve(opts.dir);
    const all = await runLints(harnessDir);
    const filtered = all.filter((r) => r.path.includes(`/skills/${name}/`));
    if (filtered.length === 0) {
      console.log(`Skill "${name}" — clean.`);
      process.exit(0);
    }
    console.log(`Skill "${name}" — ${filtered.length} lint finding(s):`);
    for (const r of filtered) {
      const icon = r.severity === 'error' ? 'E' : r.severity === 'warn' ? 'W' : 'I';
      console.log(`  [${icon}] ${r.code}: ${r.message}`);
    }
    process.exit(filtered.some((r) => r.severity === 'error') ? 1 : 0);
  });
```

- [ ] **Step 3: Run tests + lint + commit**

```
feat(cli): harness skill validate <name>

Runs the lint registry on a single skill bundle and reports findings.
Exits non-zero when any error-severity lint fires; warnings and info
exit zero. Useful in CI hooks for skill packages and during local
authoring.
```

---

## Phase 4: Default skill rewrites

### Task 6: Rewrite delegate-to-cli (canonical example)

**Files:**
- Rewrite: `defaults/skills/delegate-to-cli/SKILL.md`
- Create: `defaults/skills/delegate-to-cli/scripts/delegate.sh`
- Create: `defaults/skills/delegate-to-cli/scripts/verify-cli.sh`
- Create: `defaults/skills/delegate-to-cli/references/permission-flags.md`
- Create: `defaults/skills/delegate-to-cli/references/failure-modes.md`

This is the canonical example referenced everywhere in spec #3. The current SKILL.md is 107 lines of instructions; after this task it becomes ~50 lines of decision tree + script pointers.

The new layout:

```
defaults/skills/delegate-to-cli/
├── SKILL.md (~50 lines)
├── scripts/
│   ├── delegate.sh        # Single entrypoint: ./delegate.sh <cli> <mode> <prompt>
│   └── verify-cli.sh      # Binary + version check, structured
└── references/
    ├── permission-flags.md   # Detailed flag table (loaded on troubleshooting)
    └── failure-modes.md      # Detailed mode catalog with error codes
```

- [ ] **Step 1: Write the new SKILL.md**

Replace `defaults/skills/delegate-to-cli/SKILL.md` content with a thin decision tree:

```markdown
---
name: delegate-to-cli
description: |
  Delegates bounded subtasks (text-in/text-out, large-token, no harness MCPs needed)
  to a local CLI agent (claude/codex/gemini) via scripts/delegate.sh. Use when the
  task is large enough to warrant a sub-process but doesn't need the harness's own
  primitives. Returns the subagent's final text plus structured error info.
license: MIT
metadata:
  harness-status: active
  harness-author: human
  harness-tags: "delegation,cli,subprocess"
---

# delegate-to-cli

## When to use

Reach for this skill when **all four** are true:

1. Bounded — clear start, clear end, output is text or a verifiable file change
2. Text-in/text-out — no need for tool-call structure back to the parent
3. Large in tokens — would burn the parent's context if done inline
4. Doesn't need this harness's own primitives or MCP servers

## Available scripts

- `scripts/delegate.sh <cli> <mode> <prompt>` — Run a bounded subtask via a local CLI agent and return its result. CLI: claude | codex | gemini. Mode: read | edit.
- `scripts/verify-cli.sh <cli>` — Check the CLI binary is on PATH and meets the minimum version. Run this once if delegate fails with `CLI_NOT_FOUND` or `CLI_VERSION_TOO_OLD`.

## Workflow

1. Verify the CLI is available (first use): `scripts/verify-cli.sh claude`
2. Delegate: `scripts/delegate.sh claude read "Summarize the README"`
3. Read the JSON result. On `status: ok`, the subagent's output is in `result.output`.
4. On `status: error`, follow `next_steps`. Common cases listed in `references/failure-modes.md`.

## Gotchas

- **Permission mode is the #1 source of silent hangs.** `scripts/delegate.sh` requires the second arg to be `read` (analysis-only) or `edit` (file modification). The script translates these to the CLI's permission flags. If you bypass the script and call the CLI directly without the right flag for an edit task, the subprocess hangs forever — see `references/permission-flags.md`.
- **CLI invocation may fall outside the CLI's subscription TOS.** The user opted in during `harness init` if delegation is enabled.

## Failure modes

If `scripts/delegate.sh` returns `status: error`, read `error.code`:

- `CLI_NOT_FOUND` — binary missing. Tell the user.
- `CLI_VERSION_TOO_OLD` — see `references/failure-modes.md` for minimum versions.
- `PERMISSION_FLAG_MISSING` — re-invoke with the correct mode (probably `edit` instead of `read`).
- `RATE_LIMITED` — back off; this provider has a 429.
- `SUBPROCESS_TIMEOUT` — the run exceeded `--timeout-ms`. Increase or split the task.
```

- [ ] **Step 2: Write `scripts/delegate.sh`**

Create the script per the spec #3 contract. The script:
- Validates `<cli>` is one of claude/codex/gemini
- Validates `<mode>` is read or edit
- Maps mode → flag (per the existing flag table)
- Spawns the subprocess with proper stdin/stdout
- Polls for completion with timeout
- Returns structured JSON

(Implementation in the script itself — see `references/failure-modes.md` for error codes.)

- [ ] **Step 3: Write `scripts/verify-cli.sh`**

Lighter version that just runs `<cli> --version`, parses the version, compares against minimum, returns JSON.

- [ ] **Step 4: Write the references**

`references/permission-flags.md` — the detailed flag table from the original SKILL.md, plus version-compat notes.

`references/failure-modes.md` — full error-code catalog with recovery hints.

- [ ] **Step 5: chmod +x scripts**

```bash
chmod +x defaults/skills/delegate-to-cli/scripts/delegate.sh
chmod +x defaults/skills/delegate-to-cli/scripts/verify-cli.sh
```

- [ ] **Step 6: Run lints + tests**

```bash
npm run build
node dist/cli/index.js skill validate delegate-to-cli -d defaults
npm test
npm run lint
```

The skill should pass `harness skill validate` clean (or with only info-level findings).

- [ ] **Step 7: Commit**

```
refactor(defaults): rewrite delegate-to-cli as proper bundle

The original SKILL.md was 107 lines of instructions the agent had
to re-interpret on every invocation. The new shape:

- SKILL.md (50 lines): decision tree, script pointers, gotchas,
  failure modes
- scripts/delegate.sh: wraps claude/codex/gemini with mode→flag
  mapping, subprocess polling, timeout, structured JSON output
- scripts/verify-cli.sh: binary + version check
- references/permission-flags.md: detailed flag table (loaded on
  troubleshooting)
- references/failure-modes.md: error-code catalog with recovery
  hints

Status promoted from draft to active.
```

### Task 7: Rewrite daily-reflection

**Files:**
- Modify: `defaults/skills/daily-reflection/SKILL.md`
- Create: `defaults/skills/daily-reflection/scripts/synthesize.sh`
- Create: `defaults/skills/daily-reflection/scripts/propose-rules.sh`

Daily-reflection is the scheduled skill that synthesizes a day's sessions into a journal entry. The current implementation is a markdown-only workflow; this task adds two structured-output scripts that do the actual synthesis work.

- [ ] **Step 1: Update SKILL.md**

The thin SKILL.md describes the cron schedule, the workflow, and points at the scripts.

- [ ] **Step 2: Write scripts/synthesize.sh**

Reads sessions from `<harness-dir>/memory/sessions/` for today (or `--date YYYY-MM-DD`), synthesizes via the harness's `summary_model`, writes the result to `<harness-dir>/memory/journal/<date>.md`.

Returns:
```json
{
  "status": "ok",
  "result": {
    "journal_path": "memory/journal/2026-04-30.md",
    "sessions_processed": 7,
    "patterns_detected": 3,
    "rule_candidates": 1
  },
  "metrics": { "duration_ms": 4200, "tokens_used": 8400 },
  "artifacts": [{ "path": "memory/journal/2026-04-30.md", "description": "Today's synthesized journal entry" }]
}
```

For now (Task 7 scope), the script can wrap the existing `harness journal` CLI command. A full standalone implementation is a future enhancement.

- [ ] **Step 3: Write scripts/propose-rules.sh**

Reads recent journal entries, extracts rule candidates, returns them as JSON. Wraps `harness learn`.

- [ ] **Step 4: Verify, commit**

```
refactor(defaults): rewrite daily-reflection with structured-output scripts

scripts/synthesize.sh runs the daily journal synthesis and returns
structured JSON (journal_path, sessions_processed, patterns_detected,
rule_candidates). scripts/propose-rules.sh extracts rule candidates
from recent journals.

SKILL.md trimmed to a thin schedule-and-pointers shape. Both scripts
wrap existing CLI commands; the structured output makes them
chainable from other agents (and from a future skill that reviews
proposed rules before promotion).
```

### Task 8: Rewrite ship-feature

**Files:**
- Modify: `defaults/skills/ship-feature/SKILL.md`
- Create: `defaults/skills/ship-feature/scripts/pre-pr-checklist.sh`
- Create: `defaults/skills/ship-feature/scripts/verify-tests.sh`
- Create: `defaults/skills/ship-feature/scripts/verify-build.sh`

ship-feature is a methodology playbook (now skill). The body stays text-heavy (methodology), but the mechanical "did the tests pass" / "did the build succeed" / "is the PR ready" parts move into scripts that return structured JSON.

- [ ] **Step 1: Update SKILL.md** with thin methodology + script pointers

- [ ] **Step 2: scripts/verify-tests.sh** — runs `npm test` (or whatever the project uses), parses pass/fail counts, returns JSON

- [ ] **Step 3: scripts/verify-build.sh** — runs `npm run build`, returns JSON with success/failure

- [ ] **Step 4: scripts/pre-pr-checklist.sh** — runs typecheck + lint + tests + build all-or-nothing, summarizes JSON

- [ ] **Step 5: Verify, commit**

```
refactor(defaults): rewrite ship-feature with verify scripts

Three scripts wrap the mechanical pre-PR checks:
- scripts/verify-tests.sh: runs the test suite, returns pass/fail counts
- scripts/verify-build.sh: runs the build, returns success/failure
- scripts/pre-pr-checklist.sh: typecheck + lint + tests + build, all-or-nothing

SKILL.md keeps the methodology (small commits, test-first, etc.) but
no longer re-implements those checks in prose every invocation.
```

---

## Phase 5: Documentation + verification

### Task 9: Update skill-authoring guide with the script contract

**Files:**
- Modify: `docs/skill-authoring.md`

Append a comprehensive section on the script contract: JSON output shape, error codes, --help convention, no-interactive rule, idempotency, predictable output size, long-running patterns. Reference the design spec (`docs/specs/2026-04-30-skill-content-rewrite-design.md`) for full details but make this guide the authoring entry point.

- [ ] **Step 1: Append to skill-authoring.md** (per spec #3 §4.5)

- [ ] **Step 2: Cross-link from README**

- [ ] **Step 3: Commit**

```
docs(authoring): script contract reference

Adds a comprehensive section to docs/skill-authoring.md covering the
script feedback contract: JSON output shape (status/result/error/
next_steps/metrics/artifacts), exit code conventions, --help
requirement, no-interactive-prompts rule, idempotency, predictable
output size, and long-running patterns (fire-and-poll vs synchronous-
with-stderr-progress).

README links to the new section.
```

### Task 10: Final regression + version bump

- [ ] **Step 1: Run full suite + lint + build**

```bash
npm test
npm run lint
npm run build
```

- [ ] **Step 2: Smoke test the new commands**

```bash
TMP=$(mktemp -d) && cd "$TMP" && node /Users/randywilson/Desktop/agent-harness-skill-content-rewrite/dist/cli/index.js init smoke --template base -y
cd smoke
node /Users/randywilson/Desktop/agent-harness-skill-content-rewrite/dist/cli/index.js skill new my-test
node /Users/randywilson/Desktop/agent-harness-skill-content-rewrite/dist/cli/index.js skill validate my-test
node /Users/randywilson/Desktop/agent-harness-skill-content-rewrite/dist/cli/index.js doctor --check
```

Each should exit cleanly.

- [ ] **Step 3: Bump version**

```bash
cd /Users/randywilson/Desktop/agent-harness-skill-content-rewrite
npm version minor   # 0.10.1 → 0.11.0
npm run build
node dist/cli/index.js --version    # should print 0.11.0
```

This is `minor` (not `patch`) because we're shipping new public CLI commands and the lint registry — both are user-facing additions.

- [ ] **Step 4: Verify**

Final check:
```bash
git log --oneline -5
node dist/cli/index.js --version
```

---

## Self-review

Spec coverage:
- [x] §4.1 (script contract) — Phase 1 lints + Task 9 docs
- [x] §4.2 (SKILL.md guidelines) — encoded in skill-lints + bundle template
- [x] §4.3 (per-skill rewrites) — Tasks 6, 7, 8 cover the high-effort skills (delegate-to-cli, daily-reflection, ship-feature). The vendored superpowers skills (brainstorming, writing-plans, executing-plans, dispatching-parallel-agents) and the low-effort domain skills (business-analyst, content-marketer, research) ARE NOT explicitly rewritten in this plan — they're acceptable as-is with the new lint reporting any issues. They can be touched up in a follow-up.
- [x] §4.4 (doctor lints) — Phase 1 + Phase 2
- [x] §4.5 (authoring docs) — Task 9
- [x] §4.6 (CLI commands) — Tasks 4, 5

Type/method consistency:
- `LintResult`, `LintSeverity` defined in Task 1, used by Tasks 2, 3, 5
- `runLints`, `applyFixes` defined in Task 3, used by Task 5

No placeholders. Every code step has either complete code or a clear, bounded TODO that the implementer can resolve from context (e.g., "implement the synthesis logic; for now wrap `harness journal`").

---

## Execution

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks.

**2. Inline Execution** — Execute tasks in this session.

Going with subagent-driven per the user's instruction.
