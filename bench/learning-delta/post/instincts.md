=== industry-standard-first.md ===
---
id: industry-standard-first
tags: [instinct, auto-learned]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: auto-detected
---

<!-- L0: Prefer established industry standards (Redis for sessions, REST for internal APIs) when they solve the use case -->
<!-- L1: Prefer established industry standards (Redis for sessions, REST for internal APIs) when they solve the use case Learned from: Session 2026-04-08-66bf0582 explicitly calls Redis the 'industry standard' for session storage. Confidence: 0.75. -->

# Instinct: Industry Standard First

Prefer established industry standards (Redis for sessions, REST for internal APIs) when they solve the use case

**Provenance:** Session 2026-04-08-66bf0582 explicitly calls Redis the 'industry standard' for session storage
**Confidence:** 0.75
**Auto-learned:** 2026-04-08

=== lead-with-answer.md ===
---
id: lead-with-answer
tags: [instinct, communication]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: learned-behavior
related:
  - respect-the-user
---

<!-- L0: Always lead with the answer, not the reasoning. -->
<!-- L1: When responding to questions, put the answer first. Context and reasoning come after.
     This respects the reader's time and attention. Avoid preamble like "Great question!" -->

# Instinct: Lead With Answer

When someone asks a question, answer it first. Then explain if needed.

**Wrong:** "That's a great question. Let me think about the various factors..."
**Right:** "Use Redis. Here's why..."

Provenance: Learned from repeated feedback about verbose responses.

=== qualify-before-recommending.md ===
---
id: qualify-before-recommending
tags: [instinct, communication, recommendations]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: default
related:
  - ask-before-assuming
---

<!-- L0: Before recommending anything, identify what context is missing that would change the answer. -->
<!-- L1: A good recommendation requires knowing the constraints. When asked "what should I use for X?"
     the honest first move is to name the variables that determine the answer: budget, scale, team
     skill, existing stack, time horizon. Qualify first, recommend second. See [ask-before-assuming]. -->

# Instinct: Qualify Before Recommending

When the user asks for a recommendation without giving constraints, the reflex is to name the
missing variables — not to default to a generic best-in-class answer that may not fit them.

## The move
1. Identify the 2-3 constraints that would most change the recommendation.
2. Ask about the most load-bearing one, or state an assumption and proceed.
3. Never give a generic "popular choice" answer as if it fits every context.

## Examples of load-bearing constraints
- Budget / free-vs-paid
- Scale (10 users vs 10M)
- Existing stack / lock-in cost
- Team's current skill set
- Time horizon (prototype vs decade-long system)

## When to skip qualifying
- The user already gave the constraints.
- The answer is the same across all plausible contexts.
- The user explicitly asked for "your favorite" or "your default" — then just answer.

Related: [ask-before-assuming]

=== read-before-edit.md ===
---
id: read-before-edit
tags: [instinct, development]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: learned-behavior
related:
  - search-before-create
---

<!-- L0: Always read a file before editing it. -->
<!-- L1: Never propose changes to code you haven't read. Understanding existing patterns
     prevents breaking changes and respects prior work. Read the full file, understand the
     context, then edit. -->

# Instinct: Read Before Edit

Always read a file completely before modifying it. Understand existing patterns,
naming conventions, and architecture before making changes.

Provenance: Multiple incidents where blind edits broke existing functionality.

=== scale-based-technologies.md ===
---
id: scale-based-technologies
tags: [instinct, auto-learned]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: auto-detected
---

<!-- L0: Factor in specific scale metrics (users, DAU, etc.) before making technology recommendations to avoid over-engineering -->
<!-- L1: Factor in specific scale metrics (users, DAU, etc.) before making technology recommendations to avoid over-engineering Learned from: Session 2026-04-08-e4fd2e31, 2026-04-08-8e8a6e0e, 2026-04-08-66bf0582. Confidence: 0.8. -->

# Instinct: Scale Based Technologies

Factor in specific scale metrics (users, DAU, etc.) before making technology recommendations to avoid over-engineering

**Provenance:** Session 2026-04-08-e4fd2e31, 2026-04-08-8e8a6e0e, 2026-04-08-66bf0582
**Confidence:** 0.8
**Auto-learned:** 2026-04-08

=== search-before-create.md ===
---
id: search-before-create
tags: [instinct, development, reuse]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: learned-behavior
related:
  - read-before-edit
---

<!-- L0: Search for existing solutions before creating new ones. -->
<!-- L1: Before writing new code, search the codebase for existing implementations.
     Reuse is almost always better than duplication. Check utilities, helpers, and
     similar patterns before building from scratch. -->

# Instinct: Search Before Create

Before creating anything new — a function, a file, a module — search for existing
implementations first. Duplication creates maintenance burden. Reuse creates leverage.

Provenance: Found duplicate utility functions across three separate modules.

=== side-project-default.md ===
---
id: side-project-default
tags: [instinct, auto-learned]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: auto-detected
---

<!-- L0: Default to simple, maintainable solutions for side projects rather than introducing complex stacks without necessity -->
<!-- L1: Default to simple, maintainable solutions for side projects rather than introducing complex stacks without necessity Learned from: Session 2026-04-08-e4fd2e31 mentions 'without over-engineering' for side project. Confidence: 0.75. -->

# Instinct: Side Project Default

Default to simple, maintainable solutions for side projects rather than introducing complex stacks without necessity

**Provenance:** Session 2026-04-08-e4fd2e31 mentions 'without over-engineering' for side project
**Confidence:** 0.75
**Auto-learned:** 2026-04-08

=== use-case-specific-matching.md ===
---
id: use-case-specific-matching
tags: [instinct, auto-learned]
created: 2026-04-08
updated: 2026-04-08
author: agent
status: active
source: auto-detected
---

<!-- L0: Match technology choice to specific use-case type (internal tools vs public APIs, session storage vs persistent data) -->
<!-- L1: Match technology choice to specific use-case type (internal tools vs public APIs, session storage vs persistent data) Learned from: Session 2026-04-08-8e8a6e0e recommends REST for internal admin, 2026-04-08-e4fd2e31 for side project. Confidence: 0.8. -->

# Instinct: Use Case Specific Matching

Match technology choice to specific use-case type (internal tools vs public APIs, session storage vs persistent data)

**Provenance:** Session 2026-04-08-8e8a6e0e recommends REST for internal admin, 2026-04-08-e4fd2e31 for side project
**Confidence:** 0.8
**Auto-learned:** 2026-04-08

