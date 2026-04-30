/**
 * Builtin starter packs — installable bundles of primitives (workflows,
 * rules, instincts, skills) that users can customize after installation.
 *
 * Install via: `harness install pack:<name>`
 * List available: `harness install pack:list`
 */

import type { PackedBundle, BundleManifest, BundleFileEntry } from './primitive-registry.js';

export interface StarterPack {
  name: string;
  description: string;
  tags: string[];
  files: Array<{ path: string; content: string; id: string; description: string }>;
}

const PACKS: Record<string, StarterPack> = {
  'daily-briefs': {
    name: 'daily-briefs',
    description: 'Morning briefing and evening review workflows — summarize upcoming tasks, review completed work, and plan next steps.',
    tags: ['daily', 'briefing', 'review', 'productivity'],
    files: [
      {
        path: 'workflows/morning-brief.md',
        id: 'morning-brief',
        description: 'Morning briefing workflow that summarizes recent sessions and plans the day.',
        content: `---
id: morning-brief
tags: [workflow, daily, morning]
author: infrastructure
status: active
schedule: "0 8 * * 1-5"
---
# Morning Brief

Review yesterday's sessions and journal, then produce a concise daily brief.

## Instructions

1. Load the most recent journal entry and any sessions from the last 24 hours.
2. Summarize key accomplishments, open questions, and blockers.
3. List the top 3 priorities for today based on recent activity patterns.
4. Note any instincts or rules that were frequently triggered.
5. Keep the output under 500 words — this is a quick scan, not a deep analysis.

## Output Format

**Yesterday's highlights:**
- [bullet points]

**Today's priorities:**
1. [priority]
2. [priority]
3. [priority]

**Open questions / blockers:**
- [if any]
`,
      },
      {
        path: 'workflows/evening-review.md',
        id: 'evening-review',
        description: 'Evening review workflow that synthesizes the day and prepares for tomorrow.',
        content: `---
id: evening-review
tags: [workflow, daily, evening, review]
author: infrastructure
status: active
schedule: "0 18 * * 1-5"
---
# Evening Review

Synthesize today's work and prepare handoff notes for tomorrow.

## Instructions

1. Load all sessions from today.
2. Identify what was accomplished vs. what was planned (from morning brief if available).
3. Note any recurring patterns, surprises, or friction points.
4. Suggest 1-2 instinct candidates if behavioral patterns emerge.
5. Write a brief handoff note for tomorrow's morning brief.

## Output Format

**Completed today:**
- [bullet points]

**Planned but not completed:**
- [if any, with reasons]

**Observations:**
- [patterns, friction, surprises]

**Tomorrow's handoff:**
- [brief note for morning brief]
`,
      },
    ],
  },

  'weekly-review': {
    name: 'weekly-review',
    description: 'End-of-week review workflow — analyze the week, compress journals, surface trends, and set goals for next week.',
    tags: ['weekly', 'review', 'retrospective', 'planning'],
    files: [
      {
        path: 'workflows/weekly-review.md',
        id: 'weekly-review',
        description: 'Weekly review workflow that analyzes the week and sets goals.',
        content: `---
id: weekly-review
tags: [workflow, weekly, review, retrospective]
author: infrastructure
status: active
schedule: "0 17 * * 5"
---
# Weekly Review

Analyze the past week's work, compress journals, and plan next week.

## Instructions

1. Load all journal entries from this week (Monday through today).
2. Identify the top 3-5 themes across the week's work.
3. Note which instincts fired most often and whether they were helpful.
4. Identify any skills or playbooks that were missing or underperforming.
5. Suggest concrete goals for next week (2-3 maximum).
6. Flag any rules that seem outdated or contradictory.

## Output Format

**Week of [date range]**

**Key themes:**
1. [theme with brief explanation]
2. [theme]
3. [theme]

**Instinct effectiveness:**
- [instinct name]: [helpful / needs tuning / remove]

**Gaps identified:**
- [missing skill or playbook suggestion]

**Next week's goals:**
1. [specific, actionable goal]
2. [goal]

**Maintenance notes:**
- [rules to review, primitives to archive, etc.]
`,
      },
    ],
  },

  'code-review': {
    name: 'code-review',
    description: 'Code review workflow — analyzes recent code changes, checks for patterns and anti-patterns, and generates review notes.',
    tags: ['code-review', 'development', 'quality'],
    files: [
      {
        path: 'workflows/code-review.md',
        id: 'code-review-workflow',
        description: 'Code review workflow that analyzes recent changes and generates review notes.',
        content: `---
id: code-review-workflow
tags: [workflow, code-review, development]
author: infrastructure
status: active
---
# Code Review Workflow

Analyze recent code changes and generate structured review notes.

## Instructions

1. Review the most recent session where code was written or modified.
2. Check for common issues:
   - Missing error handling (empty catches, unhandled promises)
   - Type safety violations (any usage, missing return types)
   - Security concerns (unsanitized input, hardcoded secrets)
   - Code duplication or missed reuse opportunities
3. Check adherence to project rules and instincts.
4. Note positive patterns worth reinforcing as instincts.
5. Generate a structured review with severity levels.

## Output Format

**Review of [session/change description]**

**Critical issues:**
- [severity: high] [description]

**Improvements:**
- [severity: medium] [suggestion]

**Good patterns:**
- [pattern worth keeping / promoting to instinct]

**Summary:**
[1-2 sentence overall assessment]
`,
      },
      {
        path: 'workflows/pr-checklist.md',
        id: 'pr-checklist',
        description: 'PR checklist workflow that generates a pre-merge review checklist.',
        content: `---
id: pr-checklist
tags: [workflow, code-review, pr, checklist]
author: infrastructure
status: active
---
# PR Checklist

Generate a pre-merge checklist based on project rules and recent changes.

## Instructions

1. Load all active rules from the harness.
2. For each rule category, generate a checklist item.
3. Add standard items: tests pass, no type errors, no lint warnings.
4. Include project-specific checks based on instincts.
5. Output as a copy-pasteable markdown checklist.

## Output Format

**Pre-merge checklist:**

- [ ] All tests pass
- [ ] No TypeScript errors (tsc --noEmit)
- [ ] No lint warnings
- [ ] Error handling: no empty catches, async errors handled
- [ ] Types: no \`any\`, explicit return types on exports
- [ ] Security: no hardcoded secrets, input validated
- [rule-specific items from harness rules]
`,
      },
    ],
  },

  'code-reviewer': {
    name: 'code-reviewer',
    description: 'Multi-primitive code review pack — rules for code quality, instincts for review patterns, and a skill for structured review technique.',
    tags: ['code-review', 'quality', 'rules', 'instincts', 'skills'],
    files: [
      {
        path: 'rules/code-quality.md',
        id: 'code-quality-rules',
        description: 'Code quality rules enforcing error handling, type safety, and security.',
        content: `---
id: code-quality-rules
tags: [rule, code-quality, error-handling, type-safety, security]
author: infrastructure
status: active
---
# Code Quality Rules

Enforceable rules for maintaining code quality across the codebase.

## Error Handling

- **Never** leave a catch block empty. Every catch must log or handle the error meaningfully.
- **Always** handle async errors — every async function must have error handling at its boundary.
- **Never** use generic \`catch (e) { throw e }\` — either handle or let it propagate naturally.

## Type Safety

- **Never** use \`any\` — use \`unknown\` with type narrowing, generics, or explicit types.
- **Always** add explicit return types on exported functions.
- **Never** trust external data at runtime — validate at system boundaries.

## Security

- **Never** hardcode secrets, API keys, or tokens in source code.
- **Always** parameterize database queries — never concatenate user input.
- **Never** use \`eval()\`, \`innerHTML\`, or \`document.write()\` with unsanitized input.
- **Always** validate and sanitize user input at the boundary where it enters the system.

## Structure

- **Prefer** early returns and guard clauses — happy path last.
- **Never** create a new utility function without first searching for an existing one.
- **Always** prefer editing existing files over creating new ones.
`,
      },
      {
        path: 'rules/review-standards.md',
        id: 'review-standards',
        description: 'Review standards for consistent, actionable code review feedback.',
        content: `---
id: review-standards
tags: [rule, code-review, standards, feedback]
author: infrastructure
status: active
---
# Review Standards

Standards for producing consistent, actionable code review feedback.

## Severity Levels

- **Critical**: Security vulnerability, data loss risk, or crash. Must fix before merge.
- **High**: Logic error, missing error handling, or broken contract. Should fix before merge.
- **Medium**: Code smell, duplication, or missed optimization. Fix soon.
- **Low**: Style preference, naming suggestion, or minor improvement. Optional.

## Review Checklist

- Every review must note at least one positive pattern (reinforcement).
- Every issue must include a suggested fix, not just a complaint.
- Reviews should reference specific rules or instincts when applicable.
- Avoid vague feedback like "this could be better" — be specific and actionable.

## Scope

- Review only what changed — do not nitpick unrelated code.
- Flag pre-existing issues separately from new issues.
- If a change is too large to review effectively, request it be split.
`,
      },
      {
        path: 'instincts/review-pattern-detection.md',
        id: 'review-pattern-detection',
        description: 'Instinct for detecting common code review patterns and anti-patterns.',
        content: `---
id: review-pattern-detection
tags: [instinct, code-review, patterns, anti-patterns]
author: infrastructure
status: active
---
# Review Pattern Detection

Behavioral instinct for recognizing patterns during code review.

## Trigger

When reviewing code changes or analyzing session output that includes code modifications.

## Patterns to Watch For

- **Copy-paste duplication**: Same logic appearing in multiple places — suggest extraction.
- **Error swallowing**: Catch blocks that log but don't re-throw or handle — flag as silent failure.
- **Missing edge cases**: Functions that handle the happy path but not nulls, empty arrays, or errors.
- **Leaky abstractions**: Implementation details exposed through public interfaces.
- **Premature optimization**: Complex code with no measured performance need.
- **Magic values**: Hardcoded numbers or strings that should be named constants.

## Response

When a pattern is detected, note it in the review with the pattern name and a brief explanation. Suggest the specific fix, not just the problem.
`,
      },
      {
        path: 'instincts/refactor-opportunity.md',
        id: 'refactor-opportunity',
        description: 'Instinct for spotting refactoring opportunities during review.',
        content: `---
id: refactor-opportunity
tags: [instinct, refactoring, code-review, improvement]
author: infrastructure
status: active
---
# Refactor Opportunity Detection

Behavioral instinct for identifying refactoring opportunities.

## Trigger

When code changes reveal structural issues or when the same area is modified repeatedly.

## Signals

- **Shotgun surgery**: A single logical change requires touching 3+ files — extract shared logic.
- **Feature envy**: A function that mostly uses data from another module — move it.
- **Long parameter lists**: Functions with 4+ parameters — consider an options object.
- **Nested conditionals**: 3+ levels of nesting — extract early returns or helper functions.
- **God objects**: Classes or modules with 10+ responsibilities — split by concern.

## Response

Note the refactoring opportunity with the specific smell name. Only suggest refactoring if it improves clarity — not every code smell needs immediate action.
`,
      },
      {
        path: 'skills/structured-review.md',
        id: 'structured-review-skill',
        description: 'Skill for conducting structured, multi-pass code reviews.',
        content: `---
id: structured-review-skill
tags: [skill, code-review, technique, methodology]
author: infrastructure
status: active
---
# Structured Code Review

A systematic approach to reviewing code changes in multiple passes.

## Technique: Three-Pass Review

### Pass 1: Correctness (5 minutes)
- Does the code do what the author intended?
- Are there logic errors, off-by-one issues, or race conditions?
- Do all error paths terminate correctly?

### Pass 2: Quality (3 minutes)
- Does it follow project rules and coding standards?
- Are there opportunities for reuse or simplification?
- Is the code testable? Are there missing tests?

### Pass 3: Design (2 minutes)
- Does the change fit the existing architecture?
- Are the abstractions at the right level?
- Will this be easy to modify in the future?

## Output Template

\`\`\`
**Correctness**: [pass/issues found]
**Quality**: [pass/improvements suggested]
**Design**: [pass/concerns noted]
**Verdict**: [approve / request changes / discuss]
\`\`\`

## Tips

- Time-box each pass to avoid rabbit holes.
- Record the first pass findings before moving to the next — fresh eyes find different things.
- If you find a critical issue in pass 1, stop and report it immediately.
`,
      },
    ],
  },

  'personal-assistant': {
    name: 'personal-assistant',
    description: 'Personal assistant pack — daily planning workflow, communication instincts, and a task management skill for organizing priorities.',
    tags: ['productivity', 'planning', 'communication', 'task-management'],
    files: [
      {
        path: 'workflows/daily-planner.md',
        id: 'daily-planner',
        description: 'Daily planning workflow that organizes priorities and schedules tasks.',
        content: `---
id: daily-planner
tags: [workflow, daily, planning, productivity]
author: infrastructure
status: active
schedule: "0 7 * * 1-5"
---
# Daily Planner

Create a structured daily plan from open tasks, calendar items, and recent context.

## Instructions

1. Load the most recent journal entry and state.md.
2. Identify all open tasks from \`unfinished_business\` in state.
3. Check for any scheduled workflows firing today.
4. Categorize tasks by urgency and importance (Eisenhower matrix).
5. Produce a time-blocked plan for the day.
6. Estimate total focus hours needed vs. available.

## Output Format

**Date: [today]**

**Must do today (urgent + important):**
1. [task with estimated time]

**Should do today (important, not urgent):**
1. [task]

**Quick wins (< 15 min):**
- [task]

**Scheduled:**
- [time] [event or workflow]

**Focus hours needed:** [N] / **Available:** [M]
`,
      },
      {
        path: 'workflows/inbox-triage.md',
        id: 'inbox-triage',
        description: 'Inbox triage workflow that processes and categorizes incoming items.',
        content: `---
id: inbox-triage
tags: [workflow, triage, inbox, productivity]
author: infrastructure
status: active
proactive: true
---
# Inbox Triage

Process incoming items and categorize them for action.

## Instructions

1. Scan recent sessions and events for unprocessed items.
2. For each item, determine:
   - **Action required?** Yes/No
   - **Urgency:** Now / Today / This week / Someday
   - **Category:** Task / Question / Reference / Noise
3. Items requiring action go to state.md unfinished_business.
4. Questions get queued for the next interactive session.
5. Reference items get filed as session notes.
6. Noise gets acknowledged and dropped.

## Output Format

**Processed [N] items:**

| Item | Action | Urgency | Category |
|------|--------|---------|----------|
| [description] | [yes/no] | [urgency] | [category] |

**Added to queue:** [count]
**Filed as reference:** [count]
**Dropped:** [count]
`,
      },
      {
        path: 'instincts/clear-communication.md',
        id: 'clear-communication',
        description: 'Instinct for clear, concise communication in responses.',
        content: `---
id: clear-communication
tags: [instinct, communication, clarity, writing]
author: infrastructure
status: active
---
# Clear Communication

Behavioral instinct for producing clear, actionable communication.

## Trigger

When generating any output that will be read by a human — responses, summaries, reports, plans.

## Principles

- **Lead with the answer.** State the conclusion first, then provide supporting detail.
- **Be specific.** Replace "soon" with dates, "some" with counts, "improve" with metrics.
- **One idea per paragraph.** Dense paragraphs with multiple ideas are hard to scan.
- **Use structure.** Headers, lists, and tables are faster to process than prose.
- **Cut filler.** Remove "I think", "basically", "in order to", "it should be noted that".

## Anti-patterns

- Restating the question before answering it.
- Using jargon without context.
- Providing information the reader didn't ask for.
- Hedging when confidence is high.

## Response

Apply these principles automatically. If a draft is unclear, restructure before outputting.
`,
      },
      {
        path: 'instincts/context-awareness.md',
        id: 'context-awareness',
        description: 'Instinct for maintaining awareness of user context and recent history.',
        content: `---
id: context-awareness
tags: [instinct, context, memory, personalization]
author: infrastructure
status: active
---
# Context Awareness

Behavioral instinct for maintaining awareness of what the user is working on.

## Trigger

At the start of every session and when switching topics.

## Behavior

- Check state.md for current goals and active workflows before responding.
- Reference recent session history when it adds value (not gratuitously).
- Notice when the user returns to a topic from a previous session — offer continuity.
- Track which tools, files, and topics appear frequently — these are the user's active context.
- When the user's request is ambiguous, use recent context to disambiguate rather than asking.

## Anti-patterns

- Treating every session as a fresh start with no history.
- Asking questions that were already answered in a recent session.
- Ignoring state.md goals when prioritizing tasks.
`,
      },
      {
        path: 'skills/task-prioritization.md',
        id: 'task-prioritization-skill',
        description: 'Skill for prioritizing tasks using the Eisenhower matrix and energy mapping.',
        content: `---
id: task-prioritization-skill
tags: [skill, productivity, prioritization, planning]
author: infrastructure
status: active
---
# Task Prioritization

Systematic approach to prioritizing tasks when everything feels urgent.

## Technique: Eisenhower + Energy Mapping

### Step 1: Classify by Urgency and Importance

| | Urgent | Not Urgent |
|---|--------|------------|
| **Important** | Do first | Schedule |
| **Not Important** | Delegate/batch | Drop or defer |

### Step 2: Map to Energy Levels

- **High energy tasks** (creative, complex decisions): Morning block
- **Medium energy tasks** (meetings, reviews): Midday
- **Low energy tasks** (admin, filing, routine): Late afternoon

### Step 3: Apply Constraints

- Maximum 3 "must do" items per day — more than 3 means nothing is truly prioritized.
- If everything is urgent, ask: "What happens if this waits 24 hours?" If the answer is "nothing", it's not urgent.
- Group similar tasks to reduce context-switching cost.

## Output

Produce a prioritized list with:
1. Task name
2. Quadrant (urgent-important, important, urgent, neither)
3. Estimated time
4. Suggested time block (morning/midday/afternoon)
`,
      },
    ],
  },

  'devops': {
    name: 'devops',
    description: 'DevOps safety pack — deployment rules, monitoring instincts, and an incident response skill for handling production issues.',
    tags: ['devops', 'deployment', 'monitoring', 'incident-response', 'safety'],
    files: [
      {
        path: 'rules/deployment-safety.md',
        id: 'deployment-safety-rules',
        description: 'Deployment safety rules preventing common production failures.',
        content: `---
id: deployment-safety-rules
tags: [rule, devops, deployment, safety, production]
author: infrastructure
status: active
---
# Deployment Safety Rules

Rules to prevent common deployment failures and production incidents.

## Pre-Deployment

- **Never** deploy without all tests passing — no exceptions, no "just this once".
- **Never** deploy directly to production — always go through staging first.
- **Always** review the diff before deploying — automated deployments must still be human-approved.
- **Never** deploy on Fridays after 2 PM or before holidays without explicit approval.
- **Always** have a rollback plan before deploying — know the exact command to revert.

## During Deployment

- **Always** deploy incrementally — canary or blue-green, never all-at-once.
- **Never** deploy multiple unrelated changes in a single deployment.
- **Always** monitor error rates for 15 minutes after deployment — do not walk away.

## Secrets and Config

- **Never** hardcode environment-specific values — use environment variables or config maps.
- **Never** commit secrets to version control — use secret management tools.
- **Always** rotate credentials after any suspected exposure — assume compromise.

## Database

- **Never** run destructive migrations without a backup taken in the last hour.
- **Always** test migrations on a copy of production data before running on production.
- **Never** drop columns or tables without confirming zero references in running code.
`,
      },
      {
        path: 'rules/infrastructure-standards.md',
        id: 'infrastructure-standards',
        description: 'Infrastructure standards for consistent, maintainable deployments.',
        content: `---
id: infrastructure-standards
tags: [rule, devops, infrastructure, standards]
author: infrastructure
status: active
---
# Infrastructure Standards

Standards for maintaining consistent, auditable infrastructure.

## Configuration

- All infrastructure must be defined as code (Terraform, Pulumi, CloudFormation, or similar).
- Manual changes to production infrastructure require a follow-up PR within 24 hours.
- Every service must have health check endpoints (/health, /ready).
- Every service must emit structured logs (JSON) with request IDs for tracing.

## Monitoring

- Every service must have alerts for: error rate > 1%, latency p99 > 2s, availability < 99.9%.
- Alerts must page on-call for critical issues — never rely on email-only alerts.
- Dashboard must show: request rate, error rate, latency percentiles, resource utilization.

## Access Control

- Production access requires MFA and is logged.
- Prefer role-based access over individual permissions.
- Review access lists quarterly — remove unused permissions.

## Backups

- All persistent data must be backed up daily with 30-day retention.
- Test backup restoration quarterly — untested backups are not backups.
`,
      },
      {
        path: 'instincts/anomaly-detection.md',
        id: 'anomaly-detection',
        description: 'Instinct for detecting anomalies in metrics, logs, and deployment behavior.',
        content: `---
id: anomaly-detection
tags: [instinct, devops, monitoring, anomaly, alerting]
author: infrastructure
status: active
---
# Anomaly Detection

Behavioral instinct for noticing when something is off in operational metrics.

## Trigger

When reviewing deployment output, log summaries, or metric dashboards.

## Signals

- **Error rate spike**: Any increase > 2x baseline within 5 minutes of a deployment.
- **Latency creep**: p99 latency increasing steadily over hours — memory leak or connection exhaustion.
- **Silent failures**: Success rate stays high but throughput drops — upstream is failing to send.
- **Resource divergence**: CPU/memory usage differs significantly between replicas — one is stuck.
- **Clock skew**: Timestamps in logs jumping backward or forward — NTP issues.
- **Cascade pattern**: Multiple unrelated services degrading simultaneously — shared dependency.

## Response

When an anomaly is detected:
1. Note the specific metric and timeframe.
2. Correlate with recent deployments or config changes.
3. If post-deployment: recommend immediate rollback, investigate after.
4. If no recent change: check upstream dependencies and shared infrastructure.
`,
      },
      {
        path: 'instincts/change-risk-assessment.md',
        id: 'change-risk-assessment',
        description: 'Instinct for assessing risk before infrastructure or deployment changes.',
        content: `---
id: change-risk-assessment
tags: [instinct, devops, risk, change-management]
author: infrastructure
status: active
---
# Change Risk Assessment

Behavioral instinct for evaluating the risk of operational changes before executing them.

## Trigger

Before any deployment, configuration change, or infrastructure modification.

## Risk Factors

- **Blast radius**: How many users or services are affected if this fails?
- **Reversibility**: Can this be rolled back in under 5 minutes?
- **Observability**: Will we know if this breaks something? Are there alerts?
- **Timing**: Is this during peak traffic? During on-call handoff?
- **Novelty**: Has this type of change been done before? By this team?
- **Dependencies**: Does this change require coordinated changes in other services?

## Risk Levels

- **Low**: Small blast radius, instantly reversible, well-observed, done before.
- **Medium**: Moderate blast radius, reversible with effort, some unknowns.
- **High**: Large blast radius, difficult to reverse, novel, or during peak.

## Response

State the risk level and the primary risk factor before proceeding. For high-risk changes, suggest breaking the change into smaller, lower-risk steps.
`,
      },
      {
        path: 'skills/incident-response.md',
        id: 'incident-response-skill',
        description: 'Skill for structured incident response and post-incident analysis.',
        content: `---
id: incident-response-skill
tags: [skill, devops, incident-response, runbook]
author: infrastructure
status: active
---
# Incident Response

Structured approach to handling production incidents.

## Phase 1: Detect and Assess (0-5 minutes)

1. **Confirm the incident**: Verify the alert is real, not a false positive.
2. **Assess impact**: How many users affected? Is data at risk?
3. **Classify severity**:
   - **SEV1**: Service down, data loss, or security breach. Page everyone.
   - **SEV2**: Significant degradation, partial outage. Page on-call.
   - **SEV3**: Minor degradation, workaround available. Notify team.
4. **Communicate**: Post in incident channel with: what's happening, who's investigating, ETA for update.

## Phase 2: Mitigate (5-30 minutes)

1. **Check recent changes**: Was anything deployed in the last 2 hours? Roll it back.
2. **Check dependencies**: Are upstream services healthy?
3. **Scale or redirect**: Can traffic be shifted to healthy instances?
4. **Apply known fix**: Check runbooks for this failure mode.
5. **Update communication** every 15 minutes, even if no progress.

## Phase 3: Resolve and Recover

1. **Confirm resolution**: Metrics return to baseline for 15+ minutes.
2. **Communicate all-clear** with summary of what happened.
3. **Schedule post-mortem** within 48 hours.

## Phase 4: Post-Mortem Template

\`\`\`
**Incident**: [title]
**Date**: [date] | **Duration**: [time]
**Severity**: [SEV1/2/3]
**Impact**: [users/services affected]

**Timeline:**
- [HH:MM] Alert fired
- [HH:MM] Investigation started
- [HH:MM] Root cause identified
- [HH:MM] Fix applied
- [HH:MM] Confirmed resolved

**Root cause:** [description]
**Contributing factors:** [list]
**Action items:**
- [ ] [preventive measure with owner and due date]
\`\`\`
`,
      },
    ],
  },
};

/**
 * Get a builtin starter pack by name.
 * Returns null if the pack doesn't exist.
 */
export function getStarterPack(name: string): PackedBundle | null {
  const pack = PACKS[name];
  if (!pack) return null;

  const now = new Date().toISOString();
  const fileEntries: BundleFileEntry[] = pack.files.map(f => ({
    path: f.path,
    type: f.path.split('/')[0],
    id: f.id,
    description: f.description,
  }));

  const manifest: BundleManifest = {
    version: '1',
    name: `pack:${pack.name}`,
    description: pack.description,
    author: 'agent-harness',
    bundle_version: '1.0.0',
    created: now,
    types: [...new Set(fileEntries.map(f => f.type))],
    tags: pack.tags,
    files: fileEntries,
  };

  return {
    manifest,
    files: pack.files.map(f => ({ path: f.path, content: f.content })),
  };
}

/**
 * List all available builtin starter packs.
 */
export function listStarterPacks(): Array<{ name: string; description: string; fileCount: number; tags: string[] }> {
  return Object.values(PACKS).map(p => ({
    name: p.name,
    description: p.description,
    fileCount: p.files.length,
    tags: p.tags,
  }));
}

/**
 * Check if a source string is a pack reference (starts with "pack:").
 */
export function isPackReference(source: string): boolean {
  return source.startsWith('pack:');
}

/**
 * Parse the pack name from a "pack:<name>" reference.
 */
export function parsePackName(source: string): string {
  return source.slice(5); // Remove "pack:" prefix
}
