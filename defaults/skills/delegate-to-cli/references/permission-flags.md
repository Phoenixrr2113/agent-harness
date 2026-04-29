# Permission flags — delegate-to-cli

Detailed flag table for each CLI in read vs edit modes. Load this when troubleshooting a permission
or hang issue, or when you need to call a CLI directly instead of via `scripts/delegate.sh`.

## Why this matters

Every CLI gates file-write operations behind interactive approval prompts. In a non-TTY subprocess
(which is how `delegate.sh` spawns them), those prompts are never answered and the process hangs
silently. The flags below suppress or bypass the approval gate for the correct work mode.

**If you omit the edit flag on a write task, the subprocess hangs forever with zero output.**
`force_terminate` and retry with the correct flag.

---

## Flag table

| CLI | Read mode (analysis/summary) | Edit mode (file modification) | Notes |
|---|---|---|---|
| **claude** | *(no flag required)* — default blocks writes | `--permission-mode bypassPermissions` | Introduced in claude 2.1. Earlier builds: use `-p` without a permission flag and accept read-only output. |
| **codex** | `-s read-only` | `--dangerously-bypass-approvals-and-sandbox` | `-s read-only` is the default in codex 1.0+; explicitly passing it is harmless and documents intent. |
| **gemini** | *(no flag required)* — non-interactive mode is read-leaning | *(verify with `gemini --help`)* — edit semantics vary by version | gemini's non-interactive mode (`gemini -p "..."`) does not currently support unsupervised file writes in the same way. If edits are needed, use claude or codex. |

---

## Full command forms

### claude

```bash
# Read mode — analysis, summary, review
claude -p "<prompt>"

# Edit mode — file modification
claude --permission-mode bypassPermissions -p "<prompt>"
```

`--permission-mode bypassPermissions` skips all tool-use confirmation dialogs. It is safe in a
subprocess that you control, but should not be used with untrusted prompts.

**Minimum version for `-p` (non-interactive print mode):** 2.1
Check: `claude --version`
Upgrade: `npm install -g @anthropic-ai/claude-code`

---

### codex

```bash
# Read mode — default, explicit for clarity
codex -q -s read-only "<prompt>"

# Edit mode — bypasses sandbox and approval gate
codex -q --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

`-q` suppresses the spinner / TUI and makes output machine-readable. Without it, codex writes
ANSI codes to stdout that break JSON parsing downstream.

**Minimum version:** 1.0
Check: `codex --version`
Upgrade: `npm install -g @openai/codex`

---

### gemini

```bash
# Non-interactive print mode
gemini -p "<prompt>"
```

gemini's non-interactive mode does not offer an edit-bypass flag at time of writing. For
write-heavy tasks, prefer claude or codex.

**Minimum version:** 1.0
Check: `gemini --version`
Upgrade: `npm install -g @google/gemini-cli`

---

## Version compatibility matrix

| CLI | Min version | Feature requiring it | Behaviour on older version |
|---|---|---|---|
| claude | 2.1 | `-p` / `--print` non-interactive mode | Prints "Execution error" and exits immediately |
| claude | 2.3 | `--permission-mode bypassPermissions` | Flag not recognised; falls back to interactive prompts (hangs) |
| codex | 1.0 | `-q` / `--quiet` | TUI writes to stdout; breaks downstream JSON parsing |
| gemini | 1.0 | `-p` print mode | Older builds have no non-interactive mode |

---

## Security note

`bypassPermissions` and `--dangerously-bypass-approvals-and-sandbox` should only be passed when
you control the prompt content. Never pass user-supplied input directly through these flags without
sanitising it — the CLIs can create, modify, and delete files in the working directory.
