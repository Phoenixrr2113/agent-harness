# v0.1.0 Smoke Test Results

> **Ship history:**
>
> - **v0.1.0** (2026-04-08) — Published as `@randywilson/agent-harness@0.1.0`, **YANKED ~2 hours later**. A license review sub-agent discovered 10 of the bundled default skills (from `anthropics/skills`) carried per-file proprietary LICENSE.txt files reading "© 2025 Anthropic, PBC. All rights reserved". Unpublished within the 72-hour window. See `.ralph/source-licenses.md` for the full review.
>
> - **v0.1.1** (2026-04-08) — Published as `@agntk/agent-harness@0.1.1` via run `24137271301`, commit `210126c`. License cleanup ship: all 10 proprietary files removed, 2 retained wshobson/agents files got MIT attribution + NOTICE file at repo root, package renamed from `@randywilson` to `@agntk`. **Superseded by v0.1.2** within minutes — `harness --version` was printing `0.1.0` because the version string was hardcoded in `src/cli/index.ts` and I forgot to bump it when I bumped `package.json`.
>
> - **v0.1.2** (2026-04-08) — ✅ **CURRENT.** Published as `@agntk/agent-harness@0.1.2` via run `24137570409`, commit `1547986`. Fixes the CLI version-string bug by reading `package.json.version` at runtime via `createRequire`. Future version bumps flow through automatically. All content unchanged from v0.1.1.
>
> **Live package:** https://www.npmjs.com/package/@agntk/agent-harness
>
> **Release URLs:**
> - v0.1.0 (yanked): https://github.com/Phoenixrr2113/agent-harness/releases/tag/v0.1.0
> - v0.1.2 (latest): https://github.com/Phoenixrr2113/agent-harness/releases/tag/v0.1.2
> - v0.1.1 tag exists on origin but has no GitHub release entry (transitional, superseded quickly)

Ran: 2026-04-08T06:52:00Z
By: Ralph task 12.12 (executed manually via Claude sub-agent)
Build status: passing

## Build/test/lint
- npm run build: PASS
- npm test: PASS (1071 tests across 53 files, 10.48s)
- npm run lint: PASS (tsc --noEmit clean)

## Scaffold round-trip
- harness init /tmp/v1212-smoke: PASS (exit 0)
- /tmp/v1212-smoke/README.md exists: PASS (contains "harness run" 4x)
- Init "Next steps" prints concrete `harness run` commands (NOT "edit CORE.md"): PASS
- config.yaml has 0 `/Users/` absolute paths: PASS (grep -c returned 0)

## Validator/doctor/graph/info
- validate: 0 errors, 1 warning (L1 paragraph-summary load — benign budget note)
- doctor: no "Auto-fixed" messages — clean scaffold needs no fixes
- graph: 24 nodes, 31 edges, 3 clusters, 1 orphan (example-web-search)
- info: 24 primitives loaded (>=15 required)

## CLI noise
- harness --version: 1 line, exact value `0.1.0` — PASS

## discover --remote (unauth)
- RATE-LIMIT-BLOCKED: GitHub Contents API returned 403 for all 12 source/subpath probes (unauth 60/hr quota exhausted from earlier work in the session). Per task spec this is a known transient issue and NOT a real failure. Auth fix verified previously — no 401s observed, only 403 rate limit responses.

## Distribution
- LICENSE: PASS (MIT License)
- .github/workflows/release.yml: PASS (references NPM_TOKEN)
- npm pack --dry-run: PASS (221 files, 967.7 kB packed, 4.1 MB unpacked)

## README pitch
- Subtitle "measurably better": PASS
- "Why this is different" section: PASS
- "## Tools" section: PASS
- Learning Loop position: line 41 (<=100 required): PASS

## Online check
- SKIPPED: no OPENROUTER_API_KEY in environment; `harness run` not exercised to avoid cost.

## Verdict
READY FOR v0.1.0 TAG

All offline acceptance checks pass. Only caveat is `discover --remote`
hitting the unauth GitHub rate limit (403s), which is a known transient
environmental condition, not a code defect.
