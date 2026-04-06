import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';

// --- Types ---

/** A detected API key from environment files */
export interface DetectedApiKey {
  /** Environment variable name */
  name: string;
  /** Which file it was found in */
  source: string;
  /** Whether the value looks like an actual key (not a placeholder) */
  hasValue: boolean;
  /** Suggested MCP server or service this key is for */
  suggestion?: string;
}

/** Result of scanning environment for API keys */
export interface EnvDiscoveryResult {
  /** All detected API keys */
  keys: DetectedApiKey[];
  /** Files that were scanned */
  filesScanned: string[];
  /** Suggested MCP servers based on detected keys */
  suggestions: EnvSuggestion[];
}

/** Suggested MCP server based on detected environment */
export interface EnvSuggestion {
  /** Human-readable suggestion */
  message: string;
  /** MCP server registry name or package */
  serverQuery: string;
  /** Which env var triggered this suggestion */
  triggeredBy: string;
}

// --- Known API key patterns ---

interface KeyPattern {
  /** Regex pattern for the env var name */
  pattern: RegExp;
  /** Description of what this key is for */
  service: string;
  /** MCP server search query to suggest */
  serverQuery?: string;
  /** Suggestion message */
  suggestion?: string;
}

const KEY_PATTERNS: KeyPattern[] = [
  {
    pattern: /^GITHUB_TOKEN$|^GH_TOKEN$|^GITHUB_PAT$/,
    service: 'GitHub',
    serverQuery: 'github',
    suggestion: 'GitHub MCP server for repository management',
  },
  {
    pattern: /^OPENAI_API_KEY$/,
    service: 'OpenAI',
    serverQuery: 'openai',
    suggestion: 'OpenAI-related MCP tools',
  },
  {
    pattern: /^ANTHROPIC_API_KEY$/,
    service: 'Anthropic',
  },
  {
    pattern: /^GOOGLE_API_KEY$|^GEMINI_API_KEY$/,
    service: 'Google / Gemini',
    serverQuery: 'google',
    suggestion: 'Google MCP server for search, docs, drive',
  },
  {
    pattern: /^SLACK_TOKEN$|^SLACK_BOT_TOKEN$|^SLACK_WEBHOOK_URL$/,
    service: 'Slack',
    serverQuery: 'slack',
    suggestion: 'Slack MCP server for messaging',
  },
  {
    pattern: /^DISCORD_TOKEN$|^DISCORD_BOT_TOKEN$/,
    service: 'Discord',
    serverQuery: 'discord',
    suggestion: 'Discord MCP server for messaging',
  },
  {
    pattern: /^NOTION_API_KEY$|^NOTION_TOKEN$/,
    service: 'Notion',
    serverQuery: 'notion',
    suggestion: 'Notion MCP server for workspace access',
  },
  {
    pattern: /^LINEAR_API_KEY$/,
    service: 'Linear',
    serverQuery: 'linear',
    suggestion: 'Linear MCP server for issue tracking',
  },
  {
    pattern: /^JIRA_API_TOKEN$|^JIRA_TOKEN$/,
    service: 'Jira',
    serverQuery: 'jira',
    suggestion: 'Jira MCP server for issue tracking',
  },
  {
    pattern: /^POSTGRES_URL$|^DATABASE_URL$|^POSTGRES_CONNECTION$/,
    service: 'PostgreSQL',
    serverQuery: 'postgres',
    suggestion: 'PostgreSQL MCP server for database access',
  },
  {
    pattern: /^SUPABASE_URL$|^SUPABASE_KEY$|^SUPABASE_SERVICE_ROLE_KEY$/,
    service: 'Supabase',
    serverQuery: 'supabase',
    suggestion: 'Supabase MCP server for database and auth',
  },
  {
    pattern: /^FIREBASE_TOKEN$|^FIREBASE_API_KEY$/,
    service: 'Firebase',
    serverQuery: 'firebase',
    suggestion: 'Firebase MCP server',
  },
  {
    pattern: /^AWS_ACCESS_KEY_ID$|^AWS_SECRET_ACCESS_KEY$/,
    service: 'AWS',
    serverQuery: 'aws',
    suggestion: 'AWS MCP server for cloud services',
  },
  {
    pattern: /^SENTRY_DSN$|^SENTRY_AUTH_TOKEN$/,
    service: 'Sentry',
    serverQuery: 'sentry',
    suggestion: 'Sentry MCP server for error tracking',
  },
  {
    pattern: /^STRIPE_SECRET_KEY$|^STRIPE_API_KEY$/,
    service: 'Stripe',
    serverQuery: 'stripe',
    suggestion: 'Stripe MCP server for payment management',
  },
  {
    pattern: /^TWILIO_AUTH_TOKEN$|^TWILIO_ACCOUNT_SID$/,
    service: 'Twilio',
    serverQuery: 'twilio',
    suggestion: 'Twilio MCP server for SMS and voice',
  },
  {
    pattern: /^SENDGRID_API_KEY$/,
    service: 'SendGrid',
    serverQuery: 'sendgrid',
    suggestion: 'SendGrid/email MCP server',
  },
  {
    pattern: /^VERCEL_TOKEN$/,
    service: 'Vercel',
    serverQuery: 'vercel',
    suggestion: 'Vercel MCP server for deployment management',
  },
  {
    pattern: /^CLOUDFLARE_API_TOKEN$/,
    service: 'Cloudflare',
    serverQuery: 'cloudflare',
    suggestion: 'Cloudflare MCP server',
  },
  {
    pattern: /^BRAVE_API_KEY$/,
    service: 'Brave Search',
    serverQuery: 'brave-search',
    suggestion: 'Brave Search MCP server for web search',
  },
  {
    pattern: /^TAVILY_API_KEY$/,
    service: 'Tavily',
    serverQuery: 'tavily',
    suggestion: 'Tavily MCP server for web search',
  },
  {
    pattern: /^VOYAGE_API_KEY$/,
    service: 'Voyage AI',
  },
  {
    pattern: /^JINA_API_KEY$/,
    service: 'Jina AI',
  },
  {
    pattern: /^PINECONE_API_KEY$/,
    service: 'Pinecone',
    serverQuery: 'pinecone',
    suggestion: 'Pinecone MCP server for vector search',
  },
  {
    pattern: /^REDIS_URL$|^REDIS_HOST$/,
    service: 'Redis',
    serverQuery: 'redis',
    suggestion: 'Redis MCP server for caching/data',
  },
  {
    pattern: /^MONGODB_URI$|^MONGO_URL$/,
    service: 'MongoDB',
    serverQuery: 'mongodb',
    suggestion: 'MongoDB MCP server for database access',
  },
];

// Catch-all for generic API key patterns
const GENERIC_KEY_REGEX = /^[A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|_TOKEN|_SECRET|_KEY)$/;

// --- Parsing ---

/**
 * Parse a .env file and extract variable names and whether they have real values.
 * Handles comments, empty values, and quoted values.
 */
export function parseEnvFile(content: string): Array<{ name: string; hasValue: boolean }> {
  const results: Array<{ name: string; hasValue: boolean }> = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;

    const name = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Check if the value looks like a placeholder
    const isPlaceholder = !value ||
      value === 'your-key-here' ||
      value === 'CHANGE_ME' ||
      value === 'xxx' ||
      value.startsWith('$') ||
      value.startsWith('${');

    results.push({ name, hasValue: !isPlaceholder });
  }

  return results;
}

/**
 * Match a detected key name against known patterns.
 */
function matchKeyPattern(name: string): KeyPattern | undefined {
  return KEY_PATTERNS.find((p) => p.pattern.test(name));
}

// --- Main Discovery ---

/** Options for environment discovery */
export interface EnvDiscoveryOptions {
  /** Directory to scan (defaults to cwd) */
  dir?: string;
  /** Additional directories to scan for .env files */
  extraDirs?: string[];
}

/**
 * Scan for .env files and detect API keys with suggestions.
 */
export function discoverEnvKeys(options?: EnvDiscoveryOptions): EnvDiscoveryResult {
  const dir = options?.dir ?? process.cwd();
  const keys: DetectedApiKey[] = [];
  const filesScanned: string[] = [];
  const seenNames = new Set<string>();

  // Files to scan in the harness directory
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];

  for (const envFile of envFiles) {
    const filePath = join(dir, envFile);
    if (!existsSync(filePath)) continue;

    filesScanned.push(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseEnvFile(content);

    for (const { name, hasValue } of parsed) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      // Check against known patterns
      const pattern = matchKeyPattern(name);

      // Only include keys that match known patterns or generic API key patterns
      if (pattern || GENERIC_KEY_REGEX.test(name)) {
        keys.push({
          name,
          source: basename(filePath),
          hasValue,
          suggestion: pattern?.suggestion,
        });
      }
    }
  }

  // Also scan extra directories (e.g., parent project directory)
  if (options?.extraDirs) {
    for (const extraDir of options.extraDirs) {
      for (const envFile of envFiles) {
        const filePath = join(extraDir, envFile);
        if (!existsSync(filePath)) continue;

        filesScanned.push(filePath);
        const content = readFileSync(filePath, 'utf-8');
        const parsed = parseEnvFile(content);

        for (const { name, hasValue } of parsed) {
          if (seenNames.has(name)) continue;
          seenNames.add(name);

          const pattern = matchKeyPattern(name);
          if (pattern || GENERIC_KEY_REGEX.test(name)) {
            keys.push({
              name,
              source: basename(filePath),
              hasValue,
              suggestion: pattern?.suggestion,
            });
          }
        }
      }
    }
  }

  // Generate suggestions from detected keys
  const suggestions: EnvSuggestion[] = [];
  const suggestedQueries = new Set<string>();

  for (const key of keys) {
    const pattern = matchKeyPattern(key.name);
    if (pattern?.serverQuery && pattern.suggestion && !suggestedQueries.has(pattern.serverQuery)) {
      suggestedQueries.add(pattern.serverQuery);
      suggestions.push({
        message: pattern.suggestion,
        serverQuery: pattern.serverQuery,
        triggeredBy: key.name,
      });
    }
  }

  return { keys, filesScanned, suggestions };
}
