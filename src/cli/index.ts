import { Command } from 'commander';
import { resolve, join, basename } from 'path';
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

/** Ask a question via readline and return the answer */
function askQuestion(rl: ReturnType<typeof import('readline').createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

program
  .command('init [name]')
  .description('Scaffold a new agent harness directory (interactive if no name given)')
  .option('-d, --dir <path>', 'Parent directory', '.')
  .option('-t, --template <name>', 'Config template (base, claude-opus, gpt4, local)', 'base')
  .option('-p, --purpose <description>', 'Agent purpose description')
  .option('-i, --interactive', 'Force interactive mode', false)
  .option('--generate', 'Generate CORE.md using LLM (requires API key)', false)
  .option('--no-discover-mcp', 'Skip MCP server auto-discovery')
  .option('--no-discover-env', 'Skip environment variable scanning')
  .option('--no-discover-project', 'Skip project context detection')
  .action(async (name: string | undefined, opts: { dir: string; template: string; purpose?: string; interactive: boolean; generate: boolean; discoverMcp: boolean; discoverEnv: boolean; discoverProject: boolean }) => {
    const { scaffoldHarness, generateCoreMd, listTemplates } = await import('./scaffold.js');

    // Interactive mode: no name provided or --interactive flag
    const isInteractive = !name || opts.interactive;
    let agentName = name ?? '';
    let purpose = opts.purpose ?? '';
    let template = opts.template;
    let shouldGenerate = opts.generate;

    if (isInteractive && process.stdin.isTTY) {
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log('\n  Agent Harness Setup\n');

        if (!agentName) {
          agentName = await askQuestion(rl, '  Agent name', 'my-agent');
        }

        if (!purpose) {
          purpose = await askQuestion(rl, '  What does this agent do? (purpose)');
        }

        const templates = listTemplates();
        if (templates.length > 1) {
          console.log(`  Available templates: ${templates.join(', ')}`);
          template = await askQuestion(rl, '  Template', template);
        }

        if (purpose && !shouldGenerate) {
          // Check if an API key is available for LLM generation
          const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
          if (hasKey) {
            const gen = await askQuestion(rl, '  Generate CORE.md using AI? (y/n)', 'y');
            shouldGenerate = gen.toLowerCase() === 'y' || gen.toLowerCase() === 'yes';
          }
        }

        console.log();
      } finally {
        rl.close();
      }
    }

    if (!agentName) {
      console.error('Error: agent name is required. Usage: harness init <name>');
      process.exit(1);
    }

    const targetDir = resolve(opts.dir, agentName);
    const parentDir = resolve(opts.dir);

    try {
      // Generate CORE.md via LLM if requested
      let coreContent: string | undefined;
      if (shouldGenerate && purpose) {
        console.log('Generating CORE.md...');
        const generated = await generateCoreMd(agentName, purpose, {});
        if (generated) {
          coreContent = generated;
          console.log('✓ CORE.md generated via LLM');
        } else {
          console.log('  LLM generation failed, using template instead');
        }
      }

      scaffoldHarness(targetDir, agentName, { template, purpose: purpose || undefined, coreContent });
      console.log(`\n✓ Agent harness created: ${targetDir}`);

      // Auto-discover MCP servers from other tools
      if (opts.discoverMcp !== false) {
        const { discoverMcpServers, discoveredServersToYaml } = await import('../runtime/mcp-discovery.js');
        const discovery = discoverMcpServers();

        if (discovery.totalServers > 0) {
          // Write discovered servers into config.yaml
          const { appendFileSync } = await import('fs');
          const configPath = resolve(targetDir, 'config.yaml');
          const yaml = discoveredServersToYaml(discovery.servers);
          appendFileSync(configPath, '\n' + yaml + '\n');

          console.log(`\n✓ Discovered ${discovery.totalServers} MCP server(s) from existing tools:`);
          for (const source of discovery.sources) {
            if (source.servers.length > 0) {
              console.log(`  ${source.tool}: ${source.servers.map((s) => s.name).join(', ')}`);
            }
          }
          console.log(`  → Added to config.yaml (edit to enable/disable)`);
        }
      }

      // Auto-discover environment variables
      if (opts.discoverEnv !== false) {
        const { discoverEnvKeys } = await import('../runtime/env-discovery.js');
        const envResult = discoverEnvKeys({ dir: parentDir, extraDirs: [targetDir] });

        if (envResult.suggestions.length > 0) {
          console.log(`\n✓ Detected ${envResult.keys.length} API key(s) in environment:`);
          for (const suggestion of envResult.suggestions) {
            console.log(`  ${suggestion.triggeredBy} → ${suggestion.message}`);
            console.log(`    Install: harness mcp install "${suggestion.serverQuery}" -d ${name}`);
          }
        }
      }

      // Auto-discover project context
      if (opts.discoverProject !== false) {
        const { discoverProjectContext } = await import('../runtime/project-discovery.js');
        const projectResult = discoverProjectContext({ dir: parentDir });

        if (projectResult.signals.length > 0) {
          const stack = projectResult.signals.map((s) => s.name).join(', ');
          console.log(`\n✓ Detected project stack: ${stack}`);

          if (projectResult.suggestions.length > 0) {
            console.log(`  Suggestions:`);
            for (const suggestion of projectResult.suggestions) {
              if (suggestion.type === 'mcp-server') {
                console.log(`    Install MCP: harness mcp install "${suggestion.target}" -d ${name}`);
              } else {
                console.log(`    Create ${suggestion.type}: ${suggestion.target}`);
              }
            }
          }
        }
      }

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
  .option('-k, --api-key <key>', 'API key override (default: from environment)')
  .action(async (prompt: string, opts: { dir: string; stream: boolean; model?: string; provider?: string; apiKey?: string }) => {
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
        apiKey: opts.apiKey,
      });

      if (opts.stream) {
        const streamResult = agent.stream(prompt);
        process.stdout.write('\n');
        for await (const chunk of streamResult.textStream) {
          process.stdout.write(chunk);
        }
        process.stdout.write('\n\n');
        const result = await streamResult.result;
        const toolInfo = result.toolCalls.length > 0
          ? ` | ${result.toolCalls.length} tool call(s)`
          : '';
        const stepInfo = result.steps > 1 ? ` | ${result.steps} steps` : '';
        console.error(
          `[${result.usage.totalTokens} tokens${stepInfo}${toolInfo} | session: ${result.session_id}]`
        );
      } else {
        const result = await agent.run(prompt);
        console.log('\n' + result.text + '\n');
        const toolInfo = result.toolCalls.length > 0
          ? ` | ${result.toolCalls.length} tool call(s)`
          : '';
        const stepInfo = result.steps > 1 ? ` | ${result.steps} steps` : '';
        console.error(
          `[${result.usage.totalTokens} tokens${stepInfo}${toolInfo} | session: ${result.session_id}]`
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
  .option('-p, --provider <provider>', 'Provider override (openrouter, anthropic, openai)')
  .option('-k, --api-key <key>', 'API key override (default: from environment)')
  .option('--fresh', 'Start fresh (clear conversation history)', false)
  .action(async (opts: { dir: string; model?: string; provider?: string; apiKey?: string; fresh: boolean }) => {
    const { Conversation } = await import('../runtime/conversation.js');
    const { loadConfig } = await import('../core/config.js');
    const { buildToolSet } = await import('../runtime/tool-executor.js');
    const { createMcpManager } = await import('../runtime/mcp.js');
    const readline = await import('readline');
    const dir = resolve(opts.dir);

    requireHarness(dir);

    const config = loadConfig(dir);

    // Load tools (markdown + programmatic + MCP)
    let mcpTools: Record<string, unknown> = {};
    const mcpManager = createMcpManager(config);
    if (mcpManager.hasServers()) {
      try {
        await mcpManager.connect();
        mcpTools = mcpManager.getTools();
      } catch (err: unknown) {
        console.error(`Warning: MCP connection failed: ${formatError(err)}`);
      }
    }
    const toolSet = buildToolSet(dir, undefined, mcpTools as Record<string, never>);
    const toolCount = Object.keys(toolSet).length;

    const conv = new Conversation(dir, opts.apiKey, { tools: toolSet });
    const modelId = resolveModel(opts.model);
    if (modelId) conv.setModelOverride(modelId);
    if (opts.provider) conv.setProviderOverride(opts.provider);
    if (opts.fresh) conv.clear();
    await conv.init();

    const history = conv.getHistory();
    console.log(`\n${config.agent.name} is ready. ${history.length > 0 ? `(${history.length} messages in history)` : ''}${toolCount > 0 ? ` | ${toolCount} tools` : ''}`);
    console.log(`Type your message, "clear" to reset, or "exit" to quit.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let closed = false;
    let sending = false;    // Track in-flight LLM requests
    let pendingClose = false; // Deferred close requested while sending

    const cleanup = async () => {
      if (mcpManager.hasServers()) {
        await mcpManager.close();
      }
    };

    const doClose = async () => {
      if (closed) return;
      closed = true;
      await cleanup();
    };

    rl.on('close', async () => {
      if (sending) {
        // Defer cleanup until the in-flight request finishes
        pendingClose = true;
        return;
      }
      await doClose();
    });

    const ask = () => {
      if (closed) return;
      rl.question('> ', async (input) => {
        if (closed) return;
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
          await doClose();
          rl.close();
          return;
        }
        if (trimmed === 'clear') {
          conv.clear();
          console.log('[conversation cleared]\n');
          ask();
          return;
        }

        sending = true;
        try {
          const streamResult = conv.sendStream(trimmed);
          process.stdout.write('\n');
          for await (const chunk of streamResult.textStream) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n');
          const meta = await streamResult.result;
          if (meta.usage.totalTokens > 0) {
            const toolInfo = meta.toolCalls.length > 0
              ? ` | ${meta.toolCalls.length} tool call(s)`
              : '';
            const stepInfo = meta.steps > 1 ? ` | ${meta.steps} steps` : '';
            console.error(`[${meta.usage.totalTokens} tokens${stepInfo}${toolInfo}]`);
          }
          process.stdout.write('\n');
        } catch (err: unknown) {
          console.error(`Error: ${formatError(err)}`);
        } finally {
          sending = false;
          // If readline closed while we were sending, clean up now
          if (pendingClose) {
            await doClose();
            return;
          }
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
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; json: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const { buildSystemPrompt } = await import('../runtime/context-loader.js');
    const { loadState } = await import('../runtime/state.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      const ctx = buildSystemPrompt(dir, config);
      const state = loadState(dir);

      // MCP servers
      const mcpServers = config.mcp?.servers ?? {};
      const mcpEntries = Object.entries(mcpServers);

      if (opts.json) {
        const info = {
          agent: { name: config.agent.name, version: config.agent.version },
          model: config.model.id,
          provider: config.model.provider,
          state: { mode: state.mode, last_interaction: state.last_interaction },
          context: {
            max_tokens: ctx.budget.max_tokens,
            used_tokens: ctx.budget.used_tokens,
            remaining: ctx.budget.remaining,
            loaded_files: ctx.budget.loaded_files,
          },
          mcp: mcpEntries.map(([name, s]) => ({
            name,
            transport: s.transport,
            enabled: s.enabled !== false,
          })),
        };
        console.log(JSON.stringify(info, null, 2));
        return;
      }

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

      if (mcpEntries.length > 0) {
        const enabledCount = mcpEntries.filter(([, s]) => s.enabled !== false).length;
        console.log(`\nMCP servers: ${mcpEntries.length} configured (${enabledCount} enabled)`);
        for (const [name, s] of mcpEntries) {
          const enabled = s.enabled !== false;
          console.log(`  ${enabled ? '+' : '-'} ${name} (${s.transport})`);
        }
      }
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
  .option('--json', 'Output metadata as JSON (includes prompt, budget, warnings)')
  .action(async (opts: { dir: string; json: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const { buildSystemPrompt } = await import('../runtime/context-loader.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      const config = loadConfig(dir);
      const ctx = buildSystemPrompt(dir, config);

      if (opts.json) {
        console.log(JSON.stringify({
          systemPrompt: ctx.systemPrompt,
          budget: ctx.budget,
          warnings: ctx.warnings,
          parseErrors: ctx.parseErrors,
        }, null, 2));
        return;
      }

      console.log(ctx.systemPrompt);
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- DEV (watch mode + scheduler) ---
program
  .command('dev')
  .description('Start dev mode — watches for file changes, rebuilds indexes, runs scheduled workflows, serves dashboard')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-k, --api-key <key>', 'API key override (default: from environment)')
  .option('--no-schedule', 'Disable workflow scheduler')
  .option('--no-auto-process', 'Disable auto-processing of primitives on save')
  .option('--no-web', 'Disable web dashboard server')
  .option('-p, --port <number>', 'Web dashboard port', '3000')
  .action(async (opts: { dir: string; apiKey?: string; schedule: boolean; autoProcess: boolean; web: boolean; port: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { rebuildAllIndexes } = await import('../runtime/indexer.js');
    const { createWatcher } = await import('../runtime/watcher.js');
    const { Scheduler } = await import('../runtime/scheduler.js');
    const { autoProcessAll } = await import('../runtime/auto-processor.js');
    const { generateSystemMd } = await import('../cli/scaffold.js');
    const { writeFileSync } = await import('fs');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);

    requireHarness(dir);

    const config = loadConfig(dir);
    const doAutoProcess = opts.autoProcess && (config.runtime?.auto_process !== false);
    console.log(`\n[dev] Watching "${config.agent.name}" harness at ${dir}`);

    // Auto-process all primitives on startup (fills missing frontmatter, L0/L1)
    if (doAutoProcess) {
      const processed = autoProcessAll(dir);
      if (processed.length > 0) {
        console.log(`[dev] Auto-processed ${processed.length} file(s) on startup`);
        for (const r of processed) {
          const rel = r.path.replace(dir + '/', '');
          console.log(`  ${rel}: ${r.fixes.join(', ')}`);
        }
      }
    }

    // Regenerate SYSTEM.md from current directory structure
    const systemPath = join(dir, 'SYSTEM.md');
    const newSystem = generateSystemMd(dir, config.agent.name);
    writeFileSync(systemPath, newSystem, 'utf-8');
    console.log(`[dev] SYSTEM.md regenerated from directory structure`);

    // Initial index build
    const extDirs = config.extensions?.directories ?? [];
    rebuildAllIndexes(dir, extDirs);
    console.log(`[dev] Indexes rebuilt${extDirs.length ? ` (+ ${extDirs.length} extension dir(s))` : ''}`);

    // Start scheduler if there are workflows
    let scheduler: InstanceType<typeof Scheduler> | null = null;
    if (opts.schedule) {
      scheduler = new Scheduler({
        harnessDir: dir,
        apiKey: opts.apiKey,
        autoJournal: config.intelligence?.auto_journal ?? false,
        autoLearn: config.intelligence?.auto_learn ?? false,
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
        onJournal: (date, sessionsCount) => {
          console.log(`[scheduler] Auto-journal: synthesized ${sessionsCount} session(s) for ${date}`);
        },
        onLearn: (installed, skipped) => {
          console.log(`[scheduler] Auto-learn: ${installed} instinct(s) installed, ${skipped} skipped`);
        },
      });
      scheduler.start();

      const scheduled = scheduler.listScheduled();
      const features: string[] = [];
      if (scheduled.length > 0) features.push(`${scheduled.length} workflow(s)`);
      if (config.intelligence?.auto_journal) features.push('auto-journal');
      if (config.intelligence?.auto_learn) features.push('auto-learn');
      if (features.length > 0) {
        console.log(`[dev] Scheduler started: ${features.join(', ')}`);
      } else {
        console.log(`[dev] Scheduler running (no workflows or intelligence features configured)`);
      }
    }

    // Start web dashboard server
    let webServer: { server: unknown; broadcaster: { broadcast: (e: { type: string; data: unknown; timestamp: string }) => void } } | null = null;
    if (opts.web) {
      const { startWebServer } = await import('../runtime/web-server.js');
      const port = parseInt(opts.port, 10) || 3000;
      webServer = startWebServer({
        harnessDir: dir,
        port,
        apiKey: opts.apiKey,
        onStart: (p) => console.log(`[dev] Dashboard: http://localhost:${p}`),
      });
    }

    const sseBroadcast = (type: string, data: unknown): void => {
      webServer?.broadcaster.broadcast({ type, data, timestamp: new Date().toISOString() });
    };

    // Start watching (including extension directories and config.yaml)
    createWatcher({
      harnessDir: dir,
      extraDirs: extDirs,
      watchConfig: true,
      autoProcess: doAutoProcess,
      onChange: (path, event) => {
        const rel = path.replace(dir + '/', '');
        console.log(`[dev] ${event}: ${rel}`);
        sseBroadcast('file_change', { path: rel, event });
      },
      onIndexRebuild: (directory) => {
        console.log(`[dev] Index rebuilt: ${directory}/_index.md`);
        sseBroadcast('index_rebuild', { directory });
      },
      onAutoProcess: (result) => {
        if (result.modified) {
          const rel = result.path.replace(dir + '/', '');
          console.log(`[dev] Auto-processed: ${rel} (${result.fixes.join(', ')})`);
          sseBroadcast('auto_process', { path: rel, fixes: result.fixes });
        }
      },
      onConfigChange: () => {
        try {
          const newConfig = loadConfig(dir);
          console.log(`[dev] Config reloaded: model=${newConfig.model.id}`);
          sseBroadcast('config_change', { model: newConfig.model.id });
        } catch (err: unknown) {
          console.error(`[dev] Config reload failed: ${formatError(err)}`);
        }
      },
      onError: (err) => {
        console.error(`[dev] Watcher error: ${err.message}`);
      },
    });

    console.log(`[dev] Watching for changes... (Ctrl+C to stop)\n`);

    // Graceful shutdown
    const cleanup = () => {
      console.log(`\n[dev] Shutting down...`);
      if (scheduler) scheduler.stop();
      if (webServer?.server && typeof (webServer.server as { close?: () => void }).close === 'function') {
        (webServer.server as { close: () => void }).close();
      }
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
    } catch (err) {
      if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    rebuildAllIndexes(dir, extDirs);
    console.log(`✓ All indexes rebuilt in ${dir}`);
  });

// --- PROCESS (auto-process all primitives) ---
program
  .command('process')
  .description('Auto-process all primitives: fill missing frontmatter and generate L0/L1 summaries')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--no-frontmatter', 'Skip frontmatter generation')
  .option('--no-summaries', 'Skip L0/L1 summary generation')
  .action(async (opts: { dir: string; frontmatter: boolean; summaries: boolean }) => {
    const { autoProcessAll } = await import('../runtime/auto-processor.js');
    const dir = resolve(opts.dir);

    requireHarness(dir);

    const results = autoProcessAll(dir, {
      generateFrontmatter: opts.frontmatter,
      generateSummaries: opts.summaries,
    });

    if (results.length === 0) {
      console.log('All primitives are up to date.');
    } else {
      for (const r of results) {
        const rel = r.path.replace(dir + '/', '');
        if (r.modified) {
          console.log(`✓ ${rel}: ${r.fixes.join(', ')}`);
        }
        for (const err of r.errors) {
          console.error(`✗ ${rel}: ${err}`);
        }
      }
      const modified = results.filter((r) => r.modified).length;
      const errors = results.filter((r) => r.errors.length > 0).length;
      console.log(`\nProcessed ${modified} file(s)${errors > 0 ? `, ${errors} error(s)` : ''}`);
    }
  });

// --- SYSTEM (regenerate SYSTEM.md from directory structure) ---
program
  .command('system')
  .description('Regenerate SYSTEM.md from current directory structure')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { generateSystemMd } = await import('../cli/scaffold.js');
    const { writeFileSync } = await import('fs');
    const dir = resolve(opts.dir);

    requireHarness(dir);

    const config = loadConfig(dir);
    const systemPath = join(dir, 'SYSTEM.md');
    const content = generateSystemMd(dir, config.agent.name);
    writeFileSync(systemPath, content, 'utf-8');
    console.log(`✓ SYSTEM.md regenerated at ${systemPath}`);
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
  .option('--auto-harvest', 'Auto-install instinct candidates from synthesized journals', false)
  .action(async (opts: { dir: string; date?: string; from?: string; to?: string; all: boolean; force: boolean; pending: boolean; autoHarvest: boolean }) => {
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

        // Auto-harvest: install instinct candidates from synthesized journals
        if (opts.autoHarvest) {
          const { harvestInstincts } = await import('../runtime/instinct-learner.js');
          const dates = entries.map((e) => e.date).sort();
          const harvest = harvestInstincts(dir, {
            from: dates[0],
            to: dates[dates.length - 1],
            install: true,
          });
          if (harvest.installed.length > 0) {
            console.log(`Auto-harvested ${harvest.installed.length} instinct(s):`);
            harvest.installed.forEach((id) => console.log(`  ✓ ${id}`));
            console.log();
          }
        }
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

        // Auto-harvest: install instinct candidates from this journal
        if (opts.autoHarvest) {
          const { harvestInstincts } = await import('../runtime/instinct-learner.js');
          const harvest = harvestInstincts(dir, {
            from: entry.date,
            to: entry.date,
            install: true,
          });
          if (harvest.installed.length > 0) {
            console.log(`  Auto-harvested:`);
            harvest.installed.forEach((id) => console.log(`    ✓ ${id}`));
          }
        }
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

// NOTE: "install" command moved to universal installer below (Phase 9)

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
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; json: boolean }) => {
    const { validateHarness } = await import('../runtime/validator.js');
    const dir = resolve(opts.dir);

    const result = validateHarness(dir);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (result.errors.length > 0) process.exit(1);
      return;
    }

    // Output results
    console.log(`\nHarness validation: ${dir}\n`);

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

    console.log(`\nSummary: ${result.ok.length} passed, ${result.warnings.length} warnings, ${result.errors.length} errors`);
    console.log(`Primitives: ${result.totalPrimitives} loaded${result.parseErrors.length > 0 ? `, ${result.parseErrors.length} parse error(s)` : ''}\n`);

    if (result.errors.length > 0) {
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

    // MCP Servers
    const mcpServers = config.mcp?.servers ?? {};
    const mcpEntries = Object.entries(mcpServers);
    if (mcpEntries.length > 0) {
      const enabledCount = mcpEntries.filter(([, s]) => s.enabled !== false).length;
      console.log(`\n  MCP Servers: ${mcpEntries.length} configured (${enabledCount} enabled)`);
      for (const [name, serverConfig] of mcpEntries) {
        const enabled = serverConfig.enabled !== false;
        const icon = enabled ? '+' : '-';
        const detail = serverConfig.transport === 'stdio'
          ? serverConfig.command ?? ''
          : serverConfig.url ?? '';
        console.log(`    [${icon}] ${name} (${serverConfig.transport}) ${detail}`);
      }
    }

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
  .option('--json', 'Output as JSON')
  .action(async (query: string | undefined, opts: { dir: string; tag?: string; type?: string; status?: string; author?: string; json: boolean }) => {
    const { searchPrimitives } = await import('../runtime/search.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try {
      config = loadConfig(dir);
    } catch (err) {
      if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const results = searchPrimitives(dir, query, {
      tag: opts.tag,
      type: opts.type,
      status: opts.status,
      author: opts.author,
    }, config);

    if (opts.json) {
      console.log(JSON.stringify(results.map((r) => ({
        id: r.doc.frontmatter.id,
        directory: r.directory,
        status: r.doc.frontmatter.status,
        tags: r.doc.frontmatter.tags,
        l0: r.doc.l0,
        matchReason: r.matchReason,
      })), null, 2));
      return;
    }

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

// --- BUNDLE (pack primitives into shareable bundle) ---
program
  .command('bundle <output>')
  .description('Pack primitives into a shareable bundle with manifest.yaml')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-n, --name <name>', 'Bundle name')
  .option('--description <text>', 'Bundle description', '')
  .option('--author <name>', 'Author name')
  .option('--version <ver>', 'Bundle version', '1.0.0')
  .option('-t, --types <types...>', 'Primitive types to include (e.g., rules instincts)')
  .option('-f, --files <files...>', 'Specific files to include (relative paths)')
  .option('--tags <tags...>', 'Tags for search/discovery')
  .option('--license <id>', 'License identifier (e.g., MIT)')
  .option('--json', 'Output as JSON', false)
  .action(async (output: string, opts: { dir: string; name?: string; description: string; author?: string; version: string; types?: string[]; files?: string[]; tags?: string[]; license?: string; json: boolean }) => {
    const { packBundle, writeBundleDir } = await import('../runtime/primitive-registry.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const bundleName = opts.name ?? basename(dir);
    const bundle = packBundle(dir, {
      name: bundleName,
      description: opts.description,
      author: opts.author,
      version: opts.version,
      types: opts.types,
      files: opts.files,
      tags: opts.tags,
      license: opts.license,
    });

    const outputPath = resolve(output);
    writeBundleDir(bundle, outputPath);

    if (opts.json) {
      console.log(JSON.stringify(bundle.manifest, null, 2));
    } else {
      console.log(`\nBundled "${bundleName}" v${opts.version}`);
      console.log(`  ${bundle.files.length} files in ${bundle.manifest.types.join(', ')}`);
      console.log(`  Output: ${outputPath}/`);
      console.log(`  Manifest: ${outputPath}/manifest.yaml\n`);
    }
  });

// --- BUNDLE INSTALL (install from bundle directory or URL) ---
program
  .command('bundle-install <source>')
  .description('Install primitives from a bundle directory, JSON file, or URL')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--overwrite', 'Overwrite existing files', false)
  .option('--force', 'Skip dependency checks', false)
  .option('--json', 'Output as JSON', false)
  .action(async (source: string, opts: { dir: string; overwrite: boolean; force: boolean; json: boolean }) => {
    const { readBundleDir, installBundle, fetchRemoteBundle } = await import('../runtime/primitive-registry.js');
    const { readBundle } = await import('../runtime/export.js');
    const dir = resolve(opts.dir);

    try {
      let bundle;

      if (source.startsWith('https://') || source.startsWith('http://')) {
        console.log(`Downloading bundle from ${source}...`);
        bundle = await fetchRemoteBundle(source);
      } else {
        const sourcePath = resolve(source);
        // Check if it's a directory with manifest.yaml
        if (existsSync(join(sourcePath, 'manifest.yaml'))) {
          bundle = readBundleDir(sourcePath);
        } else if (source.endsWith('.json')) {
          // Legacy JSON bundle — convert
          const jsonBundle = readBundle(sourcePath);
          const { CORE_PRIMITIVE_DIRS } = await import('../core/types.js');
          const files = jsonBundle.entries;
          const types = new Set<string>();
          for (const entry of files) {
            const entryDir = entry.path.split('/')[0];
            if ((CORE_PRIMITIVE_DIRS as readonly string[]).includes(entryDir)) types.add(entryDir);
          }
          bundle = {
            manifest: {
              version: '1.0',
              name: jsonBundle.agent_name ?? 'imported',
              description: 'Imported from JSON bundle',
              author: 'unknown',
              bundle_version: '1.0.0',
              created: jsonBundle.exported_at ?? new Date().toISOString(),
              types: [...types],
              tags: [],
              files: files.map((f) => ({ path: f.path, type: f.path.split('/')[0], id: basename(f.path, '.md'), l0: '' })),
            },
            files,
          };
        } else {
          console.error(`Error: ${sourcePath} is not a bundle directory (no manifest.yaml) or JSON file`);
          process.exit(1);
        }
      }

      const result = installBundle(dir, bundle, { overwrite: opts.overwrite, force: opts.force });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.installed) {
          console.log(`\nInstalled "${result.name}"`);
          console.log(`  Files: ${result.files.length} installed, ${result.skipped.length} skipped`);
          if (result.files.length > 0) {
            for (const f of result.files) console.log(`    + ${f}`);
          }
          if (result.skipped.length > 0) {
            for (const f of result.skipped) console.log(`    = ${f} (exists)`);
          }
        } else {
          console.error(`\nInstallation failed:`);
          for (const err of result.errors) console.error(`  - ${err}`);
        }
        console.log();
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- UNINSTALL (soft-delete primitives) ---
program
  .command('uninstall <bundle-name>')
  .description('Uninstall a previously installed bundle (moves files to archive/)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--hard', 'Permanently delete files instead of archiving', false)
  .option('--json', 'Output as JSON', false)
  .action(async (bundleName: string, opts: { dir: string; hard: boolean; json: boolean }) => {
    const { uninstallBundle } = await import('../runtime/primitive-registry.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const result = uninstallBundle(dir, bundleName, { hard: opts.hard });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.uninstalled) {
        console.log(`\nUninstalled "${bundleName}"`);
        console.log(`  ${result.archived.length} files ${opts.hard ? 'deleted' : 'archived'}`);
        for (const f of result.archived) console.log(`    - ${f}`);
      } else {
        console.error(`\nUninstall failed:`);
        for (const err of result.errors) console.error(`  - ${err}`);
        if (result.dependents.length > 0) {
          console.error(`  Dependents: ${result.dependents.join(', ')}`);
        }
      }
      console.log();
    }
  });

// --- UPDATE (update installed bundle) ---
program
  .command('update <source>')
  .description('Update an installed bundle from a new version')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--remove-deleted', 'Archive files removed in new version', false)
  .option('--json', 'Output as JSON', false)
  .action(async (source: string, opts: { dir: string; removeDeleted: boolean; json: boolean }) => {
    const { readBundleDir, diffBundle, updateBundle, fetchRemoteBundle } = await import('../runtime/primitive-registry.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    try {
      let bundle;

      if (source.startsWith('https://') || source.startsWith('http://')) {
        console.log(`Downloading bundle from ${source}...`);
        bundle = await fetchRemoteBundle(source);
      } else {
        const sourcePath = resolve(source);
        if (!existsSync(join(sourcePath, 'manifest.yaml'))) {
          console.error(`Error: ${sourcePath} is not a bundle directory (no manifest.yaml)`);
          process.exit(1);
        }
        bundle = readBundleDir(sourcePath);
      }

      // Show diff first
      const diff = diffBundle(dir, bundle);
      if (diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0) {
        console.log(`\n"${bundle.manifest.name}" is already up to date.\n`);
        return;
      }

      if (!opts.json) {
        console.log(`\nUpdate "${bundle.manifest.name}" to v${bundle.manifest.bundle_version}:`);
        if (diff.added.length > 0) {
          console.log(`  Added (${diff.added.length}):`);
          for (const f of diff.added) console.log(`    + ${f}`);
        }
        if (diff.modified.length > 0) {
          console.log(`  Modified (${diff.modified.length}):`);
          for (const f of diff.modified) console.log(`    ~ ${f}`);
        }
        if (diff.removed.length > 0) {
          console.log(`  Removed (${diff.removed.length}):`);
          for (const f of diff.removed) console.log(`    - ${f}`);
        }
        console.log();
      }

      const result = updateBundle(dir, bundle, { removeDeleted: opts.removeDeleted });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.updated) {
          console.log(`Updated "${result.name}" ${result.oldVersion ?? '?'} → ${result.newVersion ?? '?'}`);
          console.log(`  ${result.added.length} added, ${result.modified.length} modified, ${result.removed.length} removed`);
        } else {
          console.error(`Update failed:`);
          for (const err of result.errors) console.error(`  - ${err}`);
        }
        console.log();
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- INSTALLED (list installed bundles) ---
program
  .command('installed')
  .description('List installed bundles')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; json: boolean }) => {
    const { listInstalledBundles } = await import('../runtime/primitive-registry.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const bundles = listInstalledBundles(dir);

    if (opts.json) {
      console.log(JSON.stringify(bundles, null, 2));
    } else {
      if (bundles.length === 0) {
        console.log('\nNo bundles installed.\n');
      } else {
        console.log(`\n${bundles.length} bundle(s) installed:\n`);
        for (const b of bundles) {
          console.log(`  ${b.name} v${b.version} — ${b.description}`);
          console.log(`    ${b.fileCount} files, types: ${b.types.join(', ')}`);
        }
        console.log();
      }
    }
  });

// --- REGISTRY (search/install from configured registries) ---
const registryCmd = program.command('registry').description('Search and install bundles from configured registries');

registryCmd
  .command('search <query>')
  .description('Search all configured registries for bundles')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--limit <n>', 'Max results', '20')
  .option('--json', 'Output as JSON', false)
  .action(async (query: string, opts: { dir: string; limit: string; json: boolean }) => {
    const { searchConfiguredRegistries } = await import('../runtime/primitive-registry.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const registries = config.registries ?? [];
    if (registries.length === 0) {
      console.error('No registries configured. Add registries: to config.yaml');
      process.exit(1);
    }

    try {
      const result = await searchConfiguredRegistries(registries, query, { limit: parseInt(opts.limit, 10) });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\nSearched ${result.registriesSearched} registry(ies) for "${query}"\n`);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.log(`  [warn] ${err.registry}: ${err.error}`);
        }
        console.log();
      }

      if (result.results.length === 0) {
        console.log('No bundles found.\n');
        return;
      }

      for (const r of result.results) {
        console.log(`  ${r.name} v${r.version} — ${r.description}`);
        console.log(`    types: ${r.types.join(', ')} | tags: ${r.tags.join(', ') || 'none'} | from: ${r.registryName}`);
      }
      console.log(`\n  ${result.total} result(s) total\n`);
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

registryCmd
  .command('install <bundle-name>')
  .description('Install a bundle from configured registries')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--version <ver>', 'Specific version to install')
  .option('--overwrite', 'Overwrite existing files', false)
  .option('--force', 'Skip dependency checks', false)
  .option('--json', 'Output as JSON', false)
  .action(async (bundleName: string, opts: { dir: string; version?: string; overwrite: boolean; force: boolean; json: boolean }) => {
    const { installFromRegistry } = await import('../runtime/primitive-registry.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const registries = config.registries ?? [];
    if (registries.length === 0) {
      console.error('No registries configured. Add registries: to config.yaml');
      process.exit(1);
    }

    try {
      console.log(`\nSearching registries for "${bundleName}"...`);
      const result = await installFromRegistry(dir, registries, bundleName, {
        version: opts.version,
        overwrite: opts.overwrite,
        force: opts.force,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.installed) {
        console.log(`Installed "${result.name}" from ${result.registryUrl ?? 'registry'}`);
        console.log(`  Files: ${result.files.length} installed, ${result.skipped.length} skipped`);
        if (result.files.length > 0) {
          for (const f of result.files) console.log(`    + ${f}`);
        }
        if (result.skipped.length > 0) {
          for (const f of result.skipped) console.log(`    = ${f} (exists)`);
        }
      } else {
        console.error(`\nInstallation failed:`);
        for (const err of result.errors) console.error(`  - ${err}`);
      }
      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

registryCmd
  .command('list')
  .description('List configured registries')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; json: boolean }) => {
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const registries = config.registries ?? [];

    if (opts.json) {
      console.log(JSON.stringify(registries, null, 2));
      return;
    }

    if (registries.length === 0) {
      console.log('\nNo registries configured.');
      console.log('Add to config.yaml:\n');
      console.log('  registries:');
      console.log('    - url: https://registry.example.com');
      console.log('      name: My Registry\n');
      return;
    }

    console.log(`\n${registries.length} registry(ies) configured:\n`);
    for (const reg of registries) {
      const name = reg.name ?? reg.url;
      const auth = reg.token ? ' (authenticated)' : '';
      console.log(`  ${name}${auth}`);
      console.log(`    ${reg.url}`);
    }
    console.log();
  });

// --- GRAPH (dependency analysis) ---
program
  .command('graph')
  .description('Analyze primitive dependency graph (related:/with: fields)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; json: boolean }) => {
    const { buildDependencyGraph, getGraphStats } = await import('../runtime/graph.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const graph = buildDependencyGraph(dir, config);
    const stats = getGraphStats(dir, config);

    if (opts.json) {
      console.log(JSON.stringify({ graph, stats }, null, 2));
      return;
    }

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
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; from?: string; to?: string; json: boolean }) => {
    const { getSessionAnalytics, getSessionsInRange } = await import('../runtime/analytics.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    if (opts.from || opts.to) {
      const sessions = getSessionsInRange(dir, opts.from, opts.to);
      const label = opts.from && opts.to ? `${opts.from} to ${opts.to}` : opts.from ? `from ${opts.from}` : `to ${opts.to}`;

      if (opts.json) {
        console.log(JSON.stringify({ range: label, sessions }, null, 2));
        return;
      }

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

    if (opts.json) {
      // Convert Map to plain object for JSON serialization
      const serializable = {
        ...analytics,
        modelUsage: Object.fromEntries(analytics.modelUsage),
      };
      console.log(JSON.stringify(serializable, null, 2));
      return;
    }

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

// --- INTELLIGENCE (auto-promote, dead detection, contradictions, enrichment) ---

program
  .command('auto-promote')
  .description('Find instinct patterns appearing 3+ times across journals and optionally install them')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--threshold <n>', 'Minimum occurrences across different dates', '3')
  .option('--install', 'Auto-install promoted instincts', false)
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; threshold: string; install: boolean; json: boolean }) => {
    const { autoPromoteInstincts } = await import('../runtime/intelligence.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const result = autoPromoteInstincts(dir, {
      threshold: parseInt(opts.threshold, 10),
      install: opts.install,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nScanned ${result.journalsScanned} journal(s)\n`);

    if (result.patterns.length === 0) {
      console.log('No patterns found meeting the threshold.\n');
      return;
    }

    console.log(`${result.patterns.length} pattern(s) found:\n`);
    for (const p of result.patterns) {
      const status = result.promoted.includes(behaviorToCliId(p.behavior))
        ? '✓ promoted'
        : result.skipped.includes(behaviorToCliId(p.behavior))
          ? '⊘ exists'
          : '○ candidate';
      console.log(`  [${status}] ${p.behavior}`);
      console.log(`    ${p.count}x across: ${p.journalDates.join(', ')}\n`);
    }

    if (!opts.install && result.patterns.length > 0) {
      console.log('Run with --install to create instinct files.\n');
    }
  });

function behaviorToCliId(behavior: string): string {
  return behavior.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50).replace(/-+$/, '');
}

program
  .command('dead-primitives')
  .description('Detect orphaned primitives not modified in 30+ days')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--days <n>', 'Threshold days since last modification', '30')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; days: string; json: boolean }) => {
    const { detectDeadPrimitives } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = detectDeadPrimitives(dir, config, {
      thresholdDays: parseInt(opts.days, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nScanned ${result.totalScanned} primitive(s) (threshold: ${result.thresholdDays} days)\n`);

    if (result.dead.length === 0) {
      console.log('No dead primitives found.\n');
      return;
    }

    console.log(`${result.dead.length} dead primitive(s):\n`);
    for (const d of result.dead) {
      console.log(`  ${d.id} (${d.directory})`);
      console.log(`    ${d.path} — last modified ${d.lastModified} (${d.daysSinceModified}d ago)\n`);
    }
  });

program
  .command('contradictions')
  .description('Detect contradictions between rules and instincts')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; json: boolean }) => {
    const { detectContradictions } = await import('../runtime/intelligence.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const result = detectContradictions(dir);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nChecked ${result.rulesChecked} rule(s) and ${result.instinctsChecked} instinct(s)\n`);

    if (result.contradictions.length === 0) {
      console.log('No contradictions detected.\n');
      return;
    }

    console.log(`${result.contradictions.length} contradiction(s) found:\n`);
    for (const c of result.contradictions) {
      console.log(`  [${c.severity}] ${c.reason}`);
      console.log(`    ${c.primitiveA.type}/${c.primitiveA.id}: "${c.primitiveA.text}"`);
      console.log(`    ${c.primitiveB.type}/${c.primitiveB.id}: "${c.primitiveB.text}"\n`);
    }
  });

program
  .command('enrich')
  .description('Enrich sessions with extracted topics, tools, and primitive references')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; from?: string; to?: string; json: boolean }) => {
    const { enrichSessions } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = enrichSessions(dir, config, { from: opts.from, to: opts.to });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nEnriched ${result.sessionsScanned} session(s)\n`);

    if (result.enriched.length === 0) {
      console.log('No sessions to enrich.\n');
      return;
    }

    for (const s of result.enriched) {
      console.log(`  ${s.sessionId}`);
      if (s.topics.length > 0) console.log(`    topics: ${s.topics.join(', ')}`);
      if (s.toolsUsed.length > 0) console.log(`    tools: ${s.toolsUsed.join(', ')}`);
      if (s.primitivesReferenced.length > 0) console.log(`    refs: ${s.primitivesReferenced.join(', ')}`);
      console.log(`    ${s.tokenCount} tokens, ${s.stepCount} steps, ${s.model}\n`);
    }
  });

program
  .command('suggest')
  .description('Suggest capabilities (skills/playbooks) for frequent uncovered session topics')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--min-frequency <n>', 'Minimum topic frequency', '3')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { dir: string; minFrequency: string; json: boolean }) => {
    const { suggestCapabilities } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = suggestCapabilities(dir, config, {
      minFrequency: parseInt(opts.minFrequency, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nAnalyzed ${result.topicsAnalyzed} topic(s) from ${result.sessionsScanned} session(s)\n`);

    if (result.suggestions.length === 0) {
      console.log('No capability gaps found.\n');
      return;
    }

    console.log(`${result.suggestions.length} suggestion(s):\n`);
    for (const s of result.suggestions) {
      console.log(`  "${s.topic}" — ${s.frequency}x in sessions`);
      console.log(`    Suggest: create a ${s.suggestedType}\n`);
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

// --- COSTS (spending tracker) ---
const costsCmd = program
  .command('costs')
  .description('View and manage API spending');

costsCmd
  .command('show')
  .description('Show spending summary (default: today)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; from?: string; to?: string; json: boolean }) => {
    const { getSpending } = await import('../runtime/cost-tracker.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const summary = getSpending(dir, opts.from, opts.to);
    const label = opts.from || opts.to
      ? `${opts.from ?? 'start'} to ${opts.to ?? 'now'}`
      : 'today';

    if (opts.json) {
      console.log(JSON.stringify({ period: label, ...summary }, null, 2));
      return;
    }

    if (summary.entries === 0) {
      console.log(`\nNo spending recorded for ${label}.\n`);
      return;
    }

    console.log(`\nSpending — ${label}\n`);
    console.log(`  Total: $${summary.total_cost_usd.toFixed(6)}`);
    console.log(`  Entries: ${summary.entries}`);
    console.log(`  Tokens: ${summary.total_input_tokens.toLocaleString()} in / ${summary.total_output_tokens.toLocaleString()} out`);

    const models = Object.entries(summary.by_model);
    if (models.length > 0) {
      console.log(`\n  By model:`);
      for (const [model, data] of models.sort((a, b) => b[1].cost_usd - a[1].cost_usd)) {
        console.log(`    ${model}: $${data.cost_usd.toFixed(6)} (${data.count} calls)`);
      }
    }

    const providers = Object.entries(summary.by_provider);
    if (providers.length > 0) {
      console.log(`\n  By provider:`);
      for (const [provider, data] of providers.sort((a, b) => b[1].cost_usd - a[1].cost_usd)) {
        console.log(`    ${provider}: $${data.cost_usd.toFixed(6)} (${data.count} calls)`);
      }
    }
    console.log();
  });

costsCmd
  .command('budget')
  .description('Check spending against budget limits')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--daily <usd>', 'Daily budget limit in USD')
  .option('--monthly <usd>', 'Monthly budget limit in USD')
  .action(async (opts: { dir: string; daily?: string; monthly?: string }) => {
    const { checkBudget } = await import('../runtime/cost-tracker.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const dailyLimit = opts.daily ? parseFloat(opts.daily) : undefined;
    const monthlyLimit = opts.monthly ? parseFloat(opts.monthly) : undefined;

    if (dailyLimit === undefined && monthlyLimit === undefined) {
      console.error('Error: Specify at least --daily or --monthly budget limit.');
      process.exit(1);
    }

    const status = checkBudget(dir, {
      daily_limit_usd: dailyLimit,
      monthly_limit_usd: monthlyLimit,
    });

    console.log('\nBudget Status\n');

    if (status.daily_limit_usd !== null) {
      const pct = status.daily_pct !== null ? ` (${status.daily_pct.toFixed(1)}%)` : '';
      console.log(`  Daily:   $${status.daily_spent_usd.toFixed(6)} / $${status.daily_limit_usd.toFixed(2)}${pct}`);
      if (status.daily_remaining_usd !== null) {
        console.log(`    Remaining: $${status.daily_remaining_usd.toFixed(6)}`);
      }
    }

    if (status.monthly_limit_usd !== null) {
      const pct = status.monthly_pct !== null ? ` (${status.monthly_pct.toFixed(1)}%)` : '';
      console.log(`  Monthly: $${status.monthly_spent_usd.toFixed(6)} / $${status.monthly_limit_usd.toFixed(2)}${pct}`);
      if (status.monthly_remaining_usd !== null) {
        console.log(`    Remaining: $${status.monthly_remaining_usd.toFixed(6)}`);
      }
    }

    if (status.alerts.length > 0) {
      console.log('\n  Alerts:');
      for (const alert of status.alerts) {
        console.log(`    ⚠ ${alert}`);
      }
    }
    console.log();

    // Exit 1 if any budget exceeded
    if (status.alerts.some((a) => a.includes('exceeded'))) {
      process.exit(1);
    }
  });

costsCmd
  .command('clear')
  .description('Clear all cost records')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--model <id>', 'Clear only entries for this model')
  .action(async (opts: { dir: string; model?: string }) => {
    const { clearCosts } = await import('../runtime/cost-tracker.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const removed = clearCosts(dir, opts.model);
    if (opts.model) {
      console.log(`Cleared ${removed} cost entry(ies) for model "${opts.model}".`);
    } else {
      console.log(`Cleared ${removed} total cost entry(ies).`);
    }
  });

// --- HEALTH (system health status) ---
program
  .command('health')
  .description('Show system health status and metrics')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--reset', 'Reset health metrics', false)
  .option('--json', 'Output as JSON')
  .action(async (opts: { dir: string; reset: boolean; json: boolean }) => {
    const { getHealthStatus, resetHealth } = await import('../runtime/health.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    if (opts.reset) {
      resetHealth(dir);
      console.log('Health metrics reset.');
      return;
    }

    const health = getHealthStatus(dir);

    if (opts.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }

    const statusIcon = health.status === 'healthy' ? 'OK' : health.status === 'degraded' ? 'WARN' : 'FAIL';
    console.log(`\nHealth: ${statusIcon} (${health.status})\n`);

    for (const check of health.checks) {
      const icon = check.status === 'pass' ? 'pass' : check.status === 'warn' ? 'WARN' : 'FAIL';
      console.log(`  [${icon}] ${check.name}: ${check.message}`);
    }

    console.log(`\n  Metrics:`);
    console.log(`    Total runs:    ${health.metrics.totalRuns}`);
    console.log(`    Successes:     ${health.metrics.totalSuccesses}`);
    console.log(`    Failures:      ${health.metrics.totalFailures}`);
    console.log(`    Consecutive:   ${health.metrics.consecutiveFailures} failure(s)`);

    if (health.metrics.bootedAt) {
      console.log(`    Booted at:     ${health.metrics.bootedAt}`);
    }
    if (health.metrics.lastSuccessfulRun) {
      console.log(`    Last success:  ${health.metrics.lastSuccessfulRun}`);
    }
    if (health.metrics.lastFailedRun) {
      console.log(`    Last failure:  ${health.metrics.lastFailedRun}`);
    }
    if (health.metrics.lastError) {
      console.log(`    Last error:    ${health.metrics.lastError.slice(0, 120)}`);
    }

    if (health.costToday > 0 || health.costThisMonth > 0) {
      console.log(`\n  Spending:`);
      console.log(`    Today:  $${health.costToday.toFixed(6)}`);
      console.log(`    Month:  $${health.costThisMonth.toFixed(6)}`);
    }

    console.log();
  });

// --- RATELIMIT (rate limit management) ---
const rateLimitCmd = program
  .command('ratelimit')
  .description('View and manage rate limit state');

rateLimitCmd
  .command('status')
  .description('Show current rate limit usage for a key')
  .argument('<key>', 'Rate limit key (e.g., tool:github, model:claude)')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--window <ms>', 'Window size in ms', '3600000')
  .action(async (key: string, opts: { dir: string; window: string }) => {
    const { getUsage } = await import('../runtime/rate-limiter.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const windowMs = parseInt(opts.window, 10) || 3600000;
    const usage = getUsage(dir, key, windowMs);

    const windowLabel = windowMs >= 3600000
      ? `${windowMs / 3600000}h`
      : windowMs >= 60000
        ? `${windowMs / 60000}m`
        : `${windowMs}ms`;

    console.log(`\nRate limit: ${key} (${windowLabel} window)\n`);
    console.log(`  Requests: ${usage.count}`);
    if (usage.oldest !== null) {
      console.log(`  Oldest: ${new Date(usage.oldest).toISOString()}`);
    }
    if (usage.newest !== null) {
      console.log(`  Newest: ${new Date(usage.newest).toISOString()}`);
    }
    console.log();
  });

rateLimitCmd
  .command('clear')
  .description('Clear rate limit events')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--key <key>', 'Clear only this key (clears all if omitted)')
  .action(async (opts: { dir: string; key?: string }) => {
    const { clearRateLimits } = await import('../runtime/rate-limiter.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const removed = clearRateLimits(dir, opts.key);
    if (opts.key) {
      console.log(`Cleared ${removed} event(s) for key "${opts.key}".`);
    } else {
      console.log(`Cleared ${removed} total event(s).`);
    }
  });

// --- MCP (Model Context Protocol server management) ---
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP (Model Context Protocol) server connections');

mcpCmd
  .command('list')
  .description('List configured MCP servers and their status')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { validateMcpConfig } = await import('../runtime/mcp.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const servers = config.mcp?.servers ?? {};
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      console.log('\nNo MCP servers configured.');
      console.log('Add servers to config.yaml under mcp.servers:\n');
      console.log('  mcp:');
      console.log('    servers:');
      console.log('      my-server:');
      console.log('        transport: stdio');
      console.log('        command: npx');
      console.log('        args: ["-y", "@my/mcp-server"]');
      console.log();
      return;
    }

    const validationErrors = validateMcpConfig(config);
    const errorMap = new Map(validationErrors.map((e) => [e.server, e.error]));

    console.log(`\n${entries.length} MCP server(s) configured:\n`);
    for (const [name, serverConfig] of entries) {
      const enabled = serverConfig.enabled !== false;
      const status = !enabled ? 'disabled' : errorMap.has(name) ? 'invalid' : 'configured';
      const icon = status === 'configured' ? '+' : status === 'disabled' ? '-' : '!';

      console.log(`  [${icon}] ${name} (${serverConfig.transport})`);

      if (serverConfig.transport === 'stdio' && serverConfig.command) {
        const args = serverConfig.args?.join(' ') ?? '';
        console.log(`      Command: ${serverConfig.command} ${args}`.trimEnd());
      } else if (serverConfig.url) {
        console.log(`      URL: ${serverConfig.url}`);
      }

      if (errorMap.has(name)) {
        console.log(`      Error: ${errorMap.get(name)}`);
      }
    }
    console.log();
  });

mcpCmd
  .command('test')
  .description('Test MCP server connections and list available tools')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-s, --server <name>', 'Test only a specific server')
  .action(async (opts: { dir: string; server?: string }) => {
    const { loadConfig } = await import('../core/config.js');
    const { createMcpManager } = await import('../runtime/mcp.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    requireHarness(dir);

    const config = loadConfig(dir);
    const servers = config.mcp?.servers ?? {};

    if (Object.keys(servers).length === 0) {
      console.log('\nNo MCP servers configured. Run `harness mcp list` for setup instructions.\n');
      return;
    }

    // If testing a specific server, filter config
    let testConfig = config;
    if (opts.server) {
      if (!servers[opts.server]) {
        console.error(`Error: MCP server "${opts.server}" not found in config.`);
        console.error(`Available: ${Object.keys(servers).join(', ')}`);
        process.exit(1);
      }
      testConfig = {
        ...config,
        mcp: { servers: { [opts.server]: servers[opts.server] } },
      };
    }

    console.log(`\nTesting MCP server connections...\n`);

    const manager = createMcpManager(testConfig);
    try {
      await manager.connect();
      const summaries = manager.getSummaries();

      for (const summary of summaries) {
        if (!summary.enabled) {
          console.log(`  [-] ${summary.name}: disabled`);
          continue;
        }

        if (summary.connected) {
          console.log(`  [OK] ${summary.name}: connected, ${summary.toolCount} tool(s)`);
          if (summary.toolNames.length > 0) {
            for (const toolName of summary.toolNames) {
              console.log(`        - ${toolName}`);
            }
          }
        } else {
          console.log(`  [FAIL] ${summary.name}: ${summary.error ?? 'unknown error'}`);
        }
      }

      const totalTools = summaries.reduce((sum, s) => sum + s.toolCount, 0);
      const connectedCount = summaries.filter((s) => s.connected).length;
      console.log(`\n  ${connectedCount}/${summaries.length} server(s) connected, ${totalTools} total tool(s)\n`);
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    } finally {
      await manager.close();
    }
  });

mcpCmd
  .command('discover')
  .description('Scan for MCP servers from other tools (Claude Desktop, Cursor, VS Code, etc.)')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { json: boolean }) => {
    const { discoverMcpServers, discoveredServersToYaml, getScannedTools } = await import('../runtime/mcp-discovery.js');
    const discovery = discoverMcpServers();

    if (opts.json) {
      console.log(JSON.stringify(discovery, null, 2));
      return;
    }

    const tools = getScannedTools();
    console.log(`\nScanned ${tools.length} tools: ${tools.join(', ')}\n`);

    if (discovery.sourcesFound === 0) {
      console.log('No tool configs found on this machine.\n');
      return;
    }

    console.log(`Found config files from ${discovery.sourcesFound} tool(s):\n`);
    for (const source of discovery.sources) {
      if (!source.found) continue;
      const status = source.error
        ? `error: ${source.error}`
        : `${source.servers.length} server(s)`;
      console.log(`  ${source.tool}: ${status}`);
      for (const server of source.servers) {
        console.log(`    - ${server.name} (${server.transport}${server.command ? `: ${server.command}` : ''}${server.url ? `: ${server.url}` : ''})`);
      }
    }

    if (discovery.totalServers > 0) {
      console.log(`\n${discovery.totalServers} unique server(s) after dedup:\n`);
      console.log(discoveredServersToYaml(discovery.servers));
      console.log('\nAdd the above to your config.yaml to use these servers.\n');
    } else {
      console.log('\nNo MCP servers found in any tool configs.\n');
    }
  });

mcpCmd
  .command('search <query>')
  .description('Search the MCP registry for available servers')
  .option('-n, --limit <number>', 'Max results', '10')
  .option('--json', 'Output raw JSON', false)
  .action(async (query: string, opts: { limit: string; json: boolean }) => {
    const { searchRegistry, formatRegistryServer } = await import('../runtime/mcp-installer.js');

    try {
      const result = await searchRegistry(query, { limit: parseInt(opts.limit, 10) });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.servers.length === 0) {
        console.log(`\nNo servers found for "${query}".\n`);
        return;
      }

      console.log(`\n${result.servers.length} server(s) found for "${query}":\n`);
      for (const entry of result.servers) {
        console.log(formatRegistryServer(entry));
        console.log();
      }
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

mcpCmd
  .command('install <query>')
  .description('Install an MCP server from the registry into config.yaml')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('-n, --name <name>', 'Custom name for the server in config')
  .option('--force', 'Overwrite if server already exists', false)
  .option('--skip-test', 'Skip connection testing', false)
  .option('--skip-docs', 'Skip tool doc generation', false)
  .option('--json', 'Output raw JSON', false)
  .action(async (query: string, opts: { dir: string; name?: string; force: boolean; skipTest: boolean; skipDocs: boolean; json: boolean }) => {
    const { installMcpServer } = await import('../runtime/mcp-installer.js');
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    requireHarness(dir);

    try {
      console.log(`\nSearching for "${query}" in MCP registry...`);
      const result = await installMcpServer(query, {
        dir,
        name: opts.name,
        force: opts.force,
        skipTest: opts.skipTest,
        skipDocs: opts.skipDocs,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.installed) {
        console.error(`\nFailed: ${result.error}`);
        process.exit(1);
      }

      console.log(`\nInstalled MCP server: ${result.name}`);
      if (result.server?.registryName) {
        console.log(`  registry: ${result.server.registryName}`);
      }
      if (result.server?.description) {
        const desc = result.server.description.length > 80
          ? result.server.description.slice(0, 77) + '...'
          : result.server.description;
        console.log(`  description: ${desc}`);
      }
      console.log(`  transport: ${result.server?.config.transport ?? 'unknown'}`);
      console.log(`  -> Added to config.yaml`);

      // Show required env vars
      if (result.pendingEnvVars.length > 0) {
        console.log(`\n  Required environment variables:`);
        for (const ev of result.pendingEnvVars) {
          const desc = ev.description ? ` — ${ev.description}` : '';
          console.log(`    ${ev.name}${desc}`);
        }
        console.log(`  -> Set these in .env or config.yaml env section`);
      }

      // Show connection test results
      if (result.connectionTest) {
        if (result.connectionTest.connected) {
          console.log(`\n  [OK] Connected: ${result.connectionTest.toolCount} tool(s)`);
          for (const toolName of result.connectionTest.toolNames) {
            console.log(`    - ${toolName}`);
          }
        } else {
          console.log(`\n  [WARN] Connection test failed: ${result.connectionTest.error}`);
          if (result.pendingEnvVars.length > 0) {
            console.log(`  (This is expected if required env vars are not yet set)`);
          }
        }
      }

      // Show generated docs
      if (result.generatedDocs.length > 0) {
        console.log(`\n  Generated tool docs:`);
        for (const doc of result.generatedDocs) {
          console.log(`    ${doc}`);
        }
      }

      console.log();
    } catch (err: unknown) {
      console.error(`Error: ${formatError(err)}`);
      process.exit(1);
    }
  });

// --- DISCOVER (environment and project context) ---
const discoverCmd = program
  .command('discover')
  .description('Discover environment variables, project context, and MCP servers');

discoverCmd
  .command('env')
  .description('Scan .env files for API keys and suggest MCP servers')
  .option('-d, --dir <path>', 'Directory to scan', '.')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { dir: string; json: boolean }) => {
    const { discoverEnvKeys } = await import('../runtime/env-discovery.js');
    const dir = resolve(opts.dir);
    const result = discoverEnvKeys({ dir });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nScanned ${result.filesScanned.length} file(s)\n`);

    if (result.keys.length === 0) {
      console.log('No API keys detected in .env files.\n');
      return;
    }

    console.log(`${result.keys.length} API key(s) detected:\n`);
    for (const key of result.keys) {
      const status = key.hasValue ? '[set]' : '[empty]';
      const sug = key.suggestion ? ` → ${key.suggestion}` : '';
      console.log(`  ${status} ${key.name} (${key.source})${sug}`);
    }

    if (result.suggestions.length > 0) {
      console.log(`\nSuggested MCP servers:\n`);
      for (const sug of result.suggestions) {
        console.log(`  ${sug.message}`);
        console.log(`    Install: harness mcp install "${sug.serverQuery}"`);
      }
    }
    console.log();
  });

discoverCmd
  .command('project')
  .description('Scan project files to detect tech stack and suggest rules/skills')
  .option('-d, --dir <path>', 'Project directory to scan', '.')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { dir: string; json: boolean }) => {
    const { discoverProjectContext } = await import('../runtime/project-discovery.js');
    const dir = resolve(opts.dir);
    const result = discoverProjectContext({ dir });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.signals.length === 0) {
      console.log('\nNo project signals detected.\n');
      return;
    }

    console.log(`\nDetected ${result.signals.length} signal(s):\n`);
    const byCategory = new Map<string, ProjectSignalDisplay[]>();
    for (const signal of result.signals) {
      const list = byCategory.get(signal.category) ?? [];
      list.push(signal);
      byCategory.set(signal.category, list);
    }
    for (const [category, signals] of byCategory) {
      console.log(`  ${category}: ${signals.map((s) => s.name).join(', ')}`);
    }

    if (result.suggestions.length > 0) {
      console.log(`\nSuggestions:\n`);
      for (const sug of result.suggestions) {
        if (sug.type === 'mcp-server') {
          console.log(`  [mcp] ${sug.message}`);
          console.log(`    Install: harness mcp install "${sug.target}"`);
        } else {
          console.log(`  [${sug.type}] ${sug.message}`);
          console.log(`    Create: ${sug.target}`);
        }
      }
    }
    console.log();
  });

// Type alias for CLI display (avoids importing the full type)
type ProjectSignalDisplay = { name: string; category: string };

// --- GENERATE (auto-generate files) ---
const generateCmd = program
  .command('generate')
  .description('Auto-generate harness files');

generateCmd
  .command('system')
  .description('Regenerate SYSTEM.md from actual directory structure')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .action(async (opts: { dir: string }) => {
    const { generateSystemMd } = await import('./scaffold.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    const { loadConfig } = await import('../core/config.js');
    const config = loadConfig(dir);
    const content = generateSystemMd(dir, config.agent.name);

    const { writeFileSync } = await import('fs');
    writeFileSync(join(dir, 'SYSTEM.md'), content, 'utf-8');
    console.log(`\n✓ SYSTEM.md regenerated from directory structure\n`);
  });

// --- DASHBOARD (unified telemetry view) ---
program
  .command('dashboard')
  .description('Show a unified dashboard of health, costs, sessions, workflows, and storage')
  .option('-d, --dir <path>', 'Harness directory', '.')
  .option('--json', 'Output raw JSON snapshot', false)
  .option('--watch', 'Refresh every N seconds', false)
  .option('--interval <seconds>', 'Watch refresh interval in seconds', '5')
  .action(async (opts: { dir: string; json: boolean; watch: boolean; interval: string }) => {
    const { collectSnapshot, formatDashboard } = await import('../runtime/telemetry.js');
    const dir = resolve(opts.dir);
    requireHarness(dir);

    if (opts.json) {
      const snapshot = collectSnapshot(dir);
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    const showDashboard = () => {
      const snapshot = collectSnapshot(dir);
      const output = formatDashboard(snapshot);
      if (opts.watch) {
        // Clear screen for watch mode
        process.stdout.write('\x1B[2J\x1B[H');
        console.log(`\n  Agent Harness Dashboard (refreshing every ${opts.interval}s — Ctrl+C to stop)\n`);
        console.log(`  ${snapshot.timestamp}\n`);
      } else {
        console.log(`\n  Agent Harness Dashboard\n`);
      }
      console.log(output);
    };

    showDashboard();

    if (opts.watch) {
      const intervalMs = (parseInt(opts.interval, 10) || 5) * 1000;
      const timer = setInterval(showDashboard, intervalMs);

      const cleanup = () => {
        clearInterval(timer);
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    }
  });

// --- Intelligence Commands ---

const intelligenceCmd = program.command('intelligence').description('Intelligence and learning analysis tools');

intelligenceCmd
  .command('promote')
  .description('Auto-promote instinct candidates that appear 3+ times across journals')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--threshold <n>', 'Minimum occurrences to promote', '3')
  .option('--install', 'Install promoted instincts as .md files')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { autoPromoteInstincts } = await import('../runtime/intelligence.js');
    const result = autoPromoteInstincts(dir, {
      threshold: parseInt(opts.threshold, 10),
      install: opts.install ?? false,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned ${result.journalsScanned} journals`);
      if (result.patterns.length === 0) {
        console.log('No patterns meeting threshold found.');
      } else {
        console.log(`\nPatterns (${result.patterns.length}):`);
        for (const p of result.patterns) {
          console.log(`  [${p.count}x] ${p.behavior}`);
          console.log(`        Dates: ${p.journalDates.join(', ')}`);
        }
      }
      if (result.promoted.length > 0) {
        console.log(`\nPromoted: ${result.promoted.join(', ')}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped (already exists): ${result.skipped.join(', ')}`);
      }
    }
  });

intelligenceCmd
  .command('dead')
  .description('Detect dead primitives (unreferenced and old)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--threshold <days>', 'Days since modification to consider dead', '30')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { detectDeadPrimitives } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = detectDeadPrimitives(dir, config, {
      thresholdDays: parseInt(opts.threshold, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned ${result.totalScanned} primitives (threshold: ${result.thresholdDays} days)`);
      if (result.dead.length === 0) {
        console.log('No dead primitives found.');
      } else {
        console.log(`\nDead primitives (${result.dead.length}):`);
        for (const d of result.dead) {
          console.log(`  ${d.id} (${d.directory}) — ${d.daysSinceModified}d since modified`);
          console.log(`    ${d.reason}`);
        }
      }
    }
  });

intelligenceCmd
  .command('contradictions')
  .description('Detect contradictions between rules and instincts')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { detectContradictions } = await import('../runtime/intelligence.js');
    const result = detectContradictions(dir);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Checked ${result.rulesChecked} rules, ${result.instinctsChecked} instincts`);
      if (result.contradictions.length === 0) {
        console.log('No contradictions detected.');
      } else {
        console.log(`\nContradictions (${result.contradictions.length}):`);
        for (const c of result.contradictions) {
          console.log(`  [${c.severity}] ${c.primitiveA.id} (${c.primitiveA.type}) vs ${c.primitiveB.id} (${c.primitiveB.type})`);
          console.log(`    ${c.reason}`);
        }
      }
    }
  });

intelligenceCmd
  .command('enrich')
  .description('Enrich sessions with topics, token counts, and related primitives')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { enrichSessions } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = enrichSessions(dir, config, {
      from: opts.from,
      to: opts.to,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned ${result.sessionsScanned} sessions, enriched ${result.enriched.length}`);
      for (const s of result.enriched) {
        console.log(`  ${s.sessionId}: ${s.topics.join(', ') || '(no topics)'} — ${s.tokenCount} tokens, ${s.toolsUsed.length} tools`);
        if (s.primitivesReferenced.length > 0) {
          console.log(`    Referenced: ${s.primitivesReferenced.join(', ')}`);
        }
      }
    }
  });

intelligenceCmd
  .command('suggest')
  .description('Suggest new skills/playbooks for frequent uncovered topics')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--min-frequency <n>', 'Minimum topic frequency', '3')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { suggestCapabilities } = await import('../runtime/intelligence.js');
    const { loadConfig } = await import('../core/config.js');

    let config;
    try { config = loadConfig(dir); } catch (err) { if (process.env.DEBUG) console.error(`Config load skipped: ${err instanceof Error ? err.message : String(err)}`); }

    const result = suggestCapabilities(dir, config, {
      minFrequency: parseInt(opts.minFrequency, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Analyzed ${result.topicsAnalyzed} topics from ${result.sessionsScanned} sessions`);
      if (result.suggestions.length === 0) {
        console.log('No capability suggestions at this time.');
      } else {
        console.log(`\nSuggestions (${result.suggestions.length}):`);
        for (const s of result.suggestions) {
          console.log(`  [${s.suggestedType}] "${s.topic}" — ${s.frequency} occurrences`);
          console.log(`    ${s.suggestion}`);
        }
      }
    }
  });

intelligenceCmd
  .command('failures')
  .description('Analyze recent failure patterns and suggest recovery strategies')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--days <n>', 'Days to look back', '7')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { analyzeFailures } = await import('../runtime/intelligence.js');
    const result = analyzeFailures(dir, { days: parseInt(opts.days, 10) });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Health: ${result.healthImplication}`);
      console.log(`Recent failures: ${result.recentFailures.length}`);
      if (result.mostCommonMode) {
        console.log(`Most common failure: ${result.mostCommonMode}`);
      }
      if (Object.keys(result.modeFrequency).length > 0) {
        console.log('\nFailure frequency:');
        for (const [mode, count] of Object.entries(result.modeFrequency)) {
          console.log(`  ${mode}: ${count}`);
        }
      }
      if (result.suggestedRecovery.length > 0) {
        console.log('\nSuggested recovery:');
        for (const s of result.suggestedRecovery) {
          console.log(`  - ${s}`);
        }
      }
    }
  });

intelligenceCmd
  .command('classify <error>')
  .description('Classify an error message into a failure mode')
  .action(async (errorMsg) => {
    const { classifyFailure, getRecoveryStrategies, FAILURE_TAXONOMY } = await import('../runtime/intelligence.js');
    const mode = classifyFailure(errorMsg);
    const info = FAILURE_TAXONOMY.modes[mode];
    const strategies = getRecoveryStrategies(mode);

    console.log(`Mode: ${mode}`);
    console.log(`Severity: ${info.severity}`);
    console.log(`Description: ${info.description}`);
    console.log(`Auto-recoverable: ${info.autoRecoverable}`);
    console.log('\nRecovery strategies:');
    for (const s of strategies) {
      console.log(`  - ${s}`);
    }
  });

// --- Verification Gate Commands ---

const gateCmd = program.command('gate').description('Run verification gates');

gateCmd
  .command('run [name]')
  .description('Run a verification gate (or all gates if no name)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (name, opts) => {
    const dir = resolve(opts.dir);
    loadEnvFromDir(dir);
    const { runGate, runAllGates } = await import('../runtime/intelligence.js');

    if (name) {
      const result = runGate(name, dir);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Gate: ${result.gateName} — ${result.passed ? 'PASSED' : 'FAILED'}`);
        console.log(result.summary);
        for (const c of result.checks) {
          const icon = c.status === 'pass' ? '[OK]' : c.status === 'fail' ? '[FAIL]' : c.status === 'warn' ? '[WARN]' : '[SKIP]';
          console.log(`  ${icon} ${c.name}: ${c.message}`);
        }
      }
    } else {
      const results = runAllGates(dir);
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const result of results) {
          const icon = result.passed ? '[OK]' : '[FAIL]';
          console.log(`${icon} ${result.summary}`);
          for (const c of result.checks) {
            const cIcon = c.status === 'pass' ? '[OK]' : c.status === 'fail' ? '[FAIL]' : c.status === 'warn' ? '[WARN]' : '[SKIP]';
            console.log(`    ${cIcon} ${c.name}: ${c.message}`);
          }
        }
      }
    }
  });

gateCmd
  .command('list')
  .description('List available verification gates')
  .action(async () => {
    const { listGates } = await import('../runtime/intelligence.js');
    const gates = listGates();
    for (const g of gates) {
      console.log(`  ${g.name}: ${g.description}`);
    }
  });

// ── Rule Engine ──────────────────────────────────────────────────────────────

program
  .command('check-rules')
  .description('Check an action against loaded rules')
  .argument('<action>', 'Action to check (e.g., "deploy", "run", "tool_call")')
  .option('-d, --dir <path>', 'Harness directory', process.cwd())
  .option('--description <text>', 'Description of the action')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--tool <name>', 'Tool name (for tool_call actions)')
  .option('--json', 'Output as JSON')
  .action(async (action: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { enforceRules } = await import('../runtime/rule-engine.js');

    const tags = opts.tags ? (opts.tags as string).split(',').map((t: string) => t.trim()) : undefined;
    const result = enforceRules(dir, {
      action,
      description: opts.description as string | undefined,
      tags,
      toolName: opts.tool as string | undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.allowed ? '[OK] ' + result.summary : '[BLOCKED] ' + result.summary);
      for (const v of result.violations) {
        console.log(`  [${v.severity.toUpperCase()}] ${v.directive} (rule: ${v.ruleId})`);
      }
      for (const w of result.warnings) {
        console.log(`  [WARN] ${w.directive} (rule: ${w.ruleId})`);
      }
    }
  });

program
  .command('list-rules')
  .description('List all parsed rules from the harness')
  .option('-d, --dir <path>', 'Harness directory', process.cwd())
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { loadRules } = await import('../runtime/rule-engine.js');

    const rules = loadRules(dir);
    if (opts.json) {
      console.log(JSON.stringify(rules, null, 2));
    } else {
      if (rules.length === 0) {
        console.log('No enforceable rules found.');
      } else {
        console.log(`${rules.length} rule(s) loaded:\n`);
        for (const rule of rules) {
          const icon = rule.action === 'deny' ? '[DENY]' : rule.action === 'warn' ? '[WARN]' : rule.action === 'require_approval' ? '[APPROVAL]' : '[ALLOW]';
          console.log(`  ${icon} ${rule.directive} (from: ${rule.ruleId})`);
        }
      }
    }
  });

// ── Playbook Gates ───────────────────────────────────────────────────────────

program
  .command('playbook-gates')
  .description('Extract and check verification gates from playbooks/workflows')
  .argument('[playbook-id]', 'Specific playbook/workflow ID')
  .option('-d, --dir <path>', 'Harness directory', process.cwd())
  .option('--json', 'Output as JSON')
  .action(async (playbookId: string | undefined, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { loadGates, getGatesForPlaybook } = await import('../runtime/verification-gate.js');

    if (playbookId) {
      const gates = getGatesForPlaybook(dir, playbookId);
      if (opts.json) {
        console.log(JSON.stringify(gates, null, 2));
      } else if (gates.length === 0) {
        console.log(`No verification gates found for "${playbookId}".`);
      } else {
        console.log(`${gates.length} gate(s) for "${playbookId}":\n`);
        for (const gate of gates) {
          console.log(`  Gate: ${gate.stage} (${gate.id})`);
          for (const c of gate.criteria) {
            const icon = c.manual ? '[MANUAL]' : '[AUTO]';
            console.log(`    ${icon} ${c.description}`);
          }
        }
      }
    } else {
      const { gates, sources } = loadGates(dir);
      if (opts.json) {
        console.log(JSON.stringify({ gates, sources }, null, 2));
      } else if (gates.length === 0) {
        console.log('No verification gates found in playbooks or workflows.');
      } else {
        console.log(`${gates.length} gate(s) from ${sources.length} source(s):\n`);
        for (const gate of gates) {
          console.log(`  [${gate.sourceId}] ${gate.stage} — ${gate.criteria.length} criterion(s)`);
        }
      }
    }
  });

// ── State Merge ──────────────────────────────────────────────────────────────

const stateCmd = program.command('state-merge').description('Mixed-ownership state merging');

stateCmd
  .command('apply')
  .description('Apply a state change with ownership tracking')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--author <owner>', 'Change author: human, agent, infrastructure', 'human')
  .option('--mode <mode>', 'Set agent mode')
  .option('--goals <goals>', 'Set goals (comma-separated)')
  .option('--strategy <strategy>', 'Merge strategy: human-wins, agent-wins, latest-wins, union', 'human-wins')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { mergeState } = await import('../runtime/state-merge.js');
    const changes: Record<string, unknown> = {};
    if (opts.mode) changes.mode = opts.mode;
    if (opts.goals) changes.goals = (opts.goals as string).split(',').map((g: string) => g.trim());

    if (Object.keys(changes).length === 0) {
      console.log('No changes specified. Use --mode or --goals.');
      return;
    }

    const result = mergeState(dir, {
      author: opts.author as 'human' | 'agent' | 'infrastructure',
      changes,
    }, opts.strategy as 'human-wins' | 'agent-wins' | 'latest-wins' | 'union');

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`State merged (strategy: ${opts.strategy}).`);
      if (result.hadConflicts) {
        console.log(`  ${result.conflicts.length} conflict(s) resolved:`);
        for (const c of result.conflicts) {
          console.log(`    ${c.field}: resolved to ${c.resolvedTo}`);
        }
      } else {
        console.log('  No conflicts.');
      }
      console.log(`  Mode: ${result.state.mode}`);
      console.log(`  Goals: ${result.state.goals.join(', ') || '(none)'}`);
    }
  });

stateCmd
  .command('ownership')
  .description('Show current state ownership')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { loadOwnership } = await import('../runtime/state-merge.js');
    const ownership = loadOwnership(dir);

    if (opts.json) {
      console.log(JSON.stringify(ownership, null, 2));
    } else {
      console.log('State field ownership:');
      for (const [field, owner] of Object.entries(ownership)) {
        console.log(`  ${field}: ${owner}`);
      }
    }
  });

// ── Emotional State ──────────────────────────────────────────────────────────

const emoCmd = program.command('emotional').description('Operational disposition tracking');

emoCmd
  .command('status')
  .description('Show current emotional/disposition state')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { loadEmotionalState, summarizeEmotionalState } = await import('../runtime/emotional-state.js');
    const state = loadEmotionalState(dir);

    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log('Operational Disposition:');
      console.log(`  Confidence:  ${state.confidence}/100`);
      console.log(`  Engagement:  ${state.engagement}/100`);
      console.log(`  Frustration: ${state.frustration}/100`);
      console.log(`  Curiosity:   ${state.curiosity}/100`);
      console.log(`  Urgency:     ${state.urgency}/100`);
      console.log(`  Updated:     ${state.updatedAt}`);
      console.log(`\n${summarizeEmotionalState(state)}`);
    }
  });

emoCmd
  .command('signal')
  .description('Apply an emotional signal')
  .argument('<dimension>', 'Dimension: confidence, engagement, frustration, curiosity, urgency')
  .argument('<delta>', 'Delta value (positive or negative integer)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-r, --reason <reason>', 'Reason for the signal')
  .option('--json', 'Output as JSON')
  .action(async (dimension: string, delta: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { applySignals } = await import('../runtime/emotional-state.js');
    const state = applySignals(dir, [{
      dimension: dimension as 'confidence' | 'engagement' | 'frustration' | 'curiosity' | 'urgency',
      delta: parseInt(delta, 10),
      reason: opts.reason as string | undefined,
    }]);

    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log(`Applied signal: ${dimension} ${parseInt(delta, 10) >= 0 ? '+' : ''}${delta}`);
      console.log(`  New ${dimension}: ${state[dimension as keyof typeof state]}/100`);
    }
  });

emoCmd
  .command('trends')
  .description('Show emotional dimension trends')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--days <days>', 'Days to analyze', '7')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { getEmotionalTrends } = await import('../runtime/emotional-state.js');
    const trends = getEmotionalTrends(dir, { days: parseInt(opts.days as string, 10) });

    if (opts.json) {
      console.log(JSON.stringify(trends, null, 2));
    } else {
      console.log(`Emotional trends (last ${opts.days} days):\n`);
      for (const t of trends) {
        const arrow = t.trend === 'rising' ? '↑' : t.trend === 'falling' ? '↓' : '→';
        console.log(`  ${t.dimension}: avg ${t.average.toFixed(0)}/100 ${arrow} (${t.values.length} data points)`);
      }
    }
  });

emoCmd
  .command('reset')
  .description('Reset emotional state to defaults')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { resetEmotionalState } = await import('../runtime/emotional-state.js');
    resetEmotionalState(dir);
    console.log('Emotional state reset to defaults.');
  });

// ── Check Action ─────────────────────────────────────────────────────────────

program
  .command('check-action')
  .description('Check if an action is allowed by harness rules (agent-framework guardrails)')
  .argument('<action>', 'Action description to check')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--tags <tags>', 'Filter by rule tags (comma-separated)')
  .option('--json', 'Output as JSON')
  .action(async (action: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { checkAction } = await import('../runtime/agent-framework.js');
    const tags = opts.tags ? (opts.tags as string).split(',').map((t: string) => t.trim()) : undefined;
    const result = checkAction(dir, action, { ruleTags: tags });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.allowed) {
      console.log('[OK] Action allowed.');
    } else {
      console.log(`[BLOCKED] ${result.reason}`);
    }
  });

// ── Serve ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the harness HTTP API server for webhooks and integrations')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('--api-key <key>', 'API key for LLM provider')
  .option('--webhook-secret <secret>', 'Secret for authenticating webhook management API')
  .option('--no-cors', 'Disable CORS')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { startServe } = await import('../runtime/serve.js');

    const port = parseInt(opts.port as string, 10);
    const result = startServe({
      harnessDir: dir,
      port,
      apiKey: opts.apiKey as string | undefined,
      webhookSecret: opts.webhookSecret as string | undefined,
      corsEnabled: opts.cors !== false,
    });

    console.log(`Harness API server listening on http://localhost:${result.port}`);
    console.log('Endpoints:');
    console.log('  GET  /api/health       — health check');
    console.log('  GET  /api/info         — agent info');
    console.log('  POST /api/run          — execute a prompt');
    console.log('  GET  /api/webhooks     — list registered webhooks');
    console.log('  POST /api/webhooks     — register a webhook');
    console.log('  DEL  /api/webhooks/:id — delete a webhook');
    console.log('  PATCH /api/webhooks/:id — toggle webhook active/inactive');
    console.log('  POST /api/webhooks/:id/test — test a webhook');
    console.log('  + all dashboard endpoints from harness dev');
    console.log('\nPress Ctrl+C to stop.');

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      result.stop();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      result.stop();
      process.exit(0);
    });

    // Wait indefinitely
    await new Promise<void>(() => { /* keep alive */ });
  });

// ── Sources ──────────────────────────────────────────────────────────────────

const sourcesCmd = program.command('sources').description('Manage content sources (skills, agents, rules, MCP servers)');

sourcesCmd
  .command('list')
  .description('List all configured content sources')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--type <type>', 'Filter by content type (skills, agents, rules, hooks, mcp, etc.)')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { loadAllSources, getSourcesForType } = await import('../runtime/sources.js');

    const sources = opts.type
      ? getSourcesForType(dir, opts.type as 'skills' | 'agents' | 'rules' | 'hooks' | 'mcp')
      : loadAllSources(dir);

    if (opts.json) {
      console.log(JSON.stringify(sources, null, 2));
    } else if (sources.length === 0) {
      console.log('No sources configured.');
    } else {
      console.log(`${sources.length} source(s):\n`);
      for (const s of sources) {
        const types = s.content.join(', ');
        const stats = s.stats ? ` (${Object.entries(s.stats).map(([k, v]) => `${v} ${k}`).join(', ')})` : '';
        console.log(`  [${s.type}] ${s.name}${stats}`);
        console.log(`    ${s.url}`);
        console.log(`    Content: ${types}`);
        if (s.description) console.log(`    ${s.description}`);
        console.log();
      }
    }
  });

sourcesCmd
  .command('add')
  .description('Add a new content source')
  .argument('<url>', 'Source URL (GitHub repo, registry API, or endpoint)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-n, --name <name>', 'Source display name')
  .option('-t, --type <type>', 'Source type: github, registry, api', 'github')
  .option('-c, --content <types>', 'Content types (comma-separated: skills,agents,rules,hooks,mcp)')
  .option('--description <desc>', 'Source description')
  .option('--json', 'Output as JSON')
  .action(async (url: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { addSource } = await import('../runtime/sources.js');

    // Derive name from URL if not provided
    const name = (opts.name as string) ?? url.replace(/https?:\/\//, '').replace(/github\.com\//, '').replace(/\/$/, '');
    const content = opts.content
      ? (opts.content as string).split(',').map((c: string) => c.trim())
      : ['skills'];

    const result = addSource(dir, {
      name,
      url,
      type: (opts.type as 'github' | 'registry' | 'api'),
      content: content as Array<'skills' | 'agents' | 'rules' | 'hooks' | 'mcp'>,
      description: opts.description as string | undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result) {
      console.log(`Added source: ${result.name} (${result.url})`);
    } else {
      console.log('Source with that name already exists.');
    }
  });

sourcesCmd
  .command('remove')
  .description('Remove a content source')
  .argument('<name>', 'Source name to remove')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .action(async (name: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { removeSource } = await import('../runtime/sources.js');

    const removed = removeSource(dir, name);
    if (removed) {
      console.log(`Removed source: ${name}`);
    } else {
      console.log(`Source not found: ${name}`);
    }
  });

sourcesCmd
  .command('summary')
  .description('Show content available by type across all sources')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { getSourcesSummary } = await import('../runtime/sources.js');

    const summary = getSourcesSummary(dir);

    if (opts.json) {
      const json: Record<string, number> = {};
      for (const [type, sources] of Object.entries(summary)) {
        json[type] = sources.length;
      }
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log('Content sources by type:\n');
      for (const [type, sources] of Object.entries(summary)) {
        if (sources.length > 0) {
          console.log(`  ${type}: ${sources.length} source(s)`);
          for (const s of sources) {
            console.log(`    - ${s.name}`);
          }
        }
      }
    }
  });

// ── Discover Search (sub-command of existing discoverCmd) ────────────────────

discoverCmd
  .command('search')
  .description('Search all content sources for skills, agents, rules, hooks, MCP servers')
  .argument('<query>', 'Search query')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-t, --type <type>', 'Filter by content type (skills, agents, rules, hooks, mcp, etc.)')
  .option('-n, --max <n>', 'Maximum results', '20')
  .option('--remote', 'Also search remote sources (GitHub API, registries)')
  .option('--json', 'Output as JSON')
  .action(async (query: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);

    const maxResults = parseInt(opts.max as string, 10);
    const type = opts.type as string | undefined;

    if (opts.remote) {
      const { discoverRemote } = await import('../runtime/sources.js');
      const results = await discoverRemote(dir, query, {
        type: type as 'skills' | 'agents' | undefined,
        maxResults,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        console.log('No results found.');
      } else {
        console.log(`${results.length} result(s):\n`);
        for (const r of results) {
          console.log(`  [${r.type}] ${r.name} (score: ${r.score.toFixed(2)})`);
          console.log(`    Source: ${r.source.name}`);
          console.log(`    ${r.url}`);
          if (r.description) console.log(`    ${r.description}`);
          console.log();
        }
      }
    } else {
      const { discoverSources } = await import('../runtime/sources.js');
      const results = discoverSources(dir, query, {
        type: type as 'skills' | 'agents' | undefined,
        maxResults,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        console.log('No results found. Try --remote to search GitHub and registries.');
      } else {
        console.log(`${results.length} result(s):\n`);
        for (const r of results) {
          console.log(`  [${r.type}] ${r.name} (score: ${r.score.toFixed(2)})`);
          console.log(`    Source: ${r.source.name}`);
          console.log(`    ${r.url}`);
          if (r.description) console.log(`    ${r.description}`);
          console.log();
        }
      }
    }
  });

// ── Semantic Search ──────────────────────────────────────────────────────────

const semanticCmd = program.command('semantic').description('Semantic search over indexed primitives');

semanticCmd
  .command('index')
  .description('Index all primitives for semantic search (requires an embed function at runtime — shows stats only from CLI)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { getEmbeddingStats } = await import('../runtime/semantic-search.js');
    const stats = getEmbeddingStats(dir);

    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log('Embedding index stats:');
      console.log(`  Indexed:        ${stats.indexed} primitives`);
      console.log(`  Model:          ${stats.modelId ?? '(none)'}`);
      console.log(`  Dimensions:     ${stats.dimensions}`);
      console.log(`  Last indexed:   ${stats.lastIndexedAt ?? '(never)'}`);
      console.log(`  Store size:     ${(stats.storeSize / 1024).toFixed(1)} KB`);
    }
  });

semanticCmd
  .command('stats')
  .description('Show embedding store statistics')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);
    const { getEmbeddingStats, detectStalePrimitives, loadEmbeddingStore } = await import('../runtime/semantic-search.js');
    const stats = getEmbeddingStats(dir);
    const store = loadEmbeddingStore(dir);
    const stale = detectStalePrimitives(dir, store, stats.modelId ?? '');

    if (opts.json) {
      console.log(JSON.stringify({ ...stats, stale: stale.length }, null, 2));
    } else {
      console.log('Semantic search stats:');
      console.log(`  Indexed:        ${stats.indexed} primitives`);
      console.log(`  Stale:          ${stale.length} primitive(s) need re-indexing`);
      console.log(`  Model:          ${stats.modelId ?? '(none)'}`);
      console.log(`  Dimensions:     ${stats.dimensions}`);
      console.log(`  Last indexed:   ${stats.lastIndexedAt ?? '(never)'}`);
      console.log(`  Store size:     ${(stats.storeSize / 1024).toFixed(1)} KB`);
    }
  });

// ── Universal Installer ──────────────────────────────────────────────────────

program
  .command('install')
  .description('Install a primitive from any source (file, URL, or name)')
  .argument('<source>', 'File path, HTTPS URL, or source name to install')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-t, --type <type>', 'Override detected type (skill, rule, agent, playbook, workflow, tool)')
  .option('--id <id>', 'Override generated ID')
  .option('--force', 'Force install despite validation warnings')
  .option('--skip-fix', 'Skip auto-fix (no frontmatter/L0/L1 generation)')
  .option('--tags <tags...>', 'Additional tags to add')
  .option('--json', 'Output as JSON')
  .action(async (source: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    loadEnvFromDir(dir);

    // Handle pack: prefix — install builtin starter packs
    const { isPackReference, parsePackName, getStarterPack, listStarterPacks } = await import('../runtime/starter-packs.js');
    if (isPackReference(source)) {
      const packName = parsePackName(source);

      // Special case: pack:list shows available packs
      if (packName === 'list') {
        const packs = listStarterPacks();
        console.log('\nAvailable starter packs:\n');
        for (const p of packs) {
          console.log(`  pack:${p.name}`);
          console.log(`    ${p.description}`);
          console.log(`    Files: ${p.fileCount} | Tags: ${p.tags.join(', ')}\n`);
        }
        console.log(`Install with: harness install pack:<name> -d <harness-dir>`);
        return;
      }

      const bundle = getStarterPack(packName);
      if (!bundle) {
        const available = listStarterPacks().map(p => `pack:${p.name}`).join(', ');
        console.error(`Unknown starter pack: "${packName}"\nAvailable packs: ${available}`);
        process.exitCode = 1;
        return;
      }

      const { installBundle } = await import('../runtime/primitive-registry.js');
      const bundleResult = installBundle(dir, bundle, {
        overwrite: opts.force as boolean | undefined,
        force: opts.force as boolean | undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(bundleResult, null, 2));
      } else if (bundleResult.installed) {
        console.log(`\nInstalled pack: ${packName}`);
        console.log(`  Files: ${bundleResult.files.length}`);
        for (const f of bundleResult.files) {
          console.log(`    + ${f}`);
        }
        if (bundleResult.skipped.length > 0) {
          console.log(`  Skipped (already exist): ${bundleResult.skipped.length}`);
          for (const f of bundleResult.skipped) {
            console.log(`    ~ ${f}`);
          }
          console.log(`  Use --force to overwrite existing files.`);
        }
        console.log(`\nCustomize the workflows in your workflows/ directory.`);
      } else {
        console.error(`Failed to install pack: ${packName}`);
        for (const err of bundleResult.errors) {
          console.error(`  ${err}`);
        }
        process.exitCode = 1;
      }
      return;
    }

    const { universalInstall } = await import('../runtime/universal-installer.js');

    const result = await universalInstall(dir, source, {
      type: opts.type as string | undefined,
      id: opts.id as string | undefined,
      force: opts.force as boolean | undefined,
      skipFix: opts.skipFix as boolean | undefined,
      tags: opts.tags as string[] | undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.installed) {
        console.log(`Installed: ${result.destination}`);
        console.log(`  Format:  ${result.format.format} (${(result.format.confidence * 100).toFixed(0)}% confidence)`);
        if (result.format.primitiveType) {
          console.log(`  Type:    ${result.format.primitiveType}`);
        }
        if (result.fixes.length > 0) {
          console.log(`  Fixes:`);
          for (const fix of result.fixes) {
            console.log(`    - ${fix}`);
          }
        }
        if (result.suggestedDependencies.length > 0) {
          console.log(`  Dependencies to consider:`);
          for (const dep of result.suggestedDependencies) {
            console.log(`    - ${dep}`);
          }
        }
      } else {
        console.error(`Failed to install: ${source}`);
        for (const err of result.errors) {
          console.error(`  ${err}`);
        }
        if (result.fixes.length > 0) {
          console.log(`  Attempted fixes:`);
          for (const fix of result.fixes) {
            console.log(`    - ${fix}`);
          }
        }
        process.exitCode = 1;
      }
    }
  });

// ── Versioning ───────────────────────────────────────────────────────────────

const versionCmd = program.command('version').description('Git-backed primitive versioning');

versionCmd
  .command('init')
  .description('Initialize git versioning for the harness')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { initVersioning, isGitRepo } = await import('../runtime/versioning.js');
    if (isGitRepo(dir)) {
      console.log('Versioning already initialized.');
    } else {
      const ok = initVersioning(dir);
      console.log(ok ? 'Versioning initialized.' : 'Failed to initialize versioning.');
    }
  });

versionCmd
  .command('snapshot')
  .description('Take a versioned snapshot of the current harness state')
  .argument('<message>', 'Commit message')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-t, --tag <tag>', 'Tag this version')
  .option('--json', 'Output as JSON')
  .action(async (message: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { snapshot } = await import('../runtime/versioning.js');
    const result = snapshot(dir, message, { tag: opts.tag as string | undefined });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.success && result.files.length > 0) {
      console.log(`Snapshot ${result.hash.slice(0, 7)}: ${result.files.length} file(s) committed.`);
      for (const f of result.files) { console.log(`  ${f}`); }
      if (opts.tag) { console.log(`  Tagged: ${opts.tag}`); }
    } else if (result.error) {
      console.log(result.error);
    }
  });

versionCmd
  .command('log')
  .description('Show version history')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-n, --limit <n>', 'Max entries', '20')
  .option('-f, --file <path>', 'Filter by file path')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { getVersionLog } = await import('../runtime/versioning.js');
    const log = getVersionLog(dir, {
      limit: parseInt(opts.limit as string, 10),
      file: opts.file as string | undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(log, null, 2));
    } else if (log.entries.length === 0) {
      console.log('No version history. Run `harness version init` first.');
    } else {
      console.log(`Version history (${log.entries.length} entries):\n`);
      for (const entry of log.entries) {
        const tag = entry.tag ? ` [${entry.tag}]` : '';
        console.log(`  ${entry.hash} ${entry.message}${tag}`);
        console.log(`    ${entry.timestamp} — ${entry.filesChanged.length} file(s)`);
      }
    }
  });

versionCmd
  .command('diff')
  .description('Show changes between versions')
  .argument('<from>', 'Source commit hash or tag')
  .argument('[to]', 'Target commit hash or tag (default: HEAD)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (from: string, to: string | undefined, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { getVersionDiff } = await import('../runtime/versioning.js');
    const diff = getVersionDiff(dir, from, to);

    if (opts.json) {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      console.log(`${diff.summary}\n`);
      for (const entry of diff.entries) {
        const icon = entry.status === 'added' ? '+' : entry.status === 'deleted' ? '-' : 'M';
        const stats = entry.additions !== undefined ? ` (+${entry.additions}/-${entry.deletions})` : '';
        console.log(`  [${icon}] ${entry.file}${stats}`);
      }
    }
  });

versionCmd
  .command('rollback')
  .description('Roll back to a previous version (creates new commit preserving history)')
  .argument('<target>', 'Commit hash or tag to roll back to')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (target: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { rollback } = await import('../runtime/versioning.js');
    const result = rollback(dir, target);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.success) {
      console.log(`Rolled back to ${result.targetHash.slice(0, 7)}.`);
      console.log(`  ${result.restoredFiles.length} file(s) restored.`);
    } else {
      console.log(`Rollback failed: ${result.error}`);
    }
  });

versionCmd
  .command('tag')
  .description('Tag the current version')
  .argument('<name>', 'Tag name (e.g., v1.0.0)')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('-m, --message <msg>', 'Tag message')
  .action(async (name: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { tagVersion } = await import('../runtime/versioning.js');
    const ok = tagVersion(dir, name, opts.message as string | undefined);
    console.log(ok ? `Tagged: ${name}` : 'Failed to create tag.');
  });

versionCmd
  .command('tags')
  .description('List all version tags')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { listTags } = await import('../runtime/versioning.js');
    const tags = listTags(dir);

    if (opts.json) {
      console.log(JSON.stringify(tags, null, 2));
    } else if (tags.length === 0) {
      console.log('No tags.');
    } else {
      for (const t of tags) {
        console.log(`  ${t.tag} → ${t.hash} (${t.message})`);
      }
    }
  });

versionCmd
  .command('pending')
  .description('Show uncommitted changes')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { getPendingChanges } = await import('../runtime/versioning.js');
    const changes = getPendingChanges(dir);

    if (opts.json) {
      console.log(JSON.stringify(changes, null, 2));
    } else if (changes.length === 0) {
      console.log('No pending changes.');
    } else {
      console.log(`${changes.length} pending change(s):\n`);
      for (const c of changes) {
        const icon = c.status === 'added' ? '+' : c.status === 'deleted' ? '-' : 'M';
        console.log(`  [${icon}] ${c.file}`);
      }
    }
  });

versionCmd
  .command('show')
  .description('Show file content at a specific version')
  .argument('<file>', 'File path relative to harness')
  .argument('<hash>', 'Commit hash or tag')
  .option('-d, --dir <dir>', 'Harness directory', '.')
  .action(async (file: string, hash: string, opts: Record<string, unknown>) => {
    const dir = resolve(opts.dir as string);
    const { getFileAtVersion } = await import('../runtime/versioning.js');
    const content = getFileAtVersion(dir, file, hash);
    if (content === null) {
      console.log(`File not found at version ${hash}.`);
    } else {
      console.log(content);
    }
  });

program.parse();
