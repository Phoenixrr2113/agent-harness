import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

// --- Types ---

/** A detected project characteristic */
export interface ProjectSignal {
  /** What was detected (e.g. "TypeScript", "React", "Docker") */
  name: string;
  /** Category of signal */
  category: 'language' | 'framework' | 'tool' | 'runtime' | 'database' | 'cloud' | 'testing';
  /** Source file that triggered the detection */
  source: string;
  /** Additional details */
  details?: string;
}

/** Suggested rule, skill, or MCP server */
export interface ProjectSuggestion {
  /** What type of thing to add */
  type: 'rule' | 'skill' | 'mcp-server';
  /** Human-readable suggestion */
  message: string;
  /** File to create (for rules/skills) or server query (for MCP) */
  target: string;
  /** Triggered by these signals */
  signals: string[];
}

/** Full project discovery result */
export interface ProjectDiscoveryResult {
  /** Detected project signals */
  signals: ProjectSignal[];
  /** Files that were examined */
  filesExamined: string[];
  /** Suggestions based on signals */
  suggestions: ProjectSuggestion[];
}

// --- Detection Functions ---

interface DetectionRule {
  file: string;
  detect: (content: string, dir: string) => ProjectSignal[];
}

function detectPackageJson(content: string): ProjectSignal[] {
  const signals: ProjectSignal[] = [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return signals;
  }

  const allDeps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  // Language
  if (allDeps['typescript'] || existsSync('tsconfig.json')) {
    signals.push({ name: 'TypeScript', category: 'language', source: 'package.json' });
  }

  // Frameworks
  const frameworks: Record<string, { name: string; category: ProjectSignal['category'] }> = {
    'react': { name: 'React', category: 'framework' },
    'next': { name: 'Next.js', category: 'framework' },
    'vue': { name: 'Vue', category: 'framework' },
    'nuxt': { name: 'Nuxt', category: 'framework' },
    'svelte': { name: 'Svelte', category: 'framework' },
    '@angular/core': { name: 'Angular', category: 'framework' },
    'express': { name: 'Express', category: 'framework' },
    'fastify': { name: 'Fastify', category: 'framework' },
    'hono': { name: 'Hono', category: 'framework' },
    'astro': { name: 'Astro', category: 'framework' },
    'remix': { name: 'Remix', category: 'framework' },
    '@remix-run/node': { name: 'Remix', category: 'framework' },
    'electron': { name: 'Electron', category: 'framework' },
  };

  for (const [dep, info] of Object.entries(frameworks)) {
    if (allDeps[dep]) {
      signals.push({ name: info.name, category: info.category, source: 'package.json', details: `v${allDeps[dep]}` });
    }
  }

  // Testing
  const testLibs: Record<string, string> = {
    'vitest': 'Vitest',
    'jest': 'Jest',
    'mocha': 'Mocha',
    '@playwright/test': 'Playwright',
    'cypress': 'Cypress',
  };

  for (const [dep, name] of Object.entries(testLibs)) {
    if (allDeps[dep]) {
      signals.push({ name, category: 'testing', source: 'package.json' });
    }
  }

  // Databases
  const dbLibs: Record<string, string> = {
    'prisma': 'Prisma',
    '@prisma/client': 'Prisma',
    'drizzle-orm': 'Drizzle',
    'mongoose': 'MongoDB (Mongoose)',
    'pg': 'PostgreSQL',
    'mysql2': 'MySQL',
    'better-sqlite3': 'SQLite',
    'redis': 'Redis',
    'ioredis': 'Redis',
  };

  for (const [dep, name] of Object.entries(dbLibs)) {
    if (allDeps[dep]) {
      signals.push({ name, category: 'database', source: 'package.json' });
    }
  }

  // Tools
  const tools: Record<string, string> = {
    'eslint': 'ESLint',
    'prettier': 'Prettier',
    'tailwindcss': 'Tailwind CSS',
    'storybook': 'Storybook',
    '@storybook/react': 'Storybook',
    'docker-compose': 'Docker Compose',
  };

  for (const [dep, name] of Object.entries(tools)) {
    if (allDeps[dep]) {
      signals.push({ name, category: 'tool', source: 'package.json' });
    }
  }

  return signals;
}

function detectFromFiles(dir: string): ProjectSignal[] {
  const signals: ProjectSignal[] = [];
  const entries = new Set<string>();

  try {
    for (const e of readdirSync(dir)) {
      entries.add(e);
    }
  } catch {
    return signals;
  }

  // Config files
  if (entries.has('Dockerfile') || entries.has('docker-compose.yml') || entries.has('docker-compose.yaml')) {
    signals.push({ name: 'Docker', category: 'runtime', source: 'Dockerfile' });
  }

  if (entries.has('.github')) {
    signals.push({ name: 'GitHub Actions', category: 'tool', source: '.github/' });
  }

  if (entries.has('Makefile')) {
    signals.push({ name: 'Make', category: 'tool', source: 'Makefile' });
  }

  if (entries.has('pyproject.toml') || entries.has('setup.py') || entries.has('requirements.txt')) {
    signals.push({ name: 'Python', category: 'language', source: 'pyproject.toml' });
  }

  if (entries.has('Cargo.toml')) {
    signals.push({ name: 'Rust', category: 'language', source: 'Cargo.toml' });
  }

  if (entries.has('go.mod')) {
    signals.push({ name: 'Go', category: 'language', source: 'go.mod' });
  }

  if (entries.has('Gemfile')) {
    signals.push({ name: 'Ruby', category: 'language', source: 'Gemfile' });
  }

  if (entries.has('.terraform') || entries.has('main.tf')) {
    signals.push({ name: 'Terraform', category: 'cloud', source: 'main.tf' });
  }

  if (entries.has('serverless.yml') || entries.has('serverless.yaml')) {
    signals.push({ name: 'Serverless Framework', category: 'cloud', source: 'serverless.yml' });
  }

  if (entries.has('vercel.json')) {
    signals.push({ name: 'Vercel', category: 'cloud', source: 'vercel.json' });
  }

  if (entries.has('netlify.toml')) {
    signals.push({ name: 'Netlify', category: 'cloud', source: 'netlify.toml' });
  }

  if (entries.has('wrangler.toml') || entries.has('wrangler.jsonc')) {
    signals.push({ name: 'Cloudflare Workers', category: 'cloud', source: 'wrangler.toml' });
  }

  if (entries.has('.prisma') || entries.has('prisma')) {
    signals.push({ name: 'Prisma', category: 'database', source: 'prisma/' });
  }

  if (entries.has('supabase')) {
    signals.push({ name: 'Supabase', category: 'database', source: 'supabase/' });
  }

  return signals;
}

// --- Suggestion Engine ---

interface SuggestionRule {
  signals: string[];
  type: ProjectSuggestion['type'];
  message: string;
  target: string;
}

const SUGGESTION_RULES: SuggestionRule[] = [
  {
    signals: ['TypeScript'],
    type: 'rule',
    message: 'Add a TypeScript coding standards rule',
    target: 'rules/typescript-standards.md',
  },
  {
    signals: ['React'],
    type: 'rule',
    message: 'Add React component patterns rule',
    target: 'rules/react-patterns.md',
  },
  {
    signals: ['Next.js'],
    type: 'skill',
    message: 'Add Next.js development skill',
    target: 'skills/nextjs.md',
  },
  {
    signals: ['Docker'],
    type: 'rule',
    message: 'Add Docker/containerization rule',
    target: 'rules/docker.md',
  },
  {
    signals: ['GitHub Actions'],
    type: 'skill',
    message: 'Add CI/CD pipeline skill',
    target: 'skills/ci-cd.md',
  },
  {
    signals: ['PostgreSQL', 'Prisma'],
    type: 'mcp-server',
    message: 'Install PostgreSQL MCP server for database access',
    target: 'postgres',
  },
  {
    signals: ['Supabase'],
    type: 'mcp-server',
    message: 'Install Supabase MCP server',
    target: 'supabase',
  },
  {
    signals: ['ESLint'],
    type: 'rule',
    message: 'Add linting standards rule',
    target: 'rules/linting.md',
  },
  {
    signals: ['Vitest', 'Jest'],
    type: 'rule',
    message: 'Add testing standards rule',
    target: 'rules/testing.md',
  },
  {
    signals: ['Tailwind CSS'],
    type: 'rule',
    message: 'Add styling conventions rule',
    target: 'rules/styling.md',
  },
];

function generateSuggestions(signals: ProjectSignal[]): ProjectSuggestion[] {
  const signalNames = new Set(signals.map((s) => s.name));
  const suggestions: ProjectSuggestion[] = [];

  for (const rule of SUGGESTION_RULES) {
    // Check if ANY of the required signals are present
    const matchedSignals = rule.signals.filter((s) => signalNames.has(s));
    if (matchedSignals.length > 0) {
      suggestions.push({
        type: rule.type,
        message: rule.message,
        target: rule.target,
        signals: matchedSignals,
      });
    }
  }

  return suggestions;
}

// --- Main Discovery ---

/** Options for project discovery */
export interface ProjectDiscoveryOptions {
  /** Project directory to scan */
  dir?: string;
}

/**
 * Scan a project directory to detect its technology stack and suggest
 * rules, skills, and MCP servers.
 */
export function discoverProjectContext(options?: ProjectDiscoveryOptions): ProjectDiscoveryResult {
  const dir = options?.dir ?? process.cwd();
  const signals: ProjectSignal[] = [];
  const filesExamined: string[] = [];

  // Scan package.json
  const packageJsonPath = join(dir, 'package.json');
  if (existsSync(packageJsonPath)) {
    filesExamined.push(packageJsonPath);
    const content = readFileSync(packageJsonPath, 'utf-8');
    signals.push(...detectPackageJson(content));
  }

  // Scan directory for files/folders
  filesExamined.push(dir);
  signals.push(...detectFromFiles(dir));

  // Deduplicate signals by name
  const seen = new Set<string>();
  const uniqueSignals = signals.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  // Generate suggestions
  const suggestions = generateSuggestions(uniqueSignals);

  return {
    signals: uniqueSignals,
    filesExamined,
    suggestions,
  };
}
