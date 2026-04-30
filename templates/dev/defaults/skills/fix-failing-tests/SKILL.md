---
name: fix-failing-tests
description: "Seven-step flow for diagnosing and fixing failing tests. Use when the user asks to fix failing tests, green the suite, or says 'tests are red' — works through reproduce → read → root-cause → propose → apply → verify → commit."
allowed-tools: "Read Edit Bash"
metadata:
  harness-tags: "playbook, testing, dev"
  harness-status: active
  harness-author: human
  harness-created: '2026-04-21'
  harness-updated: '2026-04-30'
  harness-related: "reviewer, test-runner, working-in-a-git-repo"
---

# Skill: Fix Failing Tests

## When this skill applies

Triggered by the human asking to fix failing tests, green the suite, or a related phrasing.

## Step 1 — Reproduce

Work in the assigned worktree (or request one per `working-in-a-git-repo`).
Run the project's test command and identify which files are red, which
specific test cases fail, and the assertion that fails with actual vs.
expected values.

If no tests are red, STOP — there's nothing to fix. Report back to human.

## Step 2 — Read the failing tests

Read the entire test file where failures occur. Understand what behavior
is under test and what the system-under-test is supposed to do. Read the
production code the test is exercising. Do not guess; read.

## Step 3 — Root-cause the failure

Answer: is the bug in the test, or in production code?

Common test-side bugs: hardcoded dates or timestamps going stale, shared
state across tests, caching that persists across assertions, mock drift
from real implementation.

If I cannot determine root cause in one pass, STOP and surface what I
found to the human.

## Step 4 — Propose the minimal fix

State in one paragraph:
- What I'm changing
- Which file(s)
- Why it resolves the failure without altering unintended behavior

Wait for the human's acknowledgement on non-trivial changes. For clear
test-only fixes with no production impact, proceed.

## Step 5 — Apply the fix

- ONE file at a time.
- Specific lines only. Never rewrite a whole file for a spot change.
- Follow existing patterns — check nearby tests for how they handle the
  same concern (mocking time, fixtures, setup/teardown).

## Step 6 — Verify

All three must pass:
1. Targeted suite green.
2. Full suite green (or no new failures beyond pre-existing unrelated ones).
3. Linter: no new errors.

If any fail, debug before proceeding. Do not commit red tests.

## Step 7 — Commit & report

- Commit on the feature branch with a message matching project style.
- Report to the human: branch name, commit SHA, files changed, one-line summary.
- DO NOT push. DO NOT open a PR. DO NOT merge to main.

## Failure handling

- If root cause is ambiguous → STOP, ask human.
- If the fix would require production-code changes (not just tests) → STOP,
  describe what's needed, ask human.
- If environment-specific issues emerge (CI git config, Node version, etc.) →
  note them and proceed where possible.
