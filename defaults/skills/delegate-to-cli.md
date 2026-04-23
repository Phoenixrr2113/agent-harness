---
id: delegate-to-cli
tags: [skill, delegation, cli]
created: {{DATE}}
updated: {{DATE}}
author: human
status: draft
related:
  - ask-claude
  - ask-codex
  - ask-gemini
  - research
---

<!-- L0: Delegate bounded subtasks to local CLI agents (claude/codex/gemini) via the shell MCP to save API tokens and context. Requires the matching permission-mode flag for the work type. -->
<!-- L1: Decision tree: is the task text-in-text-out and bounded? If yes, pick the CLI and the
     permission mode, launch via shell MCP's start_process, poll read_process_output until exit.
     Claude needs `--permission-mode bypassPermissions` for edits. Codex needs
     `--dangerously-bypass-approvals-and-sandbox` for reliable non-TTY edits. Without the right
     flag the subprocess silently stalls. -->

# Skill: Delegate bounded subtasks to CLI agents

Use a local CLI agent (`claude`, `codex`, `gemini`) as a subprocess subagent when the work is
bounded and text-in-text-out. The subagent runs on the user's CLI subscription, reads files
itself, does its own tool-use internally, and returns a final text answer. The harness primary
consumes that text the same way it consumes any delegation.

**Prerequisite**: the `ask-claude`, `ask-codex`, or `ask-gemini` tool primitive is activated
(`status: active`) and the shell MCP is connected. If none are active, don't delegate — just do
the work yourself or tell the user to opt in during `harness init`.

## When to delegate

Reach for CLI delegation when **all four** are true:

1. The task is **bounded** — has a clear start, clear end, and the answer is either text or a file
   change you can verify afterward.
2. The task is **text-in-text-out** — no need for structured tool-call routing back through you.
3. The task is **large in tokens** — reading many files, summarizing a long doc, or a multi-file
   refactor. (If it's a 2-line change, just do it yourself.)
4. The task **doesn't need this harness's primitives or MCP servers** — the subagent can't see
   them unless you pass `--mcp-config` explicitly.

## Which CLI for which task

- **`ask-claude`** — default for most delegation. Strong at code review, refactors, long-doc
  summarization, bounded analysis. Use this unless you have a specific reason not to.
- **`ask-codex`** — reach for this when the task benefits from an OpenAI-trained model's
  strengths, or when you want an independent second opinion that differs from Claude's approach.
- **`ask-gemini`** — reach for this when the task genuinely needs Gemini's long context window
  (summarizing a single file with tens of thousands of lines, for example), or when the user
  prefers a Google model.

If the primary CLI fails, fall back to a different CLI before giving up.

## Pick the permission mode

This is the step most delegations get wrong. Every CLI gates write operations behind approvals
that there's no UI to satisfy in a non-TTY subprocess. Pick the flag up front to match the task:

| Task shape | claude | codex | gemini |
|---|---|---|---|
| **Read-only** (analysis, summary, review) | *(no flag)* — default blocks edits | `-s read-only` *(default)* | *(no flag)* |
| **In-place edits** (modify files on disk) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | *(no flag — gemini's non-interactive mode is read-leaning; if edits are needed, verify with its `--help` first)* |

**If you omit the edit flag on an edit task, the subprocess will appear to hang.** No error, just
silence. A 20-minute `read_process_output` loop returning zero lines means the subagent is waiting
for an approval that will never come. `force_terminate` and retry with the correct flag.

## Orchestration pattern

Standard loop — same every time:

1. **Verify the CLI works** (first use only) — `start_process` with `<cli> --version` and check
   the output. For `claude`, confirm ≥ 2.1 (earlier versions have a broken `-p` mode).
2. **Launch** — `start_process` with the full command including the permission flag. Pick a
   generous `timeout_ms` (5+ minutes for large tasks).
3. **Poll** — `read_process_output` on the returned PID repeatedly until the process exits or you
   hit a reasonable max-polls ceiling.
4. **Handle failure** — if the process is still running after enough polls with zero new output,
   `force_terminate` and either retry with a different permission mode or escalate to the user.
5. **Verify** — if the subagent was asked to write files, confirm the disk changes match
   expectations before reporting success to the user. `start_process` with `git diff <path>` is a
   cheap check.

## When NOT to delegate

- **Multi-turn interactive work** — each CLI invocation is a fresh session. Passing a session-id
  across turns is fragile and fails in subtle ways.
- **Work that needs tool-call structure back to the primary** — the CLI absorbs its own tool use.
  You only see the final text.
- **Tasks smaller than the delegation overhead** — a single-line edit is cheaper to do yourself.
- **When the specific CLI you're reaching for is known-unreliable for this task shape** — e.g.
  codex with `--full-auto` on file-editing tasks has been observed to hang silently.

## Failure modes to watch for

- **Silent stall** — almost always the wrong permission mode for the task. Force-terminate and
  retry with the correct flag.
- **"Execution error" fast return from `claude -p`** — version mismatch. User has an older binary
  on PATH. Check `claude --version` and escalate if < 2.1.
- **Rate limits** — CLI subscriptions have per-minute and daily caps. Heavy parallel delegation
  hits them. Back off and serialize if you see 429-style errors.
- **Missing CLI** — don't fall back silently. Tell the user what's missing so they can install it.

Related: [ask-claude], [ask-codex], [ask-gemini], [research]
