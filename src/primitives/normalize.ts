import { basename } from 'path';
import type { HarnessDocument } from '../core/types.js';

type ParsedFrontmatter = Record<string, unknown>;

const HARNESS_METADATA_KEYS = [
  'harness-tags',
  'harness-status',
  'harness-author',
  'harness-created',
  'harness-updated',
  'harness-related',
] as const;

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function stripHarnessKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!HARNESS_METADATA_KEYS.includes(key as (typeof HARNESS_METADATA_KEYS)[number])) {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Normalize a parsed frontmatter object into the canonical HarnessDocument-shaped
 * accessor set. For skills (Agent Skills spec compliance), harness extension
 * fields live in `metadata.harness-*` and get extracted here. For non-skill
 * primitives, those fields live at the top level.
 *
 * The `parentDirOrFilePath` is used as fallback for `id` derivation when `name`
 * is absent (flat single-file primitives).
 */
export function normalizeFrontmatter(
  raw: ParsedFrontmatter,
  kind: string,
  parentDirOrFilePath: string
): Omit<HarnessDocument, 'path' | 'body' | 'raw' | 'frontmatter' | 'bundleDir'> {
  const isSkill = kind === 'skills';

  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const id = name ?? basename(parentDirOrFilePath).replace(/\.md$/, '');

  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const license = typeof raw.license === 'string' ? raw.license : undefined;
  const compatibility = typeof raw.compatibility === 'string' ? raw.compatibility : undefined;
  const allowedToolsString = typeof raw['allowed-tools'] === 'string' ? raw['allowed-tools'] : '';
  const allowedTools = allowedToolsString
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const meta = (raw.metadata as Record<string, unknown> | undefined) ?? {};

  const tags = isSkill ? parseList(meta['harness-tags']) : parseList(raw.tags);
  const statusRaw = isSkill ? meta['harness-status'] : raw.status;
  const status = (statusRaw === 'archived' || statusRaw === 'deprecated' || statusRaw === 'draft' || statusRaw === 'active'
    ? statusRaw
    : 'active') as HarnessDocument['status'];
  const authorRaw = isSkill ? meta['harness-author'] : raw.author;
  const author = (authorRaw === 'agent' || authorRaw === 'infrastructure' || authorRaw === 'human'
    ? authorRaw
    : 'human') as HarnessDocument['author'];
  const created = isSkill
    ? (typeof meta['harness-created'] === 'string' ? (meta['harness-created'] as string) : undefined)
    : (typeof raw.created === 'string' ? raw.created : undefined);
  const updated = isSkill
    ? (typeof meta['harness-updated'] === 'string' ? (meta['harness-updated'] as string) : undefined)
    : (typeof raw.updated === 'string' ? raw.updated : undefined);
  const related = isSkill ? parseList(meta['harness-related']) : parseList(raw.related);

  const finalMetadata = isSkill
    ? stripHarnessKeys(meta)
    : (Object.keys(meta).length === 0 ? undefined : meta);

  return {
    id,
    name: name ?? id,
    description,
    license,
    compatibility,
    allowedTools,
    tags,
    status,
    author,
    created,
    updated,
    related,
    // Non-skill type-specific fields (read top-level, undefined for skills)
    schedule: !isSkill && typeof raw.schedule === 'string' ? raw.schedule : undefined,
    with: !isSkill && typeof raw.with === 'string' ? raw.with : undefined,
    channel: !isSkill && typeof raw.channel === 'string' ? raw.channel : undefined,
    duration_minutes: !isSkill && typeof raw.duration_minutes === 'number' ? raw.duration_minutes : undefined,
    max_retries: !isSkill && typeof raw.max_retries === 'number' ? raw.max_retries : undefined,
    retry_delay_ms: !isSkill && typeof raw.retry_delay_ms === 'number' ? raw.retry_delay_ms : undefined,
    durable: !isSkill && typeof raw.durable === 'boolean' ? raw.durable : undefined,
    model: !isSkill && (raw.model === 'primary' || raw.model === 'summary' || raw.model === 'fast') ? raw.model : undefined,
    active_tools: !isSkill && Array.isArray(raw.active_tools) ? (raw.active_tools as string[]) : undefined,
    metadata: finalMetadata,
  };
}
