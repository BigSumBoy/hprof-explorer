import { loadHprof } from './hprof.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/stats.mjs <dump.hprof>');
  process.exit(1);
}
const started = Date.now();
const idx = loadHprof(file);
const summary = idx.summary();
console.log(JSON.stringify({ ...summary, wallMs: Date.now() - started }, null, 2));
