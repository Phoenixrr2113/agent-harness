---
name: ship-feature
description: |
  Ship a feature end-to-end: understand the ask, research the codebase, plan,
  build test-first with small commits, verify via scripts, and deliver. Use this
  skill when starting any non-trivial feature, bug fix, or refactor that needs
  the full understand → plan → build → verify → deliver cycle.
license: MIT
metadata:
  harness-tags: 'methodology,development,shipping'
  harness-status: active
  harness-author: human
  harness-related: 'read-before-edit,search-before-create'
---

# ship-feature

## When to use

Use this skill when the user asks to implement a feature, fix a bug, or perform
a refactor that requires more than a trivial one-liner. It covers the full
lifecycle from understanding the ask through verified delivery.

## Available scripts

- `scripts/verify-tests.sh` — Run the project's test suite and return pass/fail counts as JSON. Call this after each significant change to confirm nothing regressed.
- `scripts/verify-build.sh` — Run the project's build and return success/failure as JSON. Call this before opening a PR.
- `scripts/pre-pr-checklist.sh` — Run typecheck + lint + tests + build all-or-nothing. Call this once when the feature is complete and all commits are staged.

## Workflow

1. **Understand** — Read the full ask. Ask clarifying questions if ambiguous.
2. **Research** — Search the codebase for existing patterns, types, and utilities that the change will touch. Read every related file completely — never speculate.
3. **Plan** — Outline the approach. Identify risks. Share the plan with the user if the change is non-trivial.
4. **Build** — One file at a time. Write or update tests alongside each change. Read before edit; reuse before create.
5. **Verify** — Run `scripts/verify-tests.sh` after each significant change. Address failures before moving to the next file.
6. **Pre-PR check** — Run `scripts/pre-pr-checklist.sh` once all commits are ready. Fix every error before opening the PR.
7. **Deliver** — Push with a clear commit message. Summarize what changed and why.

## Gotchas

- **Scope creep**: if the work reveals adjacent issues, flag them to the user rather than expanding the change silently.
- **Missing dependencies**: propose adding any missing library with a rationale before installing it.
- **Pre-PR checklist is blocking**: if `scripts/pre-pr-checklist.sh` returns `status: error`, fix the reported step before proceeding.
- **No test runner detected**: if `scripts/verify-tests.sh` returns `status: blocked` with `code: NO_TEST_COMMAND`, inform the user and agree on a manual verification step.

## Failure modes

If `scripts/pre-pr-checklist.sh` returns `status: error`, read `error.code`:

- `TYPECHECK_FAILED` — TypeScript errors present. Fix them before continuing.
- `LINT_FAILED` — Lint violations present. Fix or suppress with justification.
- `TESTS_FAILED` — Test suite is red. Fix failing tests before opening the PR.
- `BUILD_FAILED` — Build command failed. Fix compilation/bundling errors.
- `NO_TEST_COMMAND` — Project has no detectable test script. Discuss with user.
- `NO_BUILD_COMMAND` — Project has no detectable build script. Typecheck and lint are still enforced.
