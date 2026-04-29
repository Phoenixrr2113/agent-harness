---
id: daily-reflection
tags: [workflow, scheduled, reflection]
author: human
status: active
related:
  - research
  - respect-the-user
---

<!-- L0: Scheduled end-of-day reflection. Appends a short summary of the day's activity to memory/scratch.md. -->
<!-- L1: Runs daily at 18:00 local via cron. The agent reads recent journal entries, produces a 3-5 line
     reflection (what was done, what was learned, what to revisit), and appends it to memory/scratch.md
     under a dated heading. See [research] for information-gathering patterns. -->

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
