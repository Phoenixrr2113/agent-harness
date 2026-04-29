---
name: delegate-to-cli
description: |
  Delegates bounded subtasks (text-in/text-out, large-token, no harness MCPs needed)
  to a local CLI agent (claude/codex/gemini) via scripts/delegate.sh. Use when the
  task is large enough to warrant a subprocess but doesn't need the harness's own
  primitives. Returns the subagent's final text plus structured error info.
metadata:
  harness-tags: skill,delegation,cli
  harness-status: active
  harness-author: human
  harness-related: ask-claude,ask-codex,ask-gemini,research
---
# delegate-to-cli

## When to use

Reach for this skill when **all four** are true:

1. **Bounded** — clear start, clear end, output is text or a verifiable file change
2. **Text-in/text-out** — no need for tool-call structure back to the parent
3. **Large in tokens** — would burn the parent's context if done inline
4. **Doesn't need this harness's own primitives or MCP servers**

## Available scripts

- `scripts/delegate.sh <cli> <mode> <prompt>` — Run a bounded subtask via a local CLI agent and return its result. CLI: `claude` | `codex` | `gemini`. Mode: `read` | `edit`.
- `scripts/verify-cli.sh <cli>` — Check the CLI binary is on PATH and meets the minimum version. Run once if delegate fails with `CLI_NOT_FOUND` or `CLI_VERSION_TOO_OLD`.

## Workflow

1. Verify the CLI is available (first use): `scripts/verify-cli.sh claude`
2. Delegate: `scripts/delegate.sh claude read "Summarize the README"`
3. Read the JSON result. On `status: ok`, the subagent's output is in `result.output`.
4. On `status: error`, follow `next_steps`. Common cases listed in `references/failure-modes.md`.

## Gotchas

- **Permission mode is the #1 source of silent hangs.** `scripts/delegate.sh` requires `<mode>` to be `read` (analysis-only) or `edit` (file modification). The script maps these to the correct CLI permission flags. If you bypass the script and call the CLI directly without the right flag for an edit task, the subprocess hangs forever — see `references/permission-flags.md`.
- **CLI invocation may fall outside the CLI's subscription TOS.** The user opted in during `harness init` if delegation is enabled.
- **Do not fall back silently on CLI_NOT_FOUND.** Tell the user what is missing so they can install it.

## Failure modes

If `scripts/delegate.sh` returns `status: error`, read `error.code`:

- `CLI_NOT_FOUND` — binary missing; tell the user to install it.
- `CLI_VERSION_TOO_OLD` — see `references/failure-modes.md` for minimum versions and upgrade paths.
- `INVALID_INPUT` — bad `<cli>` or `<mode>` argument; re-invoke with correct values.
- `PERMISSION_FLAG_MISSING` — subprocess hung; re-invoke with `edit` mode instead of `read`.
- `RATE_LIMITED` — provider returned 429; back off and retry after a delay.
- `SUBPROCESS_TIMEOUT` — run exceeded the wall-clock limit; increase or split the task.
- `SUBPROCESS_FAILED` — non-zero exit not matching the above; check `error.evidence` for raw output.

For detailed recovery hints on each code, load `references/failure-modes.md`.
