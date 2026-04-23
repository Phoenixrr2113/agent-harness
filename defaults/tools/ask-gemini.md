---
id: ask-gemini
tags: [tool, delegation, cli, gemini, google]
created: {{DATE}}
updated: {{DATE}}
author: human
status: draft
related:
  - research
  - ask-claude
  - ask-codex
---

<!-- L0: Delegate bounded subtasks to the user's local `gemini` CLI. Runs on their Gemini subscription instead of this harness's API budget. -->
<!-- L1: When a task is text-in-text-out, shell out to `gemini -p "..."` (non-interactive mode) and
     capture stdout. The subagent runs its own tool loop internally and returns a final report.
     Especially useful when the task benefits from Gemini's long context window. -->

# Tool: ask-gemini

Delegate a bounded subtask to the user's locally-installed Google `gemini` CLI. The subagent runs
on the user's Gemini subscription (not this harness's API key), does its own tool use internally,
and returns a final text answer.

> ⚠ **Terms-of-service warning.** Invoking the `gemini` CLI programmatically from this harness
> may fall outside the Acceptable Use terms of your Google/Gemini subscription (automated/derivative
> use, rate-limit considerations, etc). The user is responsible for confirming their subscription
> permits this kind of use before activating this tool. See
> [policies.google.com/terms](https://policies.google.com/terms) for the current terms.

## Requires

The **shell MCP** (`@wonderwhy-er/desktop-commander`, exposed via the `shell` alias) must be
configured and connected. The harness auto-installs it when this tool is activated during
`harness init`. To invoke `gemini`, you call the shell MCP's `start_process` tool with the bash
command as its argument.

## When to reach for this

- **Large-context synthesis** — Gemini models have very long context windows. Useful for
  summarizing huge documents or entire codebases in one shot.
- **Bounded research** — one-shot questions with a clear answer.
- **Parallel delegation** — fork multiple shell calls for independent research threads.
- **Alternative model perspective** — second opinion from a Google model without reconfiguring
  this harness's primary provider.

## When NOT to reach for this

- **Multi-turn iterative work** — each non-interactive call is a fresh session.
- **Tasks that need this harness's MCP servers** — the CLI doesn't see them.
- **Tasks that must return structured tool calls** — the CLI absorbs tools internally; you only see final text.

## Activation

1. Confirm the CLI is installed:
   ```bash
   which gemini && gemini --version
   ```
2. Confirm auth:
   ```bash
   gemini -p "say hi"
   ```
   First run will prompt for authentication.
3. Flip this file's frontmatter from `status: draft` to `status: active`.

## How to invoke

**Non-interactive prompt mode:**
```bash
gemini -p "Summarize the architecture of this repo based on the README and package.json."
```

**Specifying a model:**
```bash
gemini -m gemini-3.1-pro -p "<prompt>"
```

**Including files in the prompt context:**
```bash
gemini -p "Review the attached file for bugs." --include-directories ~/repo/src/runtime
```

Check `gemini --help` for the flags available in the installed version — names and defaults vary
by release.

## Usage pattern

Call the shell MCP's `start_process` tool with the full command:

```
start_process({
  command: "gemini -p \"Read all files under ~/repo/docs/ and produce a one-line summary of each. Return as a markdown list.\"",
  timeout_ms: 300000
})
```

Then `read_process_output` (and possibly `force_terminate` on timeout) until the subprocess exits.
Treat the captured stdout as if it came from a subagent you spawned.

## Gotchas

- **Free-tier rate limits are tight** — expect failures under load on the free plan. Paid plans
  are more generous but still capped.
- **Output can be very large** — Gemini's long context cuts both ways. Tell the CLI explicitly to
  return a short summary if you don't want a wall of text.
- **Non-TTY mode required** — use `-p` / prompt mode. Interactive mode will hang inside a bash subprocess.
- **Auth flow** — typically OAuth via browser on first run. Cannot be re-authenticated purely
  programmatically. The user must sign in once.
- **Model availability** — flag names and model IDs shift across CLI versions. Prefer checking
  `gemini --help` over relying on memory.

## Notes

- Reach for this when the task specifically needs long-context capability (summarizing a huge
  document, understanding an entire large codebase) or when the user prefers a Google model.
- If `gemini` isn't installed, don't fall back silently — tell the user what's missing.

Related: [research], [ask-claude], [ask-codex]
