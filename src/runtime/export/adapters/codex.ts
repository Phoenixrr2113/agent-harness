import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const codexAdapter = buildNativeAdapter({
  name: 'codex',
  identityFilename: 'AGENTS.md',
  identityLocation: 'targetDir',
  skillsSubdir: 'skills',
});

registerAdapter(codexAdapter);
