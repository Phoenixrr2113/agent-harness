import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export function setup() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, '..');
  const distPath = join(root, 'dist', 'cli', 'index.js');

  const result = spawnSync('npm', ['run', 'build'], {
    encoding: 'utf-8',
    cwd: root,
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(`Build failed in vitest globalSetup:\n${result.stderr}`);
  }

  if (!existsSync(distPath)) {
    throw new Error(`Build succeeded but ${distPath} does not exist`);
  }
}
