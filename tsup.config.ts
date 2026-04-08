import { defineConfig } from 'tsup';

// agent-harness is a CLI, not a library. The only build target is the
// CLI binary at dist/cli/index.js. There is no library entry point and
// no published types — anyone consuming the harness uses the `harness`
// command, not `import` statements.
export default defineConfig([
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node\n' },
  },
]);
