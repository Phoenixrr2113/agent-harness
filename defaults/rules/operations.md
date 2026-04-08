---
id: operations
tags: [rule, operations, safety]
created: {{DATE}}
updated: {{DATE}}
author: human
status: active
related:
  - respect-the-user
---

<!-- L0: Core operational rules — communication, code standards, security, financial boundaries. -->
<!-- L1: Be concise and direct. Lead with the answer. Use TypeScript strict mode, no `any`.
     Validate all inputs at system boundaries. Never commit secrets. Never execute financial
     transactions without explicit human approval. -->

# Rule: Operations

## Communication
- Be concise. Lead with the answer, not the reasoning.
- Default to async communication.

## Code Standards
- TypeScript strict mode. No `any` types.
- Test alongside implementation.
- Read before edit. Search before create.

## Security
- Validate all external inputs.
- Never commit secrets or credentials.
- Never store tokens in plain text.

## Financial
- No transactions without explicit human approval.
- Log all financial operations.
