import type { HarnessDocument } from '../../core/types.js';

/**
 * Compose IDENTITY.md content + active rules into a single markdown document
 * suitable for export to project-level CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * Section ordering is deterministic (rules sorted alphabetically by name) so
 * exports are byte-stable across re-runs of the same input.
 */
export function composeIdentityDocument(identity: string, rules: HarnessDocument[]): string {
  const sections: string[] = [];
  sections.push('## Identity');
  sections.push(identity.trim());

  if (rules.length > 0) {
    const activeRules = rules
      .filter((r) => r.status === 'active' || r.status === undefined)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    if (activeRules.length > 0) {
      sections.push('## Rules');
      for (const r of activeRules) {
        sections.push(`### ${r.name}`);
        if (r.description) sections.push(String(r.description).trim());
        if (r.body && r.body.trim()) sections.push(r.body.trim());
      }
    }
  }
  return sections.join('\n\n') + '\n';
}
