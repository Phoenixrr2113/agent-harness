import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface SessionRecord {
  id: string;
  started: string;
  ended: string;
  prompt: string;
  summary: string;
  tokens_used: number;
  steps: number;
}

export function createSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const short = randomUUID().slice(0, 8);
  return `${date}-${short}`;
}

export function writeSession(harnessDir: string, session: SessionRecord): string {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const filePath = join(sessionsDir, `${session.id}.md`);
  const content = `---
id: ${session.id}
tags: [session]
created: ${session.started}
updated: ${session.ended}
author: agent
status: active
duration_minutes: ${Math.round((new Date(session.ended).getTime() - new Date(session.started).getTime()) / 60000)}
---

<!-- L0: Session ${session.id} — ${session.summary.slice(0, 60)} -->
<!-- L1: ${session.summary} -->

# Session: ${session.id}

**Started:** ${session.started}
**Ended:** ${session.ended}
**Tokens:** ${session.tokens_used}
**Steps:** ${session.steps}

## Prompt
${session.prompt}

## Summary
${session.summary}
`;

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
