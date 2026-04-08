[harness] Booted "learning-delta-bench" | 21 files loaded | ~1486 tokens used | 14898 remaining
[harness] WARN: Primitives loaded at L1 (paragraph summary) due to budget constraints

## Recommendation Summary

For a B2B SaaS with 200 orgs, **session cookies with Redis session storage** is the safer choice. JWT adds unnecessary complexity for this scale unless you have specific needs.

## Why Session Cookies First

| Factor | Session Cookies | JWT |
|--------|-----------------|-----|
| Revocation | Easy (invalidate in Redis) | Hard (need short TTL + blacklist) |
| Multi-tenancy | Built-in per-session isolation | Requires org scope in payload |
| Security | Centralized control, easier to rotate | Must manage token rotation |
| Overhead | Redis + session store | Stateless (but more token handling) |

## Critical Questions

Before finalizing architecture, I need to confirm:

1. **Compliance**: Any requirements (SOC2, HIPAA, PCI)? JWT can complicate audit trails.
2. **Current stack**: Do you already have Redis? Self-hosted or managed?
3. **Budget**: Self-host Redis (~$200/mo) vs managed (~$500-2k/mo)?
4. **Team capacity**: Can ops handle session store management?

**Next step**: If Redis is already in place, configure session cookies with per-tenant headers (`x-org-id`, `x-suborg`). I can draft the migration plan if you approve.

[2327 tokens | session: 2026-04-08-f2dc9a30]
[harness] Shutdown "learning-delta-bench"
