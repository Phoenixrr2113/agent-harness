---
name: {{NAME}}
description: |
  Briefly describe what this skill does AND when to use it. Use imperative
  phrasing ("Use this skill when..."). Aim for 80-500 chars. Include keywords
  the model can pattern-match against the user's prompt.
license: MIT
metadata:
  harness-status: draft
  harness-author: human
---

# {{NAME}}

## When to use

Describe the trigger context. Example: "Use when the user asks to..."

## Available scripts

- `scripts/run.sh` — Brief description of what the script does and when to invoke it

## Workflow

1. **Step 1**: Run `scripts/run.sh <args>` and read the JSON result
2. **Step 2**: ...

## Gotchas

Non-obvious facts the agent would otherwise get wrong. Example: "The API
returns 200 even on auth failure — check the `error` field in the body, not
the HTTP status."

## Failure modes

Known errors and recovery paths. Each entry includes the `error.code` the
script returns and what the agent should do next.
