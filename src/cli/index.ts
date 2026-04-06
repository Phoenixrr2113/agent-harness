import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { config as loadDotenv } from 'dotenv';
import { setGlobalLogLevel, type LogLevel } from '../core/logger.js';

// Load .env from current directory and common locations
loadDotenv();
loadDotenv({ path: resolve('.env.local') });

const program = new Command();

// Model aliases for convenience
const MODEL_ALIASES: Record<string, string> = {
  'gemma': 'google/gemma-4-26b-a4b-it',
  'gemma-31b': 'google/gemma-4-31b-it',
  'qwen': 'qwen/qwen3.5-35b-a3b',
  'glm': 'z-ai/glm-4.7-flash',
  'claude': 'anthropic/claude-sonnet-4',
  'gpt4o': 'openai/gpt-4o',
  'gpt4o-mini': 'openai/gpt-4o-mini',
};

function resolveModel(model?: string): string | undefined {
  if (!model) return undefined;
  return MODEL_ALIASES[model] || model;
}

function loadEnvFromDir(dir: string) {
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
}

function formatError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const e = err as Record<string, unknown>;

  // OpenRouter API errors
  if (e.data && typeof e.data === 'object') {
    const data = e.data as Record<string, unknown>;
    if (data.error && typeof data.error === 'object') {
      const apiErr = data.error as Record<string, unknown>;
      if (typeof apiErr.message === 'string') return apiErr.message;
    }
  }

  const message = e.message;
  if (typeof message !== 'string') return String(err);

  // API key errors
  if (message.includes('API key') || message.includes('OPENROUTER_API_KEY'))
    return message;

  // Model errors
  if (message.includes('not a valid model') || message.includes('model not found'))
    return `Invalid model: ${message}`;

  // Network errors
  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND'))
    return `Network error: Could not reach API. Check your internet connection.`;
  if (message.includes('ETIMEDOUT'))
    return `Request timed out. The API may be overloaded — try again.`;

  // Rate limiting
  if (message.includes('429') || message.includes('rate limit'))
    return `Rate limited by API. Wait a moment and try again.`;

  // Config errors
  if (message.includes('Invalid config'))
    return message;

  // Zod validation errors
  if (message.includes('Expected') && message.includes('received'))
    return `Validation error: ${message}`;

  // File system errors
  if (message.includes('ENOENT'))
    return `File not found: ${message.replace(/.*ENOENT[^']*'([^']+)'.*/, '$1')}`;
  if (message.includes('EACCES'))
    return `Permission denied: ${message.replace(/.*EACCES[^']*'([^']+)'.*/, '$1')}`;

  return message;
}

function requireHarness(dir: string): void {
  if (!existsSync(join(dir, 'CORE.md')) && !existsSync(join(dir, 'config.yaml'))) {
    console.error(`Error: No harness found in ${dir}`);
    console.error(`Run "harness init <name>" to create one.`);
    process.exit(1);
  }
}

program
  .name('harness')
  .description('Agent Harness — build AI agents by editing files, not writing code.')
  .version('0.1.0')
  .option('-q, --quiet', 'Suppress non-error output')
  .option('-v, --verbose', 'Enable debug output')
  .option('--log-level <level>', 'Set log level (debug, info, warn, error, silent)')
  .hook('preAction', () => {
    const opts = program.opts();
    if (opts.quiet) setGlobalLogLevel('error');
    else if (opts.verbose) setGlobalLogLevel('debug');
    else if (opts.logLevel) setGlobalLogLevel(opts.logLevel as LogLevel);
  });

// --- INIT ---
program
  .command('init <name>')
  .description('Scaffold a new agent harness directory')
  .option('-d, --dir <path>', 'Parent directory', '.')
  .option('-t, --template <name>', 'Config template (base, claude-opus, gpt4, local)', 'base')
  .action(async (name: string, opts: { dir: string; template: string }) => {
    const { scaffoldHarness } = await import('./scaffold.js');
    const targetDir = resolve(opts.dir, name);

    try {
      scaffoldHarness(targetDir, name, { template: opts.template });
      console.log(`\n✓ Agent harness created: ${targetDir}`);
      console.log(`\nNext steps:`);
      console.log(`  cd ${name}`);
      console.log(`  # Edit CORE.md to define your agent's identity`);
      console.log(`  # Edit rules/, instincts/, skills/ to customize behavior`);
      console.log(`  harness run "Hello, who are you?"`);
      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- RUN ---
program
  .command('run <prompt>')
  .description('Run a prompt through the agent')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-s, --stream', 'Stream output', false)
  .option('-m, --model <model>', 'Model override (or alias: gemma, qwen, glm, claude)')
  .option('-p, --provider <provider>', 'Provider override (openrouter, anthropic, openai)')
  .action(async (prompt: string, opts: { dir: string; stream: boolean; model?: string; provider?: string }) => {
    const { createHarness } = await import('../core/harness.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);

    requireHarness(dir);

    const modelId = resolveModel(opts.model);
    try {
      const agent = createHarness({
        dir,
        model: modelId,
        provider: opts.provider,
      });

      if (opts.stream) {
        process.stdout.write('\n');
        for await (const chunk of agent.stream(prompt)) {
          process.stdout.write(chunk);
        }
        process.stdout.write('\n\n');
      } else {
        const result = await agent.run(prompt);
        console.log('\n' + result.text + '\n');
        console.error(
          `[${result.usage.totalTokens} tokens | session: ${result.session_id}]`
        );
      }

      await agent.shutdown();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- CHAT (interactive REPL with conversation memory) ---
program
  .command('chat')
  .description('Start an interactive chat session with conversation memory')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-m, --model <model>', 'Model override')
  .option('--fresh', 'Start fresh (clear conversation history)', false)
  .action(async (opts: { dir: string; model?: string; fresh: boolean }) => {
    const { Conversation } = await import('../runtime/conversation.js');
    const { loadConfig } = await import('../core/config.js');
    const readline = await import('readline');
    const dir = resolve(opts.dir);

    requireHarness(dir);

    const conv = new Conversation(dir);
    const modelId = resolveModel(opts.model);
    if (modelId) conv.setModelOverride(modelId);
    if (opts.fresh) conv.clear();
    await conv.init();

    const config = loadConfig(dir);
    const history = conv.getHistory();
    console.log(`\n${config.agent.name} is ready. ${history.length > 0 ? `(${history.length} messages in history)` : ''}`);
    console.log(`Type your message, "clear" to reset, or "exit" to quit.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      rl.question('> ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
          rl.close();
          return;
        }
        if (trimmed === 'clear') {
          conv.clear();
          console.log('[conversation cleared]\n');
          ask();
          return;
        }

        try {
          process.stdout.write('\n');
          for await (const chunk of conv.sendStream(trimmed)) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n\n');
        } catch (err: unknown) {
          console.error(`Error: ${formatError(err)}`);
        }

        ask();
      });
    };

    ask();
  });

// --- INFO ---
program
  .command('info')
  .description('Show harness info and loaded context')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { buildSystemPrompt } = await import('../runtime/context-loader.js');
    const { loadState } = await import('../runtime/state.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      const ctx = buildSystemPrompt(dir, config);
      const state = loadState(dir);

      console.log(`\nAgent: ${config.agent.name} v${config.agent.version}`);
      console.log(`Model: ${config.model.id}`);
      console.log(`State: ${state.mode}`);
      console.log(`Last interaction: ${state.last_interaction}`);
      console.log(`\nContext budget:`);
      console.log(`  Max tokens: ${ctx.budget.max_tokens}`);
      console.log(`  Used: ~${ctx.budget.used_tokens}`);
      console.log(`  Remaining: ~${ctx.budget.remaining}`);
      console.log(`  Files loaded: ${ctx.budget.loaded_files.length}`);
      ctx.budget.loaded_files.forEach(f => console.log(`    - ${f}`));
      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- PROMPT (show the assembled system prompt) ---
program
  .command('prompt')
  .description('Show the full assembled system prompt')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { buildSystemPrompt } = await import('../runtime/context-loader.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      const ctx = buildSystemPrompt(dir, config);
      console.log(ctx.systemPrompt);
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- DEV (watch mode + scheduler) ---
program
  .command('dev')
  .description('Start dev mode — watches for file changes, rebuilds indexes, runs scheduled workflows')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--no-schedule', 'Disable workflow scheduler')
  .action(async (opts: { dir: string; schedule: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const { rebuildAllIndexes } = await import('../runtime/indexer.js');
    const { createWatcher } = await import('../runtime/watcher.js');
    const { Scheduler } = await import('../runtime/scheduler.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);

    requireHarness(dir);

    const config = loadConfig(dir);
    console.log(`\n[dev] Watching "${config.agent.name}" harness at ${dir}`);

    // Initial index build
    const extDirs = config.extensions?.directories ?? [];
    rebuildAllIndexes(dir, extDirs);
    console.log(`[dev] Indexes rebuilt${extDirs.length ? ` (+ ${extDirs.length} extension dir(s))` : ''}`);

    // Start scheduler if there are workflows
    let scheduler: InstanceType<typeof Scheduler> | null = null;
    if (opts.schedule) {
      scheduler = new Scheduler({
        harnessDir: dir,
        onRun: (id, result) => {
          console.log(`[scheduler] ✓ ${id}: ${result.slice(0, 100)}`);
        },
        onError: (id, error) => {
          console.error(`[scheduler] ✗ ${id}: ${error.message}`);
        },
        onSchedule: (id, cronExpr) => {
          console.log(`[scheduler] Scheduled: ${id} (${cronExpr})`);
        },
        onArchival: (sessions, journals) => {
          if (sessions + journals > 0) {
            console.log(`[scheduler] Archived ${sessions} session(s), ${journals} journal(s)`);
          }
        },
      });
      scheduler.start();

      const scheduled = scheduler.listScheduled();
      if (scheduled.length > 0) {
        console.log(`[dev] Scheduler started with ${scheduled.length} workflow(s)`);
      } else {
        console.log(`[dev] Scheduler running (no workflows with schedule: set)`);
      }
    }

    // Start watching (including extension directories)
    createWatcher({
      harnessDir: dir,
      extraDirs: extDirs,
      onChange: (path, event) => {
        const rel = path.replace(dir + '/', '');
        console.log(`[dev] ${event}: ${rel}`);
      },
      onIndexRebuild: (directory) => {
        console.log(`[dev] Index rebuilt: ${directory}/_index.md`);
      },
    });

    console.log(`[dev] Watching for changes... (Ctrl+C to stop)\n`);

    // Graceful shutdown
    const cleanup = () => {
      console.log(`\n[dev] Shutting down...`);
      if (scheduler) scheduler.stop();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

// --- INDEX (rebuild all indexes) ---
program
  .command('index')
  .description('Rebuild all index files')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { rebuildAllIndexes } = await import('../runtime/indexer.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);

    let extDirs: string[] = [];
    try {
      const config = loadConfig(dir);
      extDirs = config.extensions?.directories ?? [];
    } catch {
      // Config may not exist for index command — proceed with core dirs only
    }

    rebuildAllIndexes(dir, extDirs);
    console.log(`✓ All indexes rebuilt in ${dir}`);
  });

// --- JOURNAL (synthesize sessions into journal) ---
program
  .command('journal')
  .description('Synthesize sessions into journal entries')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--date <date>', 'Date to synthesize (YYYY-MM-DD)')
  .option('--from <date>', 'Start of date range (YYYY-MM-DD)')
  .option('--to <date>', 'End of date range (YYYY-MM-DD, default: today)')
  .option('--all', 'Synthesize all dates with sessions', false)
  .option('--force', 'Re-synthesize even if journal exists', false)
  .option('--pending', 'Show dates with sessions but no journal', false)
  .action(async (opts: { dir: string; date?: string; from?: string; to?: string; all: boolean; force: boolean; pending: boolean }) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);

    requireHarness(dir);

    // Show pending (unjournaled) dates
    if (opts.pending) {
      const { listUnjournaled } = await import('../runtime/journal.js');
      const dates = listUnjournaled(dir);
      if (dates.length === 0) {
        console.log('All sessions have been journaled.');
      } else {
        console.log(`\n${dates.length} date(s) with unjournaled sessions:\n`);
        dates.forEach((d) => console.log(`  ${d}`));
        console.log(`\nRun "harness journal --all" to synthesize them.\n`);
      }
      return;
    }

    // Range mode (--from/--to or --all)
    if (opts.from || opts.all) {
      const { synthesizeJournalRange } = await import('../runtime/journal.js');

      try {
        const label = opts.all ? 'all dates' : `${opts.from}${opts.to ? ` to ${opts.to}` : ' to today'}`;
        console.log(`Synthesizing journals for ${label}${opts.force ? ' (force)' : ''}...`);

        const entries = await synthesizeJournalRange(dir, {
          from: opts.from,
          to: opts.to,
          all: opts.all,
          force: opts.force,
        });

        if (entries.length === 0) {
          console.log('No sessions to synthesize (or all dates already journaled).');
          return;
        }

        console.log(`\n✓ ${entries.length} journal(s) synthesized:\n`);
        for (const entry of entries) {
          const sessionCount = entry.sessions.length;
          const instinctCount = entry.instinct_candidates.length;
          console.log(`  ${entry.date}: ${sessionCount} session(s), ${entry.tokens_used} tokens${instinctCount > 0 ? `, ${instinctCount} instinct candidate(s)` : ''}`);
        }
        console.log();
      } catch (err: unknown) {
        console.error(`Error: ${formatError(err)}`);
        process.exit(1);
      }
      return;
    }

    // Single date mode (default)
    const { synthesizeJournal } = await import('../runtime/journal.js');

    try {
      console.log(`Synthesizing journal...`);
      const entry = await synthesizeJournal(dir, opts.date);
      console.log(`\n✓ Journal for ${entry.date}`);
      console.log(`  Sessions: ${entry.sessions.length}`);
      console.log(`  Tokens: ${entry.tokens_used}`);
      if (entry.instinct_candidates.length > 0) {
        console.log(`  Instinct candidates:`);
        entry.instinct_candidates.forEach(c => console.log(`    - ${c}`));
      }
      console.log(`\n${entry.synthesis}`);
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- COMPRESS (weekly journal roll-ups) ---
program
  .command('compress')
  .description('Compress daily journals into weekly roll-up summaries')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--force', 'Overwrite existing weekly summaries', false)
  .action(async (opts: { dir: string; force: boolean }) => {
    const { compressJournals } = await import('../runtime/journal.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const results = compressJournals(dir, { force: opts.force });

    if (results.length === 0) {
      console.log('\nNo complete past weeks to compress (or all already compressed).\n');
      return;
    }

    console.log(`\n✓ ${results.length} weekly summary(ies) created:\n`);
    for (const week of results) {
      const insights = week.allInsights.length;
      const instincts = week.allInstinctCandidates.length;
      console.log(`  ${week.weekStart} to ${week.weekEnd} (${week.journalDates.length} days)`);
      console.log(`    ${insights} insight(s), ${instincts} instinct candidate(s)`);
    }
    console.log();
  });

// --- LEARN (propose and install instincts) ---
program
  .command('learn')
  .description('Analyze sessions and propose new instincts')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--install', 'Auto-install proposed instincts', false)
  .action(async (opts: { dir: string; install: boolean }) => {
    const { learnFromSessions } = await import('../runtime/instinct-learner.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      console.log(`Analyzing sessions for instinct candidates...`);
      const result = await learnFromSessions(dir, opts.install);

      if (result.candidates.length === 0) {
        console.log(`No instinct candidates found.`);
        return;
      }

      console.log(`\n${result.candidates.length} instinct candidate(s):\n`);
      for (const c of result.candidates) {
        const status = result.installed.includes(c.id)
          ? '✓ installed'
          : result.skipped.includes(c.id)
          ? '⊘ skipped (exists)'
          : '○ proposed';
        console.log(`  [${status}] ${c.id} (${c.confidence})`);
        console.log(`    ${c.behavior}`);
        console.log(`    Provenance: ${c.provenance}\n`);
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- HARVEST (extract instinct candidates from journals) ---
program
  .command('harvest')
  .description('Extract instinct candidates from journal entries and optionally install them')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--install', 'Auto-install candidates as draft instincts', false)
  .action(async (opts: { dir: string; from?: string; to?: string; install: boolean }) => {
    const { harvestInstincts } = await import('../runtime/instinct-learner.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const result = harvestInstincts(dir, {
      from: opts.from,
      to: opts.to,
      install: opts.install,
    });

    console.log(`\nScanned ${result.journalsScanned} journal(s)`);

    if (result.candidates.length === 0) {
      console.log(`No new instinct candidates found.\n`);
      return;
    }

    console.log(`Found ${result.candidates.length} candidate(s):\n`);
    for (const c of result.candidates) {
      const status = result.installed.includes(c.id)
        ? '✓ installed'
        : result.skipped.includes(c.id)
          ? '⊘ skipped (exists)'
          : '○ proposed';
      console.log(`  [${status}] ${c.id}`);
      console.log(`    ${c.behavior}`);
      console.log(`    Source: ${c.provenance}\n`);
    }

    if (!opts.install && result.candidates.length > 0) {
      console.log(`Run with --install to create instinct files.\n`);
    }
  });

// --- INSTALL (install capability from file or URL) ---
program
  .command('install <source>')
  .description('Install a capability from a local file or HTTPS URL')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (source: string, opts: { dir: string }) => {
    const { installCapability, downloadCapability } = await import('../runtime/intake.js');
    const dir = resolve(opts.dir);

    let filePath: string;

    // Detect URL vs local path
    if (source.startsWith('https://') || source.startsWith('http://')) {
      console.log(`Downloading: ${source}`);
      const dlResult = await downloadCapability(source);
      if (!dlResult.downloaded) {
        console.error(`✗ Download failed: ${dlResult.error}`);
        process.exit(1);
      }
      filePath = dlResult.localPath;
      console.log(`Downloaded to: ${filePath}`);
    } else {
      filePath = resolve(source);
    }

    const result = installCapability(dir, filePath);

    if (result.installed) {
      console.log(`✓ Installed ${result.evalResult.type} to ${result.destination}`);
      if (result.evalResult.warnings.length > 0) {
        result.evalResult.warnings.forEach(w => console.log(`  ⚠ ${w}`));
      }
    } else {
      console.error(`✗ Installation failed:`);
      result.evalResult.errors.forEach(e => console.error(`  - ${e}`));
    }
  });

// --- INTAKE (process all files in intake/) ---
program
  .command('intake')
  .description('Process all pending files in the intake/ directory')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { processIntake } = await import('../runtime/intake.js');
    const dir = resolve(opts.dir);

    const results = processIntake(dir);

    if (results.length === 0) {
      console.log(`No files in intake/`);
      return;
    }

    for (const { file, result } of results) {
      if (result.installed) {
        console.log(`✓ ${file} → ${result.evalResult.type}`);
      } else {
        console.log(`✗ ${file}: ${result.evalResult.errors.join(', ')}`);
      }
    }
  });

// --- VALIDATE (check harness integrity) ---
program
  .command('validate')
  .description('Validate harness structure and configuration')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { validateHarness } = await import('../runtime/validator.js');
    const dir = resolve(opts.dir);

    const { ok, warnings, errors, parseErrors, totalPrimitives } = validateHarness(dir);

    // Output results
    console.log(`\nHarness validation: ${dir}\n`);

    if (ok.length > 0) {
      for (const msg of ok) {
        console.log(`  ✓ ${msg}`);
      }
    }

    if (warnings.length > 0) {
      console.log();
      for (const msg of warnings) {
        console.log(`  ⚠ ${msg}`);
      }
    }

    if (errors.length > 0) {
      console.log();
      for (const msg of errors) {
        console.log(`  ✗ ${msg}`);
      }
    }

    console.log(`\nSummary: ${ok.length} passed, ${warnings.length} warnings, ${errors.length} errors`);
    console.log(`Primitives: ${totalPrimitives} loaded${parseErrors.length > 0 ? `, ${parseErrors.length} parse error(s)` : ''}\n`);

    if (errors.length > 0) {
      process.exit(1);
    }
  });

// --- DOCTOR (validate + batch auto-fix) ---
program
  .command('doctor')
  .description('Validate harness and auto-fix all fixable issues in one pass')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { doctorHarness } = await import('../runtime/validator.js');
    const dir = resolve(opts.dir);

    console.log(`\nRunning doctor on: ${dir}\n`);
    const result = doctorHarness(dir);

    // Show fixes first
    if (result.fixes.length > 0) {
      console.log(`  Auto-fixed ${result.fixes.length} issue(s):`);
      for (const fix of result.fixes) {
        console.log(`    ✓ ${fix}`);
      }
      console.log();
    }

    // Show remaining checks
    if (result.ok.length > 0) {
      for (const msg of result.ok) {
        console.log(`  ✓ ${msg}`);
      }
    }

    if (result.warnings.length > 0) {
      console.log();
      for (const msg of result.warnings) {
        console.log(`  ⚠ ${msg}`);
      }
    }

    if (result.errors.length > 0) {
      console.log();
      for (const msg of result.errors) {
        console.log(`  ✗ ${msg}`);
      }
    }

    const fixLabel = result.fixes.length > 0 ? `, ${result.fixes.length} fixed` : '';
    console.log(`\nSummary: ${result.ok.length} ok, ${result.warnings.length} warnings, ${result.errors.length} errors${fixLabel}`);
    console.log(`Primitives: ${result.totalPrimitives}\n`);

    if (result.errors.length > 0) {
      process.exit(1);
    }
  });

// --- FIX (auto-fix common issues in a capability file) ---
program
  .command('fix <file>')
  .description('Auto-fix common issues in a capability markdown file (missing id, status, L0/L1)')
  .action(async (file: string) => {
    const { fixCapability } = await import('../runtime/intake.js');
    const filePath = resolve(file);

    const result = fixCapability(filePath);

    if (result.fixes_applied.length > 0) {
      console.log(`Fixed ${result.fixes_applied.length} issue(s) in ${filePath}:`);
      for (const fix of result.fixes_applied) {
        console.log(`  ✓ ${fix}`);
      }
    } else {
      console.log('No auto-fixable issues found.');
    }

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }

    if (result.errors.length > 0) {
      console.error(`\nRemaining errors (manual fix required):`);
      for (const e of result.errors) {
        console.error(`  ✗ ${e}`);
      }
      process.exit(1);
    }
  });

// --- CLEANUP (archive or remove old sessions/journals per retention policy) ---
program
  .command('cleanup')
  .description('Archive sessions and journals older than retention period')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--dry-run', 'Show what would be archived without acting', false)
  .option('--delete', 'Permanently delete instead of archiving', false)
  .action(async (opts: { dir: string; dryRun: boolean; delete: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const sessionDays = config.memory.session_retention_days;
    const journalDays = config.memory.journal_retention_days;

    if (opts.dryRun) {
      const { listExpiredFiles } = await import('../runtime/sessions.js');
      const expired = listExpiredFiles(dir, sessionDays, journalDays);
      const action = opts.delete ? 'delete' : 'archive';
      console.log(`\nDry run — retention policy (sessions: ${sessionDays}d, journals: ${journalDays}d)\n`);
      console.log(`Would ${action} ${expired.sessionFiles.length} session(s):`);
      expired.sessionFiles.forEach((f) => console.log(`  - ${f}`));
      console.log(`Would ${action} ${expired.journalFiles.length} journal(s):`);
      expired.journalFiles.forEach((f) => console.log(`  - ${f}`));
      return;
    }

    if (opts.delete) {
      const { cleanupOldFiles } = await import('../runtime/sessions.js');
      const result = cleanupOldFiles(dir, sessionDays, journalDays);
      console.log(`\nDeleted ${result.sessionsRemoved} session(s), ${result.journalsRemoved} journal(s)`);
      if (result.sessionFiles.length > 0) {
        result.sessionFiles.forEach((f) => console.log(`  - ${f}`));
      }
      if (result.journalFiles.length > 0) {
        result.journalFiles.forEach((f) => console.log(`  - ${f}`));
      }
    } else {
      const { archiveOldFiles } = await import('../runtime/sessions.js');
      const result = archiveOldFiles(dir, sessionDays, journalDays);
      console.log(`\nArchived ${result.sessionsArchived} session(s), ${result.journalsArchived} journal(s)`);
      if (result.sessionFiles.length > 0) {
        console.log(`  Sessions → memory/sessions/archive/`);
        result.sessionFiles.forEach((f) => console.log(`    - ${f}`));
      }
      if (result.journalFiles.length > 0) {
        console.log(`  Journals → memory/journal/archive/`);
        result.journalFiles.forEach((f) => console.log(`    - ${f}`));
      }
    }
    console.log();
  });

// --- STATUS (rich harness overview) ---
program
  .command('status')
  .description('Show harness status: primitives, sessions, config, state')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { existsSync, readdirSync } = await import('fs');
    const { validateHarness } = await import('../runtime/validator.js');
    const { loadConfig } = await import('../core/config.js');
    const { loadState } = await import('../runtime/state.js');
    const { listSessions } = await import('../runtime/sessions.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const state = loadState(dir);
    const validation = validateHarness(dir);
    const sessions = listSessions(dir);

    // Header
    console.log(`\n  ${config.agent.name} v${config.agent.version}`);
    console.log(`  Model: ${config.model.provider}/${config.model.id}`);
    console.log(`  Mode: ${state.mode}`);

    // Primitives
    console.log(`\n  Primitives (${validation.totalPrimitives} total):`);
    for (const [dir, count] of validation.primitiveCounts) {
      if (count > 0) console.log(`    ${dir}: ${count}`);
    }
    const emptyDirs = Array.from(validation.primitiveCounts.entries())
      .filter(([, c]) => c === 0)
      .map(([d]) => d);
    if (emptyDirs.length > 0) {
      console.log(`    (empty: ${emptyDirs.join(', ')})`);
    }

    // Sessions
    console.log(`\n  Sessions: ${sessions.length} total`);
    if (sessions.length > 0) {
      const recent = sessions.slice(0, 3);
      for (const s of recent) {
        console.log(`    ${s.id}`);
      }
      if (sessions.length > 3) console.log(`    ... and ${sessions.length - 3} more`);
    }

    // Journals
    const journalDir = join(dir, 'memory', 'journal');
    let journalCount = 0;
    if (existsSync(journalDir)) {
      journalCount = readdirSync(journalDir).filter(
        (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'),
      ).length;
    }
    console.log(`  Journals: ${journalCount}`);

    // State
    if (state.goals.length > 0) {
      console.log(`\n  Goals:`);
      for (const g of state.goals) {
        console.log(`    - ${g}`);
      }
    }
    if (state.active_workflows.length > 0) {
      console.log(`\n  Active workflows:`);
      for (const w of state.active_workflows) {
        console.log(`    - ${w}`);
      }
    }
    if (state.unfinished_business.length > 0) {
      console.log(`\n  Unfinished business:`);
      for (const u of state.unfinished_business) {
        console.log(`    - ${u}`);
      }
    }

    // Health
    const healthIssues = validation.errors.length + validation.warnings.length;
    if (healthIssues > 0) {
      console.log(`\n  Health: ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`);
      if (validation.errors.length > 0) {
        console.log(`    Run 'harness validate' for details`);
      }
    } else {
      console.log(`\n  Health: OK`);
    }

    console.log(`  Last interaction: ${state.last_interaction}\n`);
  });

// --- SCRATCH (write to working memory) ---
program
  .command('scratch')
  .description('Write a note to scratch.md (working memory)')
  .argument('<note...>', 'Note to write')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--clear', 'Clear scratch before writing', false)
  .option('--show', 'Show current scratch contents', false)
  .action(async (note: string[], opts: { dir: string; clear: boolean; show: boolean }) => {
    const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs');
    const scratchPath = join(resolve(opts.dir), 'memory', 'scratch.md');
    const memoryDir = join(resolve(opts.dir), 'memory');

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    if (opts.show) {
      if (existsSync(scratchPath)) {
        const content = readFileSync(scratchPath, 'utf-8');
        console.log(content || '(empty)');
      } else {
        console.log('(no scratch.md)');
      }
      return;
    }

    const noteText = note.join(' ');

    if (opts.clear) {
      writeFileSync(scratchPath, noteText + '\n', 'utf-8');
      console.log('✓ Scratch cleared and updated');
    } else {
      const existing = existsSync(scratchPath) ? readFileSync(scratchPath, 'utf-8') : '';
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const entry = `[${timestamp}] ${noteText}\n`;
      writeFileSync(scratchPath, existing + entry, 'utf-8');
      console.log('✓ Note added to scratch');
    }
  });

// --- WORKFLOW (list and run workflows) ---
const workflowCmd = program
  .command('workflow')
  .description('Manage workflows');

workflowCmd
  .command('list')
  .description('List all workflows and their schedules')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadDirectory } = await import('../primitives/loader.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const workflowDir = join(dir, 'workflows');
    if (!existsSync(workflowDir)) {
      console.log('\nNo workflows/ directory. Create workflow files to enable scheduling.\n');
      return;
    }

    const docs = loadDirectory(workflowDir);
    if (docs.length === 0) {
      console.log('\nNo workflows defined.\n');
      return;
    }

    console.log(`\n${docs.length} workflow(s):\n`);
    for (const doc of docs) {
      const schedule = doc.frontmatter.schedule || '(no schedule)';
      const status = doc.frontmatter.status === 'active' ? '' : ` [${doc.frontmatter.status}]`;
      const withAgent = doc.frontmatter.with ? ` → ${doc.frontmatter.with}` : '';
      console.log(`  ${doc.frontmatter.id}${status}`);
      console.log(`    Schedule: ${schedule}${withAgent}`);
      if (doc.l0) console.log(`    ${doc.l0}`);
    }
    console.log();
  });

workflowCmd
  .command('run <id>')
  .description('Execute a workflow by ID (bypasses quiet hours)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (workflowId: string, opts: { dir: string }) => {
    const { Scheduler } = await import('../runtime/scheduler.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    requireHarness(dir);

    console.log(`\nExecuting workflow: ${workflowId}...`);
    const scheduler = new Scheduler({
      harnessDir: dir,
      autoArchival: false,
    });

    try {
      const result = await scheduler.runOnce(workflowId);
      console.log(`\n✓ Workflow "${workflowId}" complete.\n`);
      if (result) {
        console.log(result.slice(0, 500));
        if (result.length > 500) console.log(`\n... (${result.length} chars total)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n✗ Workflow failed: ${msg}\n`);
      process.exit(1);
    }
  });

// --- SEARCH (find primitives by query/filters) ---
program
  .command('search [query]')
  .description('Search primitives by text query and/or filters')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-t, --tag <tag>', 'Filter by tag')
  .option('--type <type>', 'Filter by primitive type (e.g., rules, skills)')
  .option('--status <status>', 'Filter by status (active, draft, archived, deprecated)')
  .option('--author <author>', 'Filter by author (human, agent, infrastructure)')
  .action(async (query: string | undefined, opts: { dir: string; tag?: string; type?: string; status?: string; author?: string }) => {
    const { searchPrimitives } = await import('../runtime/search.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try {
      config = loadConfig(dir);
    } catch {
      // Proceed without config (uses core dirs only)
    }

    const results = searchPrimitives(dir, query, {
      tag: opts.tag,
      type: opts.type,
      status: opts.status,
      author: opts.author,
    }, config);

    if (results.length === 0) {
      const filters = [query, opts.tag && `tag:${opts.tag}`, opts.type && `type:${opts.type}`, opts.status && `status:${opts.status}`, opts.author && `author:${opts.author}`].filter(Boolean).join(', ');
      console.log(`\nNo results for: ${filters || '(no filters)'}\n`);
      return;
    }

    console.log(`\n${results.length} result(s):\n`);
    for (const r of results) {
      const tags = r.doc.frontmatter.tags.length > 0 ? ` [${r.doc.frontmatter.tags.join(', ')}]` : '';
      const status = r.doc.frontmatter.status !== 'active' ? ` (${r.doc.frontmatter.status})` : '';
      console.log(`  ${r.directory}/${r.doc.frontmatter.id}${status}${tags}`);
      console.log(`    ${r.matchReason}`);
      if (r.doc.l0) console.log(`    ${r.doc.l0}`);
    }
    console.log();
  });

// --- CONFIG (show/get configuration) ---
const configCmd = program
  .command('config')
  .description('Show or inspect configuration');

configCmd
  .command('show')
  .description('Show full resolved configuration (merged defaults + file + env)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const YAML = await import('yaml');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      console.log(`\n# Resolved config for: ${dir}\n`);
      console.log(YAML.stringify(config).trimEnd());
      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

configCmd
  .command('get <key>')
  .description('Get a specific config value (dot-notation, e.g. model.id)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (key: string, opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      const parts = key.split('.');
      let value: unknown = config;
      for (const part of parts) {
        if (value === null || value === undefined || typeof value !== 'object') {
          console.error(`Error: Key "${key}" not found (stopped at "${part}")`);
          process.exit(1);
        }
        value = (value as Record<string, unknown>)[part];
      }

      if (value === undefined) {
        console.error(`Error: Key "${key}" not found`);
        process.exit(1);
      }

      if (typeof value === 'object' && value !== null) {
        const YAML = await import('yaml');
        console.log(YAML.stringify(value).trimEnd());
      } else {
        console.log(String(value));
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value (writes to config.yaml)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (key: string, value: string, opts: { dir: string }) => {
    const { readFileSync, writeFileSync, existsSync } = await import('fs');
    const YAML = await import('yaml');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const configPath = join(dir, 'config.yaml');
    if (!existsSync(configPath)) {
      console.error(`Error: No config.yaml found in ${dir}`);
      process.exit(1);
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const doc = YAML.parseDocument(content);

      // Parse the value — attempt number/boolean coercion
      let parsed: unknown = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) parsed = parseFloat(value);

      // Set using dot-notation path
      const parts = key.split('.');
      doc.setIn(parts, parsed);

      writeFileSync(configPath, doc.toString(), 'utf-8');

      // Validate the resulting config
      const { loadConfig } = await import('../core/config.js');
      try {
        loadConfig(dir);
        console.log(`✓ ${key} = ${String(parsed)}`);
      } catch (err: unknown) {
        console.error(`Warning: Config saved but validation failed: ${formatError(err)}`);
        console.error(`You may want to revert: harness config set ${key} <previous-value>`);
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- METRICS (workflow execution stats) ---
const metricsCmd = program
  .command('metrics')
  .description('View workflow execution metrics and stats');

metricsCmd
  .command('show')
  .description('Show stats for all workflows (default)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--workflow <id>', 'Show stats for a specific workflow')
  .action(async (opts: { dir: string; workflow?: string }) => {
    const { getAllWorkflowStats, getWorkflowStats } = await import('../runtime/metrics.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    if (opts.workflow) {
      const stats = getWorkflowStats(dir, opts.workflow);
      if (!stats) {
        console.log(`\nNo metrics recorded for workflow "${opts.workflow}".\n`);
        return;
      }
      console.log(`\nWorkflow: ${stats.workflow_id}\n`);
      console.log(`  Runs:         ${stats.total_runs}`);
      console.log(`  Successes:    ${stats.successes}`);
      console.log(`  Failures:     ${stats.failures}`);
      console.log(`  Success rate: ${(stats.success_rate * 100).toFixed(1)}%`);
      console.log(`  Avg duration: ${formatDuration(stats.avg_duration_ms)}`);
      console.log(`  Total tokens: ${stats.total_tokens}`);
      console.log(`  Last run:     ${stats.last_run}`);
      if (stats.last_success) console.log(`  Last success: ${stats.last_success}`);
      if (stats.last_failure) console.log(`  Last failure: ${stats.last_failure}`);
      console.log();
      return;
    }

    const allStats = getAllWorkflowStats(dir);
    if (allStats.length === 0) {
      console.log('\nNo workflow metrics recorded yet.\n');
      console.log('Metrics are automatically recorded when workflows run via scheduler or `harness workflow run`.\n');
      return;
    }

    console.log(`\n${allStats.length} workflow(s) with metrics:\n`);
    for (const stats of allStats) {
      const rate = (stats.success_rate * 100).toFixed(0);
      console.log(`  ${stats.workflow_id}`);
      console.log(`    ${stats.total_runs} runs (${rate}% success) | avg ${formatDuration(stats.avg_duration_ms)} | ${stats.total_tokens} tokens`);
      console.log(`    Last: ${stats.last_run}`);
    }
    console.log();
  });

metricsCmd
  .command('clear')
  .description('Clear metrics for a specific workflow or all workflows')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--workflow <id>', 'Clear only this workflow (clears all if omitted)')
  .action(async (opts: { dir: string; workflow?: string }) => {
    const { clearMetrics } = await import('../runtime/metrics.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const removed = clearMetrics(dir, opts.workflow);
    if (opts.workflow) {
      console.log(`Cleared ${removed} metric(s) for workflow "${opts.workflow}".`);
    } else {
      console.log(`Cleared ${removed} total metric(s).`);
    }
  });

metricsCmd
  .command('history')
  .description('Show recent workflow run history')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--workflow <id>', 'Filter by workflow ID')
  .option('-n, --limit <count>', 'Number of recent runs to show', '10')
  .action(async (opts: { dir: string; workflow?: string; limit: string }) => {
    const { loadMetrics } = await import('../runtime/metrics.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const store = loadMetrics(dir);
    let runs = store.runs;

    if (opts.workflow) {
      runs = runs.filter((r) => r.workflow_id === opts.workflow);
    }

    const limit = parseInt(opts.limit, 10) || 10;
    const recent = runs.slice(-limit).reverse();

    if (recent.length === 0) {
      console.log('\nNo workflow runs recorded.\n');
      return;
    }

    console.log(`\n${recent.length} recent run(s)${opts.workflow ? ` for "${opts.workflow}"` : ''}:\n`);
    for (const run of recent) {
      const status = run.success ? 'OK' : 'FAIL';
      const tokens = run.tokens_used ? ` | ${run.tokens_used} tokens` : '';
      const retries = run.attempt > 1 ? ` (attempt ${run.attempt}/${run.max_retries + 1})` : '';
      const error = run.error ? `\n      Error: ${run.error.slice(0, 100)}` : '';
      console.log(`  [${status}] ${run.workflow_id} — ${formatDuration(run.duration_ms)}${tokens}${retries}`);
      console.log(`    ${run.started}${error}`);
    }
    console.log();
  });

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

// --- TOOLS (list and inspect tool definitions) ---
const toolsCmd = program
  .command('tools')
  .description('List and inspect tool definitions');

toolsCmd
  .command('list')
  .description('List all defined tools with auth status')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { listToolSummaries } = await import('../runtime/tools.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const tools = listToolSummaries(dir);
    if (tools.length === 0) {
      console.log('\nNo tools defined. Create tool files in tools/ to register external services.\n');
      return;
    }

    console.log(`\n${tools.length} tool(s):\n`);
    for (const tool of tools) {
      const auth = tool.authReady ? 'ready' : 'missing auth';
      const status = tool.status !== 'active' ? ` [${tool.status}]` : '';
      console.log(`  ${tool.id}${status} (${auth})`);
      if (tool.l0) console.log(`    ${tool.l0}`);
      console.log(`    ${tool.operationCount} operation(s) | tags: ${tool.tags.join(', ') || 'none'}`);
    }
    console.log();
  });

toolsCmd
  .command('show <id>')
  .description('Show detailed info for a specific tool')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (toolId: string, opts: { dir: string }) => {
    const { getToolById } = await import('../runtime/tools.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const tool = getToolById(dir, toolId);
    if (!tool) {
      console.error(`Tool not found: ${toolId}`);
      process.exit(1);
    }

    console.log(`\nTool: ${tool.id}`);
    console.log(`  Status: ${tool.status}`);
    console.log(`  Tags: ${tool.tags.join(', ') || 'none'}`);

    if (tool.auth.length > 0) {
      console.log(`\n  Authentication:`);
      for (const a of tool.auth) {
        const status = a.present ? 'set' : 'MISSING';
        console.log(`    ${a.envVar}: ${status}`);
      }
    }

    if (tool.operations.length > 0) {
      console.log(`\n  Operations (${tool.operations.length}):`);
      for (const op of tool.operations) {
        console.log(`    ${op.method} ${op.endpoint}`);
      }
    }

    if (tool.rateLimits.length > 0) {
      console.log(`\n  Rate Limits:`);
      for (const rl of tool.rateLimits) {
        console.log(`    - ${rl}`);
      }
    }

    if (tool.gotchas.length > 0) {
      console.log(`\n  Gotchas:`);
      for (const g of tool.gotchas) {
        console.log(`    - ${g}`);
      }
    }
    console.log();
  });

toolsCmd
  .command('auth')
  .description('Check auth status for all tools')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { checkToolAuth } = await import('../runtime/tools.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const results = checkToolAuth(dir);
    if (results.length === 0) {
      console.log('\nNo tools defined.\n');
      return;
    }

    console.log('\nTool auth status:\n');
    for (const { tool, auth } of results) {
      if (auth.length === 0) {
        console.log(`  ${tool}: no auth required`);
        continue;
      }
      const allPresent = auth.every((a) => a.present);
      console.log(`  ${tool}: ${allPresent ? 'ready' : 'INCOMPLETE'}`);
      for (const a of auth) {
        const icon = a.present ? 'set' : 'MISSING';
        console.log(`    ${a.envVar}: ${icon}`);
      }
    }
    console.log();
  });

// --- EXPORT (data portability) ---
program
  .command('export [output]')
  .description('Export harness to a portable JSON bundle')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--no-sessions', 'Exclude session files')
  .option('--no-journals', 'Exclude journal files')
  .option('--no-metrics', 'Exclude metrics')
  .option('--no-state', 'Exclude state and scratch')
  .action(async (output: string | undefined, opts: { dir: string; sessions: boolean; journals: boolean; metrics: boolean; state: boolean }) => {
    const { exportHarness, writeBundle } = await import('../runtime/export.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const bundle = exportHarness(dir, {
      sessions: opts.sessions,
      journals: opts.journals,
      metrics: opts.metrics,
      state: opts.state,
    });

    const outputPath = output ? resolve(output) : resolve(`${bundle.agent_name}-export.json`);
    writeBundle(bundle, outputPath);

    const { metadata } = bundle;
    console.log(`\nExported "${bundle.agent_name}" to ${outputPath}`);
    console.log(`  ${bundle.entries.length} files (${metadata.primitives} primitives, ${metadata.sessions} sessions, ${metadata.journals} journals)\n`);
  });

// --- IMPORT (data portability) ---
program
  .command('import <bundle>')
  .description('Import a harness bundle into current directory')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--overwrite', 'Overwrite existing files', false)
  .action(async (bundlePath: string, opts: { dir: string; overwrite: boolean }) => {
    const { readBundle, importBundle } = await import('../runtime/export.js');
    const dir = resolve(opts.dir);

    try {
      const bundle = readBundle(resolve(bundlePath));
      console.log(`\nImporting bundle: "${bundle.agent_name}" (exported ${bundle.exported_at})`);
      console.log(`  ${bundle.entries.length} files in bundle\n`);

      const result = importBundle(dir, bundle, { overwrite: opts.overwrite });

      console.log(`  Imported: ${result.imported}`);
      console.log(`  Skipped (exists): ${result.skipped}`);
      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
      }
      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- GRAPH (dependency analysis) ---
program
  .command('graph')
  .description('Analyze primitive dependency graph (related:/with: fields)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { buildDependencyGraph, getGraphStats } = await import('../runtime/graph.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try { config = loadConfig(dir); } catch { /* proceed without */ }

    const graph = buildDependencyGraph(dir, config);
    const stats = getGraphStats(dir, config);

    console.log(`\nDependency Graph\n`);
    console.log(`  Nodes: ${stats.totalNodes}`);
    console.log(`  Edges: ${stats.totalEdges}`);
    console.log(`  Clusters: ${stats.clusterCount}`);
    console.log(`  Orphans: ${stats.orphanCount}`);

    if (stats.mostConnected.length > 0) {
      console.log(`\n  Most connected:`);
      for (const mc of stats.mostConnected) {
        console.log(`    ${mc.id}: ${mc.connections} connection(s)`);
      }
    }

    if (graph.orphans.length > 0) {
      console.log(`\n  Orphaned primitives (no relationships):`);
      for (const id of graph.orphans) {
        const node = graph.nodes.find((n) => n.id === id);
        console.log(`    ${id} (${node?.directory || 'unknown'})`);
      }
    }

    if (stats.brokenRefs.length > 0) {
      console.log(`\n  Broken references:`);
      for (const br of stats.brokenRefs) {
        console.log(`    ${br.from} -> "${br.ref}" (not found)`);
      }
    }

    if (graph.clusters.length > 0) {
      console.log(`\n  Clusters:`);
      for (let i = 0; i < graph.clusters.length; i++) {
        const cluster = graph.clusters[i];
        console.log(`    [${i + 1}] ${cluster.join(', ')}`);
      }
    }

    console.log();
  });

// --- ANALYTICS (session statistics) ---
program
  .command('analytics')
  .description('Show session analytics and usage patterns')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .action(async (opts: { dir: string; from?: string; to?: string }) => {
    const { getSessionAnalytics, getSessionsInRange } = await import('../runtime/analytics.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    if (opts.from || opts.to) {
      const sessions = getSessionsInRange(dir, opts.from, opts.to);
      const label = opts.from && opts.to ? `${opts.from} to ${opts.to}` : opts.from ? `from ${opts.from}` : `to ${opts.to}`;
      if (sessions.length === 0) {
        console.log(`\nNo sessions found for ${label}.\n`);
        return;
      }

      const totalTokens = sessions.reduce((sum, s) => sum + s.tokens, 0);
      console.log(`\n${sessions.length} session(s) ${label}:\n`);
      for (const s of sessions) {
        const model = s.model ? ` [${s.model}]` : '';
        const delegate = s.delegatedTo ? ` -> ${s.delegatedTo}` : '';
        console.log(`  ${s.id}: ${s.tokens} tokens, ${s.durationMinutes}min${model}${delegate}`);
      }
      console.log(`\n  Total: ${totalTokens} tokens\n`);
      return;
    }

    const analytics = getSessionAnalytics(dir);

    if (analytics.totalSessions === 0) {
      console.log('\nNo sessions recorded yet.\n');
      return;
    }

    console.log(`\nSession Analytics\n`);
    console.log(`  Total sessions: ${analytics.totalSessions}`);
    console.log(`  Total tokens:   ${analytics.totalTokens.toLocaleString()}`);
    console.log(`  Avg tokens:     ${analytics.avgTokensPerSession.toLocaleString()}/session`);
    console.log(`  Avg duration:   ${analytics.avgDurationMinutes}min/session`);
    console.log(`  Delegations:    ${analytics.delegationCount}`);

    if (analytics.dateRange) {
      console.log(`  Date range:     ${analytics.dateRange.earliest} to ${analytics.dateRange.latest}`);
    }

    if (analytics.modelUsage.size > 0) {
      console.log(`\n  Model usage:`);
      const sorted = Array.from(analytics.modelUsage.entries()).sort((a, b) => b[1] - a[1]);
      for (const [model, count] of sorted) {
        console.log(`    ${model}: ${count} session(s)`);
      }
    }

    if (analytics.topDays.length > 0) {
      console.log(`\n  Busiest days:`);
      for (const day of analytics.topDays) {
        console.log(`    ${day.date}: ${day.sessions} session(s), ${day.tokens.toLocaleString()} tokens`);
      }
    }

    console.log();
  });

// --- AGENTS (list available sub-agents) ---
program
  .command('agents')
  .description('List available sub-agents')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { listAgents } = await import('../runtime/delegate.js');
    const dir = resolve(opts.dir);

    const agents = listAgents(dir);

    if (agents.length === 0) {
      console.log('\nNo agents defined.');
      console.log('Create agent files in agents/ to enable delegation.\n');
      return;
    }

    console.log(`\n${agents.length} agent(s) available:\n`);
    for (const agent of agents) {
      const status = agent.status === 'active' ? '' : ` [${agent.status}]`;
      console.log(`  ${agent.id}${status}`);
      if (agent.l0) console.log(`    ${agent.l0}`);
      if (agent.tags.length > 0) console.log(`    tags: ${agent.tags.join(', ')}`);
      console.log();
    }
  });

// --- DELEGATE (invoke a sub-agent) ---
program
  .command('delegate <agent-id> <prompt>')
  .description('Delegate a prompt to a sub-agent')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-m, --model <model>', 'Model override (or alias: gemma, qwen, glm, claude)')
  .option('-s, --stream', 'Stream output', false)
  .action(async (agentId: string, prompt: string, opts: { dir: string; model?: string; stream: boolean }) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    requireHarness(dir);

    const modelId = resolveModel(opts.model);
    const delegateOpts = {
      harnessDir: dir,
      agentId,
      prompt,
      modelOverride: modelId,
    };

    try {
      console.error(`[delegate] Invoking agent "${agentId}"${opts.stream ? ' (streaming)' : ''}...`);

      if (opts.stream) {
        const { delegateStream } = await import('../runtime/delegate.js');
        const result = delegateStream(delegateOpts);
        process.stdout.write('\n');
        for await (const chunk of result.textStream) {
          process.stdout.write(chunk);
        }
        process.stdout.write('\n\n');
        console.error(
          `[delegate] Agent: ${result.agentId} | session: ${result.sessionId}`
        );
      } else {
        const { delegateTo } = await import('../runtime/delegate.js');
        const result = await delegateTo(delegateOpts);
        console.log('\n' + result.text + '\n');
        console.error(
          `[delegate] Agent: ${result.agentId} | ` +
          `${result.usage.totalTokens} tokens | ` +
          `session: ${result.sessionId}`
        );
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

program.parse();
