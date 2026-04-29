import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const claudeAdapter = buildNativeAdapter({
  name: 'claude',
  identityFilename: 'CLAUDE.md',
  identityLocation: 'targetDir',
  skillsSubdir: 'skills',
});

registerAdapter(claudeAdapter);
