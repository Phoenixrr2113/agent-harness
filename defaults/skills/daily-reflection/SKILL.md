---
name: daily-reflection
description: >-
  Scheduled end-of-day reflection. Appends a short summary of the day's activity
  to memory/scratch.md.
metadata:
  harness-tags: 'workflow,scheduled,reflection'
  harness-status: active
  harness-author: human
  harness-related: 'research,respect-the-user'
---
# Workflow: Daily Reflection

## Schedule

```
0 18 * * *
```

Fires every day at 18:00 local time.

## What it does

1. Reads the most recent journal entries from today (`harness journal --today`).
2. Generates a short reflection covering:
   - What was accomplished
   - What was learned or noticed
   - Open threads worth revisiting tomorrow
3. Appends the reflection to `memory/scratch.md` under a `## YYYY-MM-DD` heading.

## Output format

```markdown
## 2026-04-08

- Shipped: <short line>
- Learned: <short line>
- Revisit: <short line>
```

Keep it brief. This is a log, not an essay.

## Why

Daily compaction turns ephemeral activity into durable memory. The agent reviews
`memory/scratch.md` on subsequent runs and can spot patterns across days.

Related: [research], [respect-the-user]
