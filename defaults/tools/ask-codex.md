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

### Sandbox mode — pick the right one for the task

`codex exec` gates every shell/file operation through a sandbox + approval layer. In a non-TTY
subprocess there's no UI to approve anything, so you must pick a policy up front:

| Flag | What the subagent can do | Use when |
|---|---|---|
| `-s read-only` *(default)* | Read files, analyze code. No disk writes, no shell commands. | Research, review, summarization. |
| `-s workspace-write` | Read + write within `-C <dir>`. Shell commands still prompt. | Scoped edits where you trust the working directory. |
| `--full-auto` | Alias for sandboxed automatic execution. **Still prompts for some operations** — observed to hang on non-TTY read_process_output loops in testing. | Mostly read tasks that edit small things. Verify it doesn't stall before relying on it. |
| `--dangerously-bypass-approvals-and-sandbox` | Full access, zero prompts. **Required for reliable in-place edits from a non-TTY subprocess.** | File-editing delegation where the orchestrator is trusted. |

If you pick a mode that still prompts (or `--full-auto` for broad edits), expect the
subprocess to stall silently. `--dangerously-bypass-approvals-and-sandbox` is the pragmatic choice
when the harness orchestrator is already sandboxing the work to a known scope via `-C`.

### Command patterns

**Read-only research:**
```bash
codex exec "Review src/auth.ts for security issues. Return findings as bullet points."
```

**Scoped working directory:**
```bash
codex exec -C ~/repo "Summarize the module structure of src/runtime/."
```

**In-place edits (file modifications allowed, no approval prompts):**
```bash
codex exec --dangerously-bypass-approvals-and-sandbox -C ~/repo "Edit src/auth.ts to fix the bug. Save the result back to the same path."
```

**Model override:**
```bash
codex exec --model gpt-5.5 "<prompt>"
```

Check `codex exec --help` for the flags available in the installed version — flags vary by release.

## Usage pattern

Call the shell MCP's `start_process` tool with the full command. Pick the sandbox flag based on
whether the task needs file writes.

**Read-only research:**
```
start_process({
  command: "codex exec -C ~/repo \"Read every file under src/runtime/durable-*.ts and explain the checkpoint/resume flow. Return as a short bullet list.\"",
  timeout_ms: 300000
})
```

**In-place edits:**
```
start_process({
  command: "codex exec --dangerously-bypass-approvals-and-sandbox -C ~/repo \"Edit src/runtime/foo.ts to fix the bug. Save the result.\"",
  timeout_ms: 300000
})
```

Then `read_process_output` (and possibly `force_terminate` on timeout) until the subprocess exits.
Treat the captured stdout as if it came from a subagent you spawned.

## Gotchas

- **`--full-auto` can hang on non-TTY writes** — observed in testing: a delegation with `--full-auto` to rewrite a single source file stayed alive for 20+ minutes without writing anything. If you need in-place edits from a non-TTY subprocess, use `--dangerously-bypass-approvals-and-sandbox` instead.
- **Approval prompts in default mode** — read-only is the default; write/shell operations prompt. In a non-TTY subprocess there's no UI to approve. Either pick a sandbox flag that matches the task, or the subprocess will stall silently.
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
