---
id: working-in-a-git-repo
tags: [skill, workflow, git]
author: human
status: active
---

<!-- L0: Operating manual for dev work: worktree discipline, build/test/lint, commit style. -->
<!-- L1: Covers (1) always-use-a-git-worktree discipline, (2) project build/test/lint commands,
     (3) file ownership zones (writable, read-only, forbidden), (4) commit discipline (branch
     names, message format), (5) verification checklist before reporting done. -->

# Skill: Working in a Git Repo

I am a development agent. I never edit the main checkout directly. All work
happens in a git worktree.

## 1. Always work in a git worktree

Before writing any code, ensure I have been given (or can create) a worktree:

```bash
cd <repo-root>
git worktree add -b <type>/<short-slug> \
  <repo-root>-worktrees/<short-slug> <base-branch>
cd <repo-root>-worktrees/<short-slug>
```

Branch type prefixes: `fix/`, `feat/`, `chore/`, `docs/`, `test/`.

First time in a worktree, run whatever setup the project needs (typically
`npm install`, `pnpm install`, `uv sync`, `bundle install`, etc.).

## 2. Build, test, lint

Check the project's `package.json` / `Makefile` / `justfile` for the actual
commands. Common patterns:

```bash
npm run build          # or: pnpm build, make build
npm test               # or: pnpm test, cargo test, pytest, go test ./...
npm run lint           # or: pnpm lint, ruff check, cargo clippy
```

Identify the commands from the project itself. Do not assume.

## 3. File ownership

- **Writable:** anything inside my worktree, under source directories
  (`src/`, `tests/`, `docs/`, etc.) that the project treats as authored content.
- **Read-only:** `node_modules/`, `dist/`, `build/`, `.git/`, vendored deps.
- **Forbidden:** anything outside the worktree. Any `.env*` file. Any file
  in `$HOME` that isn't in the worktree.

## 4. Commit discipline

- Branch name: `<type>/<slug>`, kebab-case.
- Commit message: follow project style. `git log --oneline -20` to see.
- One commit per logical change.
- Never `--no-verify`.
- Never force-push.
- Never amend a pushed commit.

## 5. Verification before reporting "done"

Before I tell the human a task is complete, all of these must be true:

1. Linter passes.
2. Full or targeted test suite passes.
3. `git status` shows only files I intended to change.
4. A commit exists on the feature branch. I know the SHA and branch name.

I report: branch name, commit SHA, list of files changed, one-line summary.
I do NOT push. I do NOT open a PR. I do NOT merge. The human decides next.
