# Failure modes — delegate-to-cli

Error-code catalog for `scripts/delegate.sh`. Load this when `delegate.sh` returns
`status: error` and `error.code` needs more context than the `next_steps` array in the JSON.

---

## CLI_NOT_FOUND

**Description:** The requested CLI binary (`claude`, `codex`, or `gemini`) is not on PATH.

**Detection:** `command -v <cli>` returns non-zero before the subprocess is even spawned.

**Recovery:**

1. Install the missing CLI:
   - claude: `npm install -g @anthropic-ai/claude-code`
   - codex: `npm install -g @openai/codex`
   - gemini: `npm install -g @google/gemini-cli`
2. Confirm the npm global bin directory is on PATH: `npm bin -g` or `which <cli>`.
3. If the user doesn't want to install the CLI, delegate to a different one:
   `scripts/delegate.sh codex <mode> "<prompt>"`.
4. **Do not silently fall back.** Tell the user which CLI is missing.

---

## CLI_VERSION_TOO_OLD

**Description:** The CLI is installed but the detected version is below the minimum required.

**Minimum versions (hard floor):**

| CLI | Min version | Why |
|---|---|---|
| claude | 2.1 | Earlier builds have a broken `-p` / `--print` mode that exits with "Execution error" immediately |
| claude | 2.3 | Versions before 2.3 don't recognise `--permission-mode bypassPermissions`; edit tasks hang |
| codex | 1.0 | Earlier builds lack `-q` / `--quiet`; TUI output breaks downstream JSON parsing |
| gemini | 1.0 | Earlier builds have no non-interactive `-p` mode |

**Recovery:**

1. Upgrade: `npm install -g <cli>` (or `npm install -g @anthropic-ai/claude-code` for claude).
2. Verify upgrade: `scripts/verify-cli.sh <cli>`.
3. If the user cannot upgrade, fall back to a different CLI.

---

## INVALID_INPUT

**Description:** A required argument is missing or has an invalid value.

**Common causes:**
- `<cli>` is not one of `claude`, `codex`, `gemini`.
- `<mode>` is not one of `read`, `edit`.
- `<prompt>` is empty.

**Recovery:**

1. Re-read the SKILL.md `## Available scripts` section for the correct argument order.
2. Run `scripts/delegate.sh --help` for the full usage summary.

---

## PERMISSION_FLAG_MISSING

**Description:** The subprocess produced no output and exited very quickly (< 5 s). This is the
signature of a subprocess that opened an interactive approval prompt and got no response, then
timed out or errored.

**Root cause:** You called `scripts/delegate.sh <cli> read "..."` for a task that performs file
writes. The script passed no permission flag (read mode), the CLI hit a write operation, and
waited for approval that never came.

**Recovery:**

1. Re-invoke with `edit` mode:
   ```bash
   scripts/delegate.sh claude edit "<original prompt>"
   ```
2. Confirm the prompt actually describes a write task. If it's purely analytical, the subprocess
   may have crashed for a different reason — check `error.evidence`.
3. See `references/permission-flags.md` for the exact flag each mode maps to.

---

## RATE_LIMITED

**Description:** The CLI subscription returned a 429 (Too Many Requests) or equivalent rate-limit
error. Detected by scanning subprocess stdout+stderr for `429`, `rate limit`, or `too many requests`.

**Recovery:**

1. Wait 60 seconds before retrying.
2. If parallel delegations are running, serialize them: run one at a time until the rate window
   resets.
3. Heavy usage (many large tasks in a short window) may exhaust daily caps on Pro subscriptions.
   Split large prompts into smaller bounded tasks across a longer window.

---

## SUBPROCESS_TIMEOUT

**Description:** The subprocess did not finish within the configured wall-clock limit
(`--timeout-ms`, default 300 000 ms = 5 minutes).

**Common causes:**
- The task is too large for a single delegation: the CLI is doing useful work but is slow.
- Wrong permission mode: the CLI is waiting for an approval (see `PERMISSION_FLAG_MISSING`).
- The CLI encountered a network stall (API call to provider timed out internally).

**Recovery:**

1. Increase the timeout:
   ```bash
   scripts/delegate.sh --timeout-ms 600000 claude read "<prompt>"
   ```
2. Split the task: break one large prompt into 2–3 smaller bounded subtasks, each with a
   plausible 5-minute budget.
3. If zero output was produced in 5 minutes, suspect a permission mode issue — try
   `edit` mode instead.

---

## SUBPROCESS_FAILED

**Description:** The subprocess exited with a non-zero code that does not match any of the
specialised codes above.

**What to check:**

- `error.evidence` — contains the raw combined stdout+stderr from the subprocess. This is the
  most reliable diagnostic.
- Common patterns in evidence:
  - `"Error: Not found"` or `"404"` — likely an API configuration issue (wrong base URL, missing
    API key). Check the CLI's environment setup.
  - `"ENOENT"` — the CLI tried to read or write a file that doesn't exist. The prompt may
    reference a wrong path.
  - `"context_length_exceeded"` or `"max tokens"` — the prompt plus the files the CLI tried to
    read exceeded the model's context window. Reduce scope.
  - `"authentication"` or `"Unauthorized"` — the CLI's API key is missing or expired.

**Recovery:**

1. Read `error.evidence` carefully before retrying.
2. Run `scripts/verify-cli.sh <cli>` to confirm the CLI is healthy.
3. If the error is an API key issue, tell the user to re-authenticate: `claude auth` / `codex auth`.
4. If the prompt is too large, split it.

---

## Silent stall (not a code — a pattern)

If `delegate.sh` itself hangs (the calling process blocks with no JSON returned), the most likely
cause is that `delegate.sh` was called from a shell that didn't have the CLI on PATH. The binary
check at the top of the script would have caught this and returned `CLI_NOT_FOUND`, but if the
PATH in the subprocess differs from the calling environment, the `command -v` check can produce a
false positive.

**Recovery:**

1. Confirm `echo $PATH` in the subprocess matches the PATH where `<cli>` is installed.
2. Use absolute paths: `which claude` → `/usr/local/bin/claude`, then pass that to the CLI check.
