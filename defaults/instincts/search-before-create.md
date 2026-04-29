---
id: search-before-create
tags: [instinct, development, reuse]
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
