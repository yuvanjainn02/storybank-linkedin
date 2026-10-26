import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertTesterManifests, assertTesterPublicAssets, assertTesterBuildOutput } from '../scripts/tester-build-guards.mjs';
const empty = () => ({ d1: 'DB', r2: 'BUCKET' });
test('source manifests are unassigned local placeholders without a deployment identity', () => {
  const manifests = ['../.openai/hosting.json', '../hosted/.openai/hosting.json'].map(file => JSON.parse(readFileSync(new URL(file, import.meta.url))));
  assert.deepEqual(manifests, [empty(), empty()]);
  assert.deepEqual(assertTesterManifests(...manifests), { registered: false, projectId: null });
});
test('tester manifest guard rejects inconsistent identities and lost storage bindings', () => {
  for (const pair of [[{ ...empty(), project_id: 'synthetic-test-project' }, empty()], [empty(), { ...empty(), project_id: 'synthetic-test-project' }], [{ ...empty(), project_id: '' }, empty()], [{ ...empty(), static: { directory: 'public' } }, empty()], [{ ...empty(), r2: null }, empty()], [null, empty()]]) assert.throws(() => assertTesterManifests(...pair));
  assert.equal(assertTesterManifests({ ...empty(), project_id: 'synthetic-test-project' }, { ...empty(), project_id: 'synthetic-test-project' }).registered, true);
});
test('tester public source excludes the browser-global legacy prototype', () => {
  assertTesterPublicAssets(new URL('../hosted/public', import.meta.url).pathname);
  assert.doesNotMatch(readFileSync(new URL('../hosted/app/Studio.tsx', import.meta.url), 'utf8'), /href="\/legacy/);
});
test('asset guard rejects legacy, runtime stores and escaping links rather than publishing them', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'storybank-public-guard-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['legacy', '.wrangler', '.sites-runtime', '.env', 'fixture.sqlite', 'fixture.db', 'key.pem']) {
    const candidate = path.join(root, name); writeFileSync(candidate, 'synthetic'); assert.throws(() => assertTesterPublicAssets(root)); rmSync(candidate);
  }
  mkdirSync(path.join(root, 'safe')); writeFileSync(path.join(root, 'safe', 'favicon.svg'), '<svg/>'); assert.doesNotThrow(() => assertTesterPublicAssets(root));
  symlinkSync(path.join(root, 'safe'), path.join(root, 'escape')); assert.throws(() => assertTesterPublicAssets(root));
});


test('tester deployment output never includes retained prototype root files', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'storybank-output-guard-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['server', 'client', '.openai']) mkdirSync(path.join(root, name));
  assert.doesNotThrow(() => assertTesterBuildOutput(root));
  writeFileSync(path.join(root, 'index.html'), 'synthetic prototype');
  assert.throws(() => assertTesterBuildOutput(root));
});

test('public manual trial warns against real submissions and does not claim active providers', () => {
  const layout = readFileSync(new URL('../hosted/app/layout.tsx', import.meta.url), 'utf8');
  for (const copy of ['Public manual writing trial.', 'Use synthetic test content only.', 'your own ChatGPT conversation', 'No automatic AI', 'is active.']) assert.ok(layout.includes(copy));
  assert.match(layout, /<aside role="note" aria-label="Public manual writing trial"/);
});


test('both ignore rules exclude dependency symlinks as well as directories from source', t => {
  for (const scope of ['root', 'hosted']) {
    const root = mkdtempSync(path.join(tmpdir(), 'storybank-ignore-guard-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    mkdirSync(path.join(root, 'hosted'));
    const original = new URL(scope === 'root' ? '../.gitignore' : '../hosted/.gitignore', import.meta.url);
    writeFileSync(path.join(root, scope === 'root' ? '.gitignore' : 'hosted/.gitignore'), readFileSync(original));
    const dependency = path.join(root, 'hosted/node_modules');
    symlinkSync('/fictional-unused-dependency-cache', dependency);
    assert.equal(spawnSync('git', ['check-ignore', '--quiet', 'hosted/node_modules'], { cwd: root }).status, 0, `${scope} rule ignores a symlink`);
    rmSync(dependency); mkdirSync(dependency);
    assert.equal(spawnSync('git', ['check-ignore', '--quiet', 'hosted/node_modules'], { cwd: root }).status, 0, `${scope} rule still ignores a directory`);
  }
});
