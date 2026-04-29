---
id: ship-feature
tags: [playbook, development, shipping]
author: human
status: active
related:
  - read-before-edit
  - search-before-create
---

<!-- L0: Ship a feature — understand, research, plan, build, verify, deliver. -->
<!-- L1: Adaptive workflow for shipping features: understand the ask fully before starting ->
     research existing patterns -> plan approach -> build incrementally (one file at a time) ->
     write tests alongside -> verify everything works -> deliver with context. -->

# Playbook: Ship Feature

## Steps (Adapt as Needed)
1. **Understand** — Read the full ask. Ask clarifying questions if ambiguous.
2. **Research** — Look at existing code, patterns, and conventions.
3. **Plan** — Outline approach. Identify risks. Share plan if complex.
4. **Build** — One file at a time. Tests alongside. Read before edit.
5. **Verify** — Run tests. Check for regressions. Manual smoke test.
6. **Deliver** — Push with clear commit message. Summarize what changed and why.

## Judgment Calls
- If scope creep emerges, flag it early rather than expanding silently.
- If a dependency is missing, propose adding it with rationale.
- If something seems wrong with the ask, say so.
