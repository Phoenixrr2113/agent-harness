import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentState } from '../core/types.js';
import { withFileLockSync } from './file-lock.js';

const DEFAULT_STATE: AgentState = {
  mode: 'idle',
  goals: [],
  active_workflows: [],
  last_interaction: new Date().toISOString(),
  unfinished_business: [],
};

export function loadState(harnessDir: string): AgentState {
  const statePath = join(harnessDir, 'state.md');

  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  const content = readFileSync(statePath, 'utf-8');
  return parseStateMd(content);
}

export function saveState(harnessDir: string, state: AgentState): void {
  const statePath = join(harnessDir, 'state.md');
  const content = renderStateMd(state);
  withFileLockSync(harnessDir, statePath, () => {
    writeFileSync(statePath, content, 'utf-8');
  });
}

function parseStateMd(content: string): AgentState {
  const state = { ...DEFAULT_STATE };

  const modeMatch = content.match(/## Mode\s*\n(.+)/);
  if (modeMatch) state.mode = modeMatch[1].trim();

  const goalsMatch = content.match(/## Goals\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (goalsMatch) {
    state.goals = goalsMatch[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.replace(/^- /, '').trim());
  }

  const workflowsMatch = content.match(/## Active Workflows\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (workflowsMatch) {
    state.active_workflows = workflowsMatch[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.replace(/^- /, '').trim());
  }

  const lastMatch = content.match(/## Last Interaction\s*\n(.+)/);
  if (lastMatch) state.last_interaction = lastMatch[1].trim();

  const unfinishedMatch = content.match(/## Unfinished Business\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (unfinishedMatch) {
    state.unfinished_business = unfinishedMatch[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.replace(/^- /, '').trim());
  }

  return state;
}

function renderStateMd(state: AgentState): string {
  const lines: string[] = [
    '# Agent State',
    '',
    '## Mode',
    state.mode,
    '',
    '## Goals',
    ...state.goals.map(g => `- ${g}`),
    '',
    '## Active Workflows',
    ...state.active_workflows.map(w => `- ${w}`),
    '',
    '## Last Interaction',
    state.last_interaction,
    '',
    '## Unfinished Business',
    ...state.unfinished_business.map(u => `- ${u}`),
    '',
  ];

  return lines.join('\n');
}
