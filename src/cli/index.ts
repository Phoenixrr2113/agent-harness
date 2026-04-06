import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { config as loadDotenv } from 'dotenv';

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

function formatError(err: any): string {
  if (err?.data?.error?.message) return err.data.error.message;
  if (err?.message?.includes('API key')) return err.message;
  if (err?.message?.includes('not a valid model')) return `Invalid model ID: ${err.message}`;
  return err?.message || String(err);
}

program
  .name('harness')
  .description('Agent Harness — build AI agents by editing files, not writing code.')
  .version('0.1.0');

// --- INIT ---
program
  .command('init <name>')
  .description('Scaffold a new agent harness directory')
  .option('-d, --dir <path>', 'Parent directory', '.')
  .action(async (name: string, opts: { dir: string }) => {
    const { scaffoldHarness } = await import('./scaffold.js');
    const targetDir = resolve(opts.dir, name);

    try {
      scaffoldHarness(targetDir, name);
      console.log(`\n✓ Agent harness created: ${targetDir}`);
      console.log(`\nNext steps:`);
      console.log(`  cd ${name}`);
      console.log(`  # Edit CORE.md to define your agent's identity`);
      console.log(`  # Edit rules/, instincts/, skills/ to customize behavior`);
      console.log(`  harness run "Hello, who are you?"`);
      console.log();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
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
  .action(async (prompt: string, opts: { dir: string; stream: boolean; model?: string }) => {
    const { createHarness } = await import('../core/harness.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);

    if (!existsSync(join(dir, 'CORE.md')) && !existsSync(join(dir, 'config.yaml'))) {
      console.error(`Error: No harness found in ${dir}`);
      console.error(`Run "harness init <name>" to create one.`);
      process.exit(1);
    }

    const modelId = resolveModel(opts.model);
    try {
      const agent = createHarness({
        dir,
        config: modelId ? { model: { id: modelId, provider: 'openrouter', max_tokens: 200000 } } : undefined,
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
    } catch (err: any) {
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

    if (!existsSync(join(dir, 'CORE.md'))) {
      console.error(`Error: No harness found in ${dir}`);
      process.exit(1);
    }

    const conv = new Conversation(dir);
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
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
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
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
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

    try {
      const config = loadConfig(dir);
      const ctx = buildSystemPrompt(dir, config);
      console.log(ctx.systemPrompt);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- DEV (watch mode) ---
program
  .command('dev')
  .description('Start dev mode — watches for file changes and rebuilds indexes')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { rebuildAllIndexes } = await import('../runtime/indexer.js');
    const { createWatcher } = await import('../runtime/watcher.js');
    const dir = resolve(opts.dir);

    if (!existsSync(join(dir, 'CORE.md'))) {
      console.error(`Error: No harness found in ${dir}`);
      process.exit(1);
    }

    const config = loadConfig(dir);
    console.log(`\n[dev] Watching "${config.agent.name}" harness at ${dir}`);

    // Initial index build
    rebuildAllIndexes(dir);
    console.log(`[dev] Indexes rebuilt`);

    // Start watching
    createWatcher({
      harnessDir: dir,
      onChange: (path, event) => {
        const rel = path.replace(dir + '/', '');
        console.log(`[dev] ${event}: ${rel}`);
      },
      onIndexRebuild: (directory) => {
        console.log(`[dev] Index rebuilt: ${directory}/_index.md`);
      },
    });

    console.log(`[dev] Watching for changes... (Ctrl+C to stop)\n`);
  });

// --- INDEX (rebuild all indexes) ---
program
  .command('index')
  .description('Rebuild all index files')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { rebuildAllIndexes } = await import('../runtime/indexer.js');
    const dir = resolve(opts.dir);

    rebuildAllIndexes(dir);
    console.log(`✓ All indexes rebuilt in ${dir}`);
  });

// --- JOURNAL (synthesize sessions into journal) ---
program
  .command('journal')
  .description('Synthesize today\'s sessions into a journal entry')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--date <date>', 'Date to synthesize (YYYY-MM-DD)')
  .action(async (opts: { dir: string; date?: string }) => {
    const { synthesizeJournal } = await import('../runtime/journal.js');
    const dir = resolve(opts.dir);

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
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
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
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
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

program.parse();
