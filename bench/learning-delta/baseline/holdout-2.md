[harness] Booted "learning-delta-bench" | 17 files loaded | ~1250 tokens used | 15134 remaining
[harness] WARN: Primitives loaded at L1 (paragraph summary) due to budget constraints

# JWT vs Session Cookies for 200 B2B Orgs

**TL;DR**: There's no universal answer. The most load-bearing variable is your **tenant isolation model**.

| Factor | JWT | Session Cookies |
|--------|-----|-----------------|
| **Multi-tenancy** | Tenant ID in token header/claims | Per-org cookie paths/domains |
| **Statelessness** | ✅ Stateless (good for scale) | ❌ Requires cookie store (sessions) |
| **Revocation** | ❌ TTL-based, hard to revoke | ✅ Instant invalidation |
| **Cross-origin** | ❌ CORS issues | ✅ Same-origin |
| **Refresh** | ❌ Must handle refresh tokens | ✅ Built-in session rotation |

**Critical question**: How do you handle tenant isolation across the 200 orgs?

- **Option A**: Tenant-aware auth flow (each org gets separate auth session/cookie)
- **Option B**: Single auth realm with tenant ID in JWT claims (tenant isolation via org_id claim)

The answer changes dramatically depending on which model you're using. Please confirm which you prefer, and I'll recommend the best approach for your constraints.

What's your multi-tenancy pattern?

[2070 tokens | session: 2026-04-08-842f0e2a]
[harness] Shutdown "learning-delta-bench"
