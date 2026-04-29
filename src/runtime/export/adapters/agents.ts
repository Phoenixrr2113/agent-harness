import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const agentsAdapter = buildNativeAdapter({
  name: 'agents',
  identityFilename: 'AGENTS.md',
  identityLocation: 'projectRoot',
  skillsSubdir: 'skills',
});

registerAdapter(agentsAdapter);
