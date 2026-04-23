---
id: ask-codex
tags: [tool, delegation, cli, codex, openai]
created: {{DATE}}
updated: {{DATE}}
author: human
status: draft
related:
  - research
  - ask-claude
  - ask-gemini
---

<!-- L0: Delegate bounded subtasks to the user's local `codex` CLI (OpenAI). Runs on their ChatGPT subscription instead of this harness's API budget. -->
<!-- L1: When a task is text-in-text-out, shell out to `codex exec "..."` and capture stdout.
     The subagent runs its own tool loop internally and returns a final report. You receive only
     the final text. Activate only after confirming `which codex` and that `codex exec "hi"` works. -->

# Tool: ask-codex

Delegate a bounded subtask to the user's locally-installed OpenAI `codex` CLI. The subagent runs
on the user's ChatGPT/OpenAI subscription (not this harness's API key), does its own tool use
internally, and returns a final text answer.

> ⚠ **Terms-of-service warning.** Invoking the `codex` CLI programmatically from this harness
> may fall outside the Acceptable Use terms of your ChatGPT/OpenAI subscription (automated/derivative
> use, rate-limit considerations, etc). The user is responsible for confirming their subscription
> permits this kind of use before activating this tool. See
> [openai.com/policies](https://openai.com/policies) for the current consumer/commercial terms.

## Requires

The **shell MCP** (`@wonderwhy-er/desktop-commander`, exposed via the `shell` alias) must be
configured and connected. The harness auto-installs it when this tool is activated during
`harness init`. To invoke `codex`, you call the shell MCP's `start_process` tool with the bash
command as its argument.

## When to reach for this

- **Heavy reading/refactoring work** — the codex CLI is strong at code transformations across
  many files without burning your context.
- **Bounded research** — one-shot questions about code, libraries, or errors.
- **Alternative model perspective** — useful when you want a second opinion from an OpenAI model
  without switching this harness's primary provider.
- **Parallel delegation** — fork multiple shell calls for independent questions.

## When NOT to reach for this

- **Multi-turn iterative work** — each `codex exec` invocation is a fresh session.
- **Tasks that need this harness's MCP servers** — the CLI doesn't see them.
- **Tasks that must return structured tool calls** — the CLI absorbs tools internally; you only see final text.

## Activation

1. Confirm the CLI is installed:
   ```bash
   which codex && codex --version
   ```
2. Confirm auth:
   ```bash
   codex exec "say hi"
   ```
   First run prompts interactively to sign in with ChatGPT.
3. Flip this file's frontmatter from `status: draft` to `status: active`.

## How to invoke

**Non-interactive execution:**
```bash
codex exec "Review src/auth.ts for security issues. Return findings as bullet points."
```

**Specifying a working directory:**
```bash
codex exec --cd ~/repo "Summarize the module structure of src/runtime/."
```

**Model override (if supported by the user's subscription):**
```bash
codex exec --model gpt-5.5 "<prompt>"
```

**Full-auto mode (no approval prompts, read-only by default):**
```bash
codex exec --full-auto "<prompt>"
```

Check `codex exec --help` for the flags available in the installed version — flags vary by release.

## Usage pattern

Call the shell MCP's `start_process` tool with the full command:

```
start_process({
  command: "codex exec --cd ~/repo \"Read every file under src/runtime/durable-*.ts and explain the checkpoint/resume flow. Return as a short bullet list.\"",
  timeout_ms: 300000
})
```

Then `read_process_output` (and possibly `force_terminate` on timeout) until the subprocess exits.
Treat the captured stdout as if it came from a subagent you spawned.

## Gotchas

- **Approval prompts** — default mode may ask before writing or running commands. In non-interactive contexts use `--full-auto` or set its equivalent via config. Verify this with `codex exec --help` before trusting it.
- **Rate limits** — ChatGPT Plus/Pro subscriptions have per-minute caps. Heavy delegation will hit them.
- **Output can be large** — summarize or truncate before re-ingesting.
- **Non-TTY mode required** — `codex exec` is the non-interactive form. Don't use `codex` (TUI) inside a bash subprocess.
- **Auth lives in the user's keychain** — not programmatically re-authenticatable. User must sign in once interactively.
- **Working directory matters** — the CLI's default CWD is wherever the bash call was made. Pass `--cd <path>` when delegating work about a specific project.

## Notes

- Use this when the task benefits from an OpenAI model's strengths (large-scale code edits,
  multi-file refactors) and the user has an active subscription.
- If `codex` isn't installed, don't fall back silently — tell the user what's missing and let them
  install it or use `ask-claude` / `ask-gemini` instead.

Related: [research], [ask-claude], [ask-gemini]
