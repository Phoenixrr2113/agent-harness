# Storage layer: SQLite vs Postgres

We need a single-writer, multi-reader store for journal entries (~10k rows/year).

**Decision:** SQLite with WAL mode, file-backed, no separate server process.

**Rationale:**
- The harness runs locally per user; no concurrency across machines.
- WAL mode handles our read-while-write pattern.
- Zero ops cost — no extra process to manage.

**Tradeoff:** if we ever sync across devices, we will need to migrate.
