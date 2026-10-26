import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertTesterManifests, assertTesterPublicAssets, assertTesterBuildOutput } from './tester-build-guards.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hosted = path.join(root, 'hosted');
if (!existsSync(path.join(hosted, 'node_modules/vinext'))) throw new Error('Install hosted dependencies first: cd hosted && npm run install:ci');
const source = JSON.parse(readFileSync(path.join(root, '.openai/hosting.json')));
const nested = JSON.parse(readFileSync(path.join(hosted, '.openai/hosting.json')));
const identity = assertTesterManifests(source, nested);
assertTesterPublicAssets(path.join(hosted, 'public'));
if (!identity.registered) console.info('Unassigned tester build: local QA only; no hosted project has been selected.');
const result = spawnSync(process.execPath, ['scripts/run-framework.mjs', 'build'], { cwd: hosted, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
// Do not carry prototype or stale root assets into the deployment archive.
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const directory of ['server', 'client', '.openai']) {
  const target = path.join(root, 'dist', directory);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(hosted, 'dist', directory), target, { recursive: true });
}
cpSync(path.join(hosted, 'drizzle'), path.join(root, 'drizzle'), { recursive: true });

assertTesterBuildOutput(path.join(root, 'dist'));
