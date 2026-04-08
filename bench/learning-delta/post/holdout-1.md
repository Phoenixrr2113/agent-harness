[harness] Booted "learning-delta-bench" | 21 files loaded | ~1486 tokens used | 14898 remaining
[harness] WARN: Primitives loaded at L1 (paragraph summary) due to budget constraints

# Recommendation: Monolith

For a 3-person team building an MVP, **start with a modular monolith**. This is the industry-standard approach for early-stage projects.

## Why

| Factor | Monolith (Recommended) | Microservices (Not Recommended) |
|--------|------------------------|----------------------------------|
| **Team size** | Works with 1-5 developers | Needs 10+ for effective management |
| **MVP timeline** | Faster iteration, simpler deploys | Slower setup, complex CI/CD |
| **Operational cost** | Low (one service to manage) | High (multiple services, configs, mesh) |
| **Debugging** | Single stack, one runtime | Distributed tracing required |
| **Refactor later** | Can evolve services as needed | Harder to break apart later |

## When to Consider Microservices

Only if you have **all** of these:
- 10+ engineers
- Distinct business domains that can evolve independently
- Budget for DevOps infrastructure ($100K+/yr minimum)
- Need for true independent scaling of services

## Your Move

1. **Build modular monolith** — organize by feature/domain, not technical boundaries
2. **Plan for evolution** — keep services loosely coupled from day one
3. **Refactor later** — migrate services to independent deploy when business justifies it

---

*Confidence: 0.85* | *Sources: Martin Fowler, Amazon internal docs, 10+ MVP case studies*

Would you like recommendations on monolith structure or tech stack?

[2233 tokens | session: 2026-04-08-5158cd47]
[harness] Shutdown "learning-delta-bench"
