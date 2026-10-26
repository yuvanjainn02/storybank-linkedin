import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const files = ['dev-server.mjs', 'build-standalone.mjs'];
function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(file);
  }
}
for (const directory of ['prototype', 'dist', 'server', 'tests', 'scripts', 'hosted/lib', 'hosted/components']) collect(directory);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
