import { existsSync } from 'fs';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import type { HarnessDocument } from '../core/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RuleAction = 'allow' | 'deny' | 'warn' | 'require_approval';

export interface ParsedRule {
  /** Source rule document ID */
  ruleId: string;
  /** What this rule regulates */
  subject: string;
  /** Whether it permits or blocks */
  action: RuleAction;
  /** Original directive text (for messages) */
  directive: string;
  /** Tags from the source document (for scoping) */
  tags: string[];
}

export interface RuleCheckInput {
  /** The action being attempted (e.g., "run", "tool_call", "delegate") */
  action: string;
  /** Free-text description of what's being attempted */
  description?: string;
  /** Relevant tags or topics for the check */
  tags?: string[];
  /** Tool name if this is a tool call */
  toolName?: string;
}

export interface RuleViolation {
  ruleId: string;
  directive: string;
  severity: 'deny' | 'warn' | 'require_approval';
  reason: string;
}

export interface RuleCheckResult {
  allowed: boolean;
  violations: RuleViolation[];
  warnings: RuleViolation[];
  requiresApproval: boolean;
  /** Human-readable summary */
  summary: string;
}

// ─── Rule Parsing ────────────────────────────────────────────────────────────

/**
 * Extract enforceable rules from a harness document.
 * Parses "never", "must not", "do not", "always", "require" directives
 * and converts them into structured rule objects.
 */
export function parseRulesFromDoc(doc: HarnessDocument): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const text = (doc.l0 + '\n' + doc.l1 + '\n' + doc.body).trim();

  for (const line of text.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;

    // Strip list markers
    const cleaned = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');

    // "Never" / "Do not" / "Must not" → deny
    const denyMatch = cleaned.match(
      /^(never|don'?t|do not|must not|should not|shouldn'?t)\s+(.+)/,
    );
    if (denyMatch) {
      const subject = denyMatch[2].replace(/[.!]$/, '');
      // Check if this is an approval gate (e.g., "never X without approval")
      if (/without\s+(explicit\s+)?(human\s+)?approval/.test(subject)) {
        rules.push({
          ruleId: doc.frontmatter.id,
          subject: subject.replace(/\s+without\s+(explicit\s+)?(human\s+)?approval.*$/, ''),
          action: 'require_approval',
          directive: cleaned,
          tags: doc.frontmatter.tags,
        });
      } else {
        rules.push({
          ruleId: doc.frontmatter.id,
          subject,
          action: 'deny',
          directive: cleaned,
          tags: doc.frontmatter.tags,
        });
      }
      continue;
    }

    // "Always" / "Must" / "Require" → allow (we note the requirement)
    const requireMatch = cleaned.match(
      /^(always|must|require|ensure)\s+(.+)/,
    );
    if (requireMatch) {
      const subject = requireMatch[2].replace(/[.!]$/, '');
      // "require approval" / "require explicit approval" patterns
      if (/\bapproval\b/.test(subject) || /\brequires?\s+(explicit\s+)?(human\s+)?approval\b/.test(subject)) {
        rules.push({
          ruleId: doc.frontmatter.id,
          subject,
          action: 'require_approval',
          directive: cleaned,
          tags: doc.frontmatter.tags,
        });
      } else {
        rules.push({
          ruleId: doc.frontmatter.id,
          subject,
          action: 'allow',
          directive: cleaned,
          tags: doc.frontmatter.tags,
        });
      }
      continue;
    }

    // "Avoid" → warn
    const warnMatch = cleaned.match(
      /^(avoid|prefer not to|try not to)\s+(.+)/,
    );
    if (warnMatch) {
      rules.push({
        ruleId: doc.frontmatter.id,
        subject: warnMatch[2].replace(/[.!]$/, ''),
        action: 'warn',
        directive: cleaned,
        tags: doc.frontmatter.tags,
      });
    }
  }

  return rules;
}

/**
 * Load and parse all enforceable rules from a harness directory.
 * Loads all documents from the rules/ directory and extracts structured rules.
 */
export function loadRules(harnessDir: string): ParsedRule[] {
  const rulesDir = join(harnessDir, 'rules');
  if (!existsSync(rulesDir)) return [];

  const docs = loadDirectory(rulesDir);
  const rules: ParsedRule[] = [];

  for (const doc of docs) {
    if (doc.frontmatter.status !== 'active') continue;
    rules.push(...parseRulesFromDoc(doc));
  }

  return rules;
}

// ─── Rule Checking ───────────────────────────────────────────────────────────

/**
 * Check whether an action violates any loaded rules.
 * Uses keyword overlap between the action description/tags and rule subjects.
 *
 * @param rules - Parsed rules from loadRules()
 * @param input - Description of the action being attempted
 * @returns Check result with violations, warnings, and approval requirements
 */
export function checkRules(rules: ParsedRule[], input: RuleCheckInput): RuleCheckResult {
  const violations: RuleViolation[] = [];
  const warnings: RuleViolation[] = [];
  let requiresApproval = false;

  // Build search text from input
  const searchText = [
    input.action,
    input.description ?? '',
    input.toolName ?? '',
    ...(input.tags ?? []),
  ].join(' ').toLowerCase();

  const searchWords = new Set(
    searchText.split(/\s+/).filter((w) => w.length > 2),
  );

  for (const rule of rules) {
    // Check if this rule is relevant to the current action
    const relevance = computeRelevance(rule, searchWords, input);
    if (relevance < 0.3) continue;

    if (rule.action === 'deny') {
      violations.push({
        ruleId: rule.ruleId,
        directive: rule.directive,
        severity: 'deny',
        reason: `Action matches denied rule: "${rule.directive}" (relevance: ${relevance.toFixed(2)})`,
      });
    } else if (rule.action === 'warn') {
      warnings.push({
        ruleId: rule.ruleId,
        directive: rule.directive,
        severity: 'warn',
        reason: `Action matches warning rule: "${rule.directive}" (relevance: ${relevance.toFixed(2)})`,
      });
    } else if (rule.action === 'require_approval') {
      requiresApproval = true;
      violations.push({
        ruleId: rule.ruleId,
        directive: rule.directive,
        severity: 'require_approval',
        reason: `Action requires approval: "${rule.directive}" (relevance: ${relevance.toFixed(2)})`,
      });
    }
  }

  const denyViolations = violations.filter((v) => v.severity === 'deny');
  const allowed = denyViolations.length === 0 && !requiresApproval;

  let summary: string;
  if (allowed && warnings.length === 0) {
    summary = 'All rule checks passed.';
  } else if (allowed) {
    summary = `Allowed with ${warnings.length} warning(s): ${warnings.map((w) => w.directive).join('; ')}`;
  } else if (requiresApproval && denyViolations.length === 0) {
    summary = `Requires human approval: ${violations.filter((v) => v.severity === 'require_approval').map((v) => v.directive).join('; ')}`;
  } else {
    summary = `Blocked by ${denyViolations.length} rule violation(s): ${denyViolations.map((v) => v.directive).join('; ')}`;
  }

  return {
    allowed,
    violations,
    warnings,
    requiresApproval,
    summary,
  };
}

/**
 * Compute relevance score (0–1) between a rule and search context.
 * Uses word overlap between rule subject/tags and input words/tags.
 */
function computeRelevance(
  rule: ParsedRule,
  searchWords: Set<string>,
  input: RuleCheckInput,
): number {
  // Extract words from rule subject
  const ruleWords = rule.subject
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (ruleWords.length === 0) return 0;

  // Count word overlap
  let matchCount = 0;
  for (const word of ruleWords) {
    if (searchWords.has(word)) {
      matchCount++;
    }
  }

  let score = matchCount / ruleWords.length;

  // Tag overlap boost
  if (input.tags && input.tags.length > 0) {
    const inputTags = new Set(input.tags.map((t) => t.toLowerCase()));
    const tagOverlap = rule.tags.filter((t) => inputTags.has(t.toLowerCase())).length;
    if (tagOverlap > 0) {
      score += 0.2 * (tagOverlap / Math.max(rule.tags.length, 1));
    }
  }

  return Math.min(score, 1.0);
}

/**
 * Convenience: load rules from disk and check an action in one call.
 */
export function enforceRules(
  harnessDir: string,
  input: RuleCheckInput,
): RuleCheckResult {
  const rules = loadRules(harnessDir);
  return checkRules(rules, input);
}
