---
name: ask-claude
description: >-
  Delegate bounded subtasks to the user's local `claude` CLI via bash. Runs on
  their Claude subscription instead of this harness's API budget.
metadata:
  harness-tags: 'tool,delegation,cli,claude'
  harness-status: draft
  harness-author: human
  harness-related: 'research,ask-codex,ask-gemini'
  harness-script-source: auto-generated-from-tools
---
# Tool: ask-claude

Delegate a bounded subtask to the user's locally-installed Anthropic `claude` CLI. The subagent
runs on the user's Claude subscription (not this harness's API key), does its own tool use
internally, and returns a final text answer. You consume the text — same interface as any other
delegation.

> ⚠ **Terms-of-service warning.** Invoking the `claude` CLI programmatically from this harness
> may fall outside the Acceptable Use terms of your Anthropic subscription (automated/derivative
> use, rate-limit considerations, etc). The user is responsible for confirming their subscription
> permits this kind of use before activating this tool. See
> [anthropic.com/legal](https://www.anthropic.com/legal) for the current consumer/commercial terms.

## Requires

The **shell MCP** (`@wonderwhy-er/desktop-commander`, exposed via the `shell` alias) must be
configured and connected. The harness auto-installs it when this tool is activated during
`harness init`. To invoke a CLI, you call the shell MCP's `start_process` tool with the bash
command as its argument.

## When to reach for this

- **Heavy reading work** — reviewing >20 files, summarizing a long PR diff, scanning a codebase for a pattern. Cheap on the user's subscription, expensive if done through this harness's context.
- **Bounded research** — "what does this library do", "explain this error", "find the bug in this function". One-shot questions with a clear answer.
- **Parallel investigation** — fork multiple shell calls to research independent questions at once.
- **Large-context synthesis** — the `claude` CLI can read files itself; you don't have to stuff them into your own context first.

## When NOT to reach for this

- **Multi-turn iterative work** — each invocation is a fresh session unless you pass `--resume <id>`. Multi-turn state is fragile.
- **Tasks that need this harness's MCP servers** — the CLI doesn't see MCPs configured in this harness's `config.yaml` unless you pass `--mcp-config`.
- **Tasks that need your own tool-call routing** — the CLI absorbs all tool calls internally. You only see the final text.
- **Anything that must use a specific model via API** — the CLI uses whatever model the user's subscription gives it, with limited override.

## Activation

1. Confirm the CLI is installed:
   ```bash
   which claude && claude --version
   ```
2. Confirm it's authenticated (first run will prompt if not):
   ```bash
   claude -p "say hi" --output-format text
   ```
3. Flip this file's frontmatter from `status: draft` to `status: active`.

## How to invoke

### Permission mode — pick the right one for the task

Claude Code's `-p` mode gates every tool call (Read, Edit, Write, Bash) through its permission
system. In a non-TTY subprocess there's no UI to approve them, so you must pick a policy up front:

| Mode flag | What the subagent can do | Use when |
|---|---|---|
| *(omit)* | **Read-only behavior** — analysis, summarization, answering questions. Edit/Write calls will be blocked. | Research, summarization, code review — you only want text back. |
| `--permission-mode bypassPermissions` | **Full access** — Read, Edit, Write, Bash all allowed without prompting. | In-place file edits, codebase transformations, anything that modifies disk. **Required for file-editing delegation.** |
| `--permission-mode acceptEdits` | Edits auto-approved, Bash still prompts. | Rarely useful here — auto-approving edits without Bash usually isn't worth the interactive failure risk. |

If you skip the flag and ask for an edit, the subprocess will appear to hang (waiting for an
approval that never comes). Match the flag to the task.

### Command patterns

**Read-only (simplest):**
```bash
claude -p "Review ~/repo/src/auth.ts for security issues. Return findings as a bullet list." --output-format text < /dev/null
```

**In-place edit (file modifications allowed):**
```bash
claude -p "Edit ~/repo/src/auth.ts to fix the bug. Save the result back to the same path." --output-format text --permission-mode bypassPermissions < /dev/null
```

**JSON output (for parsing):**
```bash
claude -p "<prompt>" --output-format json
```
Returns `{ result, session_id, total_cost_usd, ... }`. Parse `result` for the answer.

**Model override:**
```bash
claude -p "<prompt>" --model claude-sonnet-4-6
```

**Continuing a prior session:**
```bash
claude -p "<follow-up>" --resume <session_id>
```

**Passing this harness's MCP config:**
```bash
claude -p "<prompt>" --mcp-config ./config.yaml
```
Only if the MCPs are in a format `claude` understands — check with `claude mcp list` after.

## Usage pattern

Call the shell MCP's `start_process` tool with the full command. Append `< /dev/null` to skip the
3-second stdin-wait warning. Pick the permission flag based on whether the task needs file writes.

**Read-only delegation:**
```
start_process({
  command: "claude -p \"Read all TypeScript files under src/runtime/ and summarize the module boundaries. Return as a short bullet list.\" --output-format text < /dev/null",
  timeout_ms: 300000
})
```

**In-place edit delegation:**
```
start_process({
  command: "claude -p \"Edit src/runtime/foo.ts to fix the bug. Save the result.\" --output-format text --permission-mode bypassPermissions < /dev/null",
  timeout_ms: 300000
})
```

**First-time check** — before the first real call, verify you have the working version:

```
start_process({ command: "claude --version", timeout_ms: 5000 })
```

If the output reports a version older than 2.1, see the gotchas section below for the fix.

Then `read_process_output` (and possibly `force_terminate` on timeout) until the subprocess exits.
Treat the captured stdout as if it came from a subagent you spawned — because that's what it is.

## Gotchas

- **Multiple Claude Code installs on PATH** — if the user has both an older Homebrew install (`/opt/homebrew/bin/claude`) and a newer native install (`~/.local/bin/claude`), the shell MCP's non-interactive zsh may pick the older one because it doesn't source `~/.zshrc`. Versions before **2.1.x** have a broken `-p` mode that errors with `TypeError: null is not an object (evaluating 'R.effortLevel')` and produces no usable stdout. **Before invoking, run `claude --version` via the shell MCP and confirm it reports 2.1 or newer.** If it's older, either upgrade via the official installer (which puts the newer binary in `~/.local/bin/claude`) or pass the absolute path to the newer binary explicitly: `/Users/$USER/.local/bin/claude -p "..."`.
- **Stdin warning** — non-TTY `claude -p` waits 3 seconds for stdin before proceeding, printing a warning line. Append `< /dev/null` to skip the wait silently.
- **No stdin piping across turns** — each call is a fresh subprocess. For multi-turn, use `--resume`.
- **Rate limits apply** — the user's subscription has per-minute and daily caps. Heavy delegation can hit them. Back off on `429`-like errors.
- **Output can be large** — if the CLI returns tens of thousands of tokens, summarize or truncate before putting it in your own context.
- **Non-TTY mode required** — always use `-p` (print mode). Interactive mode will hang inside a bash subprocess.
- **Timeouts** — long delegations (>5 min) may exceed your bash tool's default timeout. Set an explicit timeout on the Bash call.
- **Auth lives in the user's keychain** — not in env vars. You cannot programmatically re-authenticate; the user must run `claude` interactively once to set it up.

## Notes

- This tool exists to save the user money and stretch their context window. Default to it for any
  delegation that doesn't specifically need this harness's primitives or MCP servers.
- The `--output-format json` form is the right choice when you need the session_id for follow-ups
  or want to log cost/token usage. Otherwise `text` is cleaner.
- If the CLI is not installed, this tool is inert. Do not fall back to another tool silently —
  tell the user what's missing.

Related: [research], [ask-codex], [ask-gemini]

## Available scripts

- `scripts/call.sh` — Auto-generated from this tool's Operations section. Review before relying on it.
