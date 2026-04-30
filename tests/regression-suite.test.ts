import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

const REPO_ROOT = join(__dirname, '..');
const DEFAULTS_RULES = join(REPO_ROOT, 'defaults/rules');
const DEFAULTS_SKILLS = join(REPO_ROOT, 'defaults/skills');
const TEMPLATES_DEV = join(REPO_ROOT, 'templates/dev/defaults');

const LEGACY_L0 = /<!--\s*L0:/;
const LEGACY_L1 = /<!--\s*L1:/;

function listRuleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

function listSkillEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .map((d) => join(dir, d, 'SKILL.md'))
    .filter((p) => existsSync(p));
}

function listAllMarkdownRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listAllMarkdownRecursive(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('regression-suite: shipped defaults have no legacy L0/L1 markers', () => {
  it('every file in defaults/rules/*.md has no <!-- L0: --> in body', () => {
    for (const path of listRuleFiles(DEFAULTS_RULES)) {
      const content = readFileSync(path, 'utf-8');
      expect(content, path).not.toMatch(LEGACY_L0);
      expect(content, path).not.toMatch(LEGACY_L1);
    }
  });

  it('every SKILL.md in defaults/skills/*/ has no <!-- L0: --> in body', () => {
    for (const path of listSkillEntries(DEFAULTS_SKILLS)) {
      const content = readFileSync(path, 'utf-8');
      expect(content, path).not.toMatch(LEGACY_L0);
      expect(content, path).not.toMatch(LEGACY_L1);
    }
  });

  it('every markdown file in templates/dev/defaults/ has no <!-- L0: --> in body', () => {
    for (const path of listAllMarkdownRecursive(TEMPLATES_DEV)) {
      const content = readFileSync(path, 'utf-8');
      expect(content, path).not.toMatch(LEGACY_L0);
      expect(content, path).not.toMatch(LEGACY_L1);
    }
  });
});

describe('regression-suite: shipped defaults have description: in frontmatter', () => {
  it('every rule in defaults/rules/*.md has description ≥ 20 chars', () => {
    for (const path of listRuleFiles(DEFAULTS_RULES)) {
      const { data } = matter(readFileSync(path, 'utf-8'));
      expect(data.description, `${path} missing description:`).toBeTruthy();
      expect(String(data.description).length, `${path} description too short`).toBeGreaterThanOrEqual(20);
    }
  });

  it('every skill in defaults/skills/*/SKILL.md has description ≥ 20 chars', () => {
    for (const path of listSkillEntries(DEFAULTS_SKILLS)) {
      const { data } = matter(readFileSync(path, 'utf-8'));
      expect(data.description, `${path} missing description:`).toBeTruthy();
      expect(String(data.description).length, `${path} description too short`).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('regression-suite: scaffold structure', () => {
  it('templates/dev/defaults/ uses only post-collapse primitive directories', () => {
    if (!existsSync(TEMPLATES_DEV)) return;
    const allowed = new Set(['rules', 'skills', 'memory', 'intake']);
    const subdirs = readdirSync(TEMPLATES_DEV)
      .filter((entry) => statSync(join(TEMPLATES_DEV, entry)).isDirectory());
    const offenders = subdirs.filter((d) => !allowed.has(d));
    expect(offenders, `templates/dev/defaults/ contains legacy primitive dir(s): ${offenders.join(', ')}`).toEqual([]);
  });

  it('package.json exposes only bin, no library surface', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.harness).toBe('./dist/cli/index.js');
    expect(pkg.main, 'package.json has "main" — anti-pattern violation').toBeUndefined();
    expect(pkg.types, 'package.json has "types" — anti-pattern violation').toBeUndefined();
    expect(pkg.exports, 'package.json has "exports" — anti-pattern violation').toBeUndefined();
  });
});

describe('regression-suite: skill frontmatter schema validity', () => {
  it('every default skill has Agent Skills name + metadata fields', () => {
    for (const path of listSkillEntries(DEFAULTS_SKILLS)) {
      const { data } = matter(readFileSync(path, 'utf-8'));
      expect(data.name, `${path} missing name`).toBeTruthy();
      expect(typeof data.name, `${path} name is not a string`).toBe('string');
      // name must match parent directory name per Agent Skills spec
      const parentDir = path.split('/').slice(-2, -1)[0];
      expect(data.name, `${path} name "${data.name}" doesn't match dir "${parentDir}"`).toBe(parentDir);
    }
  });
});
