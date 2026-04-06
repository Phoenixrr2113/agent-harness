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
        onSchedule: (id, cron) => {
          console.log(`[scheduler] Scheduled: ${id} (${cron})`);
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

// --- INSTALL (install capability from file) ---
program
  .command('install <file>')
  .description('Install a capability from a markdown file')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (file: string, opts: { dir: string }) => {
    const { installCapability } = await import('../runtime/intake.js');
    const dir = resolve(opts.dir);
    const filePath = resolve(file);

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

// --- CLEANUP (remove old sessions/journals per retention policy) ---
program
  .command('cleanup')
  .description('Remove sessions and journals older than retention period')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--dry-run', 'Show what would be removed without deleting', false)
  .action(async (opts: { dir: string; dryRun: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const { cleanupOldFiles, listSessions } = await import('../runtime/sessions.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const sessionDays = config.memory.session_retention_days;
    const journalDays = config.memory.journal_retention_days;

    if (opts.dryRun) {
      console.log(`\nDry run — retention policy:`);
      console.log(`  Sessions: ${sessionDays} days`);
      console.log(`  Journals: ${journalDays} days\n`);
    }

    if (opts.dryRun) {
      // Preview mode: use listExpired to show without deleting
      const { listExpiredFiles } = await import('../runtime/sessions.js');
      const expired = listExpiredFiles(dir, sessionDays, journalDays);
      console.log(`Would remove ${expired.sessionFiles.length} session(s):`);
      expired.sessionFiles.forEach((f) => console.log(`  - ${f}`));
      console.log(`Would remove ${expired.journalFiles.length} journal(s):`);
      expired.journalFiles.forEach((f) => console.log(`  - ${f}`));
      return;
    }

    const result = cleanupOldFiles(dir, sessionDays, journalDays);

    console.log(`\n✓ Cleanup complete`);
    console.log(`  Sessions removed: ${result.sessionsRemoved} (retention: ${sessionDays} days)`);
    console.log(`  Journals removed: ${result.journalsRemoved} (retention: ${journalDays} days)`);
    if (result.sessionFiles.length > 0) {
      result.sessionFiles.forEach((f) => console.log(`    - ${f}`));
    }
    if (result.journalFiles.length > 0) {
      result.journalFiles.forEach((f) => console.log(`    - ${f}`));
    }
    console.log();
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
