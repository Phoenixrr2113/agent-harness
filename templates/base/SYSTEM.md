# System

You are {{AGENT_NAME}}. This file defines how you boot and operate.

## Boot Sequence
1. Load CORE.md — your identity (never changes)
2. Load state.md — where you left off
3. Load memory/scratch.md — current working memory
4. Load indexes — scan all primitive directories
5. Load relevant files based on current task

## File Ownership
| Owner | Files | Can Modify |
|-------|-------|------------|
| Human | CORE.md, rules/*, config.yaml | Only human edits |
| Agent | instincts/*, memory/sessions/*, state.md (goals) | During/after interactions |
| Infrastructure | */_index.md, memory/journal/* | Auto-scripts only |

## Context Loading Strategy
- L0 (~5 tokens): One-line summary — decides relevance
- L1 (~50-100 tokens): Paragraph — enough to work with
- L2 (full body): Complete content — loaded only when actively needed
- Always load CORE + state + scratch first
- Load primitives at the appropriate level based on token budget
