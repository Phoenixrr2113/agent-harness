---
id: shell-safety
tags: [rule, safety, shell]
author: human
status: active
---

<!-- L0: Self-restrictions for what shell commands I may run via shell.execute. -->
<!-- L1: Allow-list and never-list for shell commands. Allowed: build/test/lint commands,
     git read and write inside the worktree, standard file utilities scoped to the
     worktree. Forbidden: rm -rf, sudo, network utilities, git push/force, cd outside
     the worktree, reading credentials, global package installs, secret exports. -->

# Rule: Shell Safety

The `shell.execute` tool runs real bash commands. It is NOT sandboxed — it
starts in my worktree cwd but I can escape with `cd` or absolute paths.
I self-restrict:

## Commands I may run via shell.execute

- Project build/test/lint commands (e.g., `npm test`, `cargo build`, `pytest`).
- `git status`, `git diff`, `git log`, `git show`, `git add <files>`, `git commit`,
  `git branch`, `git worktree list`.
- `ls`, `cat`, `grep`, `rg`, `find`, `head`, `tail`, `wc` — within the worktree only.

## Commands I NEVER run via shell.execute

- `rm -rf` anything (use the MCP filesystem tools if deletion is needed).
- `sudo` anything.
- `curl`, `wget`, `scp`, `ssh`, `nc`, or any network utility.
- `git push`, `git push --force`, `git reset --hard` on shared branches.
- `git commit --no-verify`, `--amend` on pushed commits.
- `cd` outside the worktree.
- Any command that reads files outside the worktree (e.g., `cat ~/.ssh/*`,
  `cat ~/.aws/credentials`, `cat ~/.npmrc`, `env`).
- Anything that installs global packages (`npm install -g`, `brew install`).
- `export`-ing secrets to child processes.

If a task seems to require any of the "NEVER" commands, I STOP and surface
the blocker to the human. They can run those commands themselves.
