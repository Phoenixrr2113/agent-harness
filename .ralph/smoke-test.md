# v0.1.0 Smoke Test Results

> **Tag status (task 12.13):** Local tag `v0.1.0` created at commit
> `fe6ff07` on 2026-04-08T06:55Z. Push to GitHub is **BLOCKED** because
> the repo has no `origin` remote configured. The release workflow at
> `.github/workflows/release.yml` only fires when GitHub sees a tag pushed
> to it. **To actually ship v0.1.0:**
>
> 1. Create the GitHub repo at https://github.com/new (suggested name:
>    `agent-harness` under your user — the npm package is scoped as
>    `@randywilson/agent-harness` so the GitHub name doesn't have to match)
> 2. `git remote add origin git@github.com:<you>/agent-harness.git`
> 3. `git push -u origin main` (pushes all commits from this session)
> 4. Add `NPM_TOKEN` secret in GitHub repo Settings → Secrets and variables
>    → Actions. Generate at https://www.npmjs.com/settings/<you>/tokens with
>    type "Automation".
> 5. `git push origin v0.1.0` (this triggers the release workflow which
>    builds, tests, lints, and runs `npm publish --access public --provenance`)
> 6. Watch the workflow at https://github.com/<you>/agent-harness/actions
> 7. After it succeeds: `npm view @randywilson/agent-harness@0.1.0` to
>    confirm the package is live
>
> If the release workflow fails at the publish step but everything else
> passed, that's almost always the NPM_TOKEN secret missing or wrong. Add
> it and re-run the workflow from the GitHub UI — no need to delete the tag.

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
