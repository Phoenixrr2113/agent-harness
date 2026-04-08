# v0.1.0 Smoke Test Results

> **Tag status (task 12.13): ✅ SHIPPED.** Published as
> `@randywilson/agent-harness@0.1.0` to npm on 2026-04-08 via GitHub
> Actions release workflow (run `24135947274`). Provenance signed via
> sigstore (transparency log `logIndex=1253805158`). Tag `v0.1.0` points
> at commit `896157d` on `Phoenixrr2113/agent-harness`.
>
> **Ship sequence — three attempts, three lessons learned:**
>
> 1. First tag `fe6ff07` → tests/versioning.test.ts failed on CI because
>    fresh CI runners have no global git `user.email` / `user.name`.
>    Fixed by injecting a synthetic identity into the `gitExec` helper
>    (commit `84c08f6`).
>
> 2. Second tag `84c08f6` → `npm publish` returned `ENEEDAUTH`. Root
>    cause: `NPM_TOKEN` had been added as a GitHub **Variable** instead
>    of a **Secret**. Moved to Secrets and re-ran the workflow.
>
> 3. Third attempt → `npm publish` returned `E422` from sigstore
>    provenance verification: `package.json` had no `repository.url`,
>    so npm couldn't verify the provenance statement's GitHub source
>    claim. Fixed by adding `repository`, `homepage`, `bugs` fields
>    (commit `896157d`). Re-tagged, re-pushed, green.
>
> **Live package:** https://www.npmjs.com/package/@randywilson/agent-harness
> **Release URL:** see `gh release view v0.1.0 --repo Phoenixrr2113/agent-harness`

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
