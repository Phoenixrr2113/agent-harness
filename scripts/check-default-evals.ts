import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseTriggersFile } from '../src/runtime/evals/triggers-schema.js';
import { parseEvalsFile } from '../src/runtime/evals/evals-schema.js';

const root = 'defaults/skills';
const skills = readdirSync(root).filter((n) => !n.startsWith('.'));
let failed = 0;

for (const name of skills) {
  const triggersPath = join(root, name, 'evals', 'triggers.json');
  const evalsPath = join(root, name, 'evals', 'evals.json');

  if (existsSync(triggersPath)) {
    try {
      const queries = parseTriggersFile(triggersPath);
      console.log(`✓ ${name}: triggers.json (${queries.length} queries)`);
    } catch (err) {
      console.error(`✗ ${name}: triggers.json — ${(err as Error).message}`);
      failed++;
    }
  } else {
    console.warn(`! ${name}: no triggers.json`);
  }

  if (existsSync(evalsPath)) {
    try {
      const file = parseEvalsFile(evalsPath);
      console.log(`✓ ${name}: evals.json (${file.evals.length} cases)`);
    } catch (err) {
      console.error(`✗ ${name}: evals.json — ${(err as Error).message}`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} schema failure(s).`);
  process.exit(1);
}
console.log(`\nAll default eval files valid.`);
