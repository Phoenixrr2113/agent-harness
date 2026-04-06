import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { config as loadDotenv } from 'dotenv';

// Load .env from current directory
loadDotenv();

const program = new Command();

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
  .option('-m, --model <model>', 'Model override')
  .action(async (prompt: string, opts: { dir: string; stream: boolean; model?: string }) => {
    const { createHarness } = await import('../core/harness.js');
    const dir = resolve(opts.dir);

    // Look for harness indicators
    if (!existsSync(join(dir, 'CORE.md')) && !existsSync(join(dir, 'config.yaml'))) {
      console.error(`Error: No harness found in ${dir}`);
      console.error(`Run "harness init <name>" to create one.`);
      process.exit(1);
    }

    try {
      const agent = createHarness({
        dir,
        model: opts.model,
        config: opts.model ? { model: { id: opts.model, provider: 'openrouter', max_tokens: 200000 } } : undefined,
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
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- CHAT (interactive REPL) ---
program
  .command('chat')
  .description('Start an interactive chat session with the agent')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-m, --model <model>', 'Model override')
  .action(async (opts: { dir: string; model?: string }) => {
    const { createHarness } = await import('../core/harness.js');
    const readline = await import('readline');
    const dir = resolve(opts.dir);

    if (!existsSync(join(dir, 'CORE.md')) && !existsSync(join(dir, 'config.yaml'))) {
      console.error(`Error: No harness found in ${dir}`);
      process.exit(1);
    }

    const agent = createHarness({
      dir,
      config: opts.model ? { model: { id: opts.model, provider: 'openrouter', max_tokens: 200000 } } : undefined,
    });

    await agent.boot();

    console.log(`\n${agent.name} is ready. Type your message or "exit" to quit.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      rl.question('> ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
          await agent.shutdown();
          rl.close();
          return;
        }

        try {
          process.stdout.write('\n');
          for await (const chunk of agent.stream(trimmed)) {
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

program.parse();
