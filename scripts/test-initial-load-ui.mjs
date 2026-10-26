/** Actual component async/effect regressions with controlled synthetic fetches.
 * No browser, account, provider, or network operation is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const tick = () => new Promise(resolve => setImmediate(resolve));
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.props?.children) : ['string', 'number'].includes(typeof node) ? String(node) : '';
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const workspace = key => ({ user: { displayName: `Fictional ${key}`, workspaceKey: key }, workspace: { data: { stories: [], writingProfileVersions: [], calibrations: [], writingRevisionProposals: [], jobs: [] } } });
const status = key => ({ serverTime: '2026-10-23T14:00:00Z', readiness: { configured: false, oauthEnabled: false, publishingEnabled: false, schedulerVerified: false, missing: [], scheduling: 'Disabled' }, connection: { displayName: `Fictional ${key}`, personUrn: `urn:li:person:${key}`, status: 'connected', expiresAt: '2026-11-23T14:00:00Z' }, jobs: [] });
function harness(t, name) {
  const filename = fileURLToPath(new URL(name === 'Studio' ? '../hosted/app/Studio.tsx' : '../hosted/components/LinkedInPublishing.tsx', import.meta.url));
  const source = readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const slots = [], calls = [], changes = []; let cursor = 0, effects = [], tree;
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; changes.push(i); }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback }; return slots[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; }); },
  };
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(new URL('../hosted/app', import.meta.url).pathname);
  const base = module.require.bind(module);
  module.require = id => id === 'react' ? hooks : id.endsWith('.css') || ['../components/Onboarding', '../components/PlanForm', '../components/FocusedError', '../components/ManualWritingBrief'].includes(id) ? {} : base(id);
  module._compile(compiled, filename);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => { calls.push({ url, options, resolve, reject }); });
  const props = { workspaceKey: 'personal_A', expectedWorkspaceKey: 'personal_A' };
  const render = () => { cursor = 0; effects = []; tree = module.exports.default(props); effects.forEach(effect => effect()); return tree; };
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); };
  t.after(() => { unmount(); globalThis.fetch = previousFetch; });
  return { props, calls, changes, render, unmount, api: module.exports.testApi,
    find(predicate) { const result = nodes(tree).find(predicate); assert.ok(result, 'Expected component control'); return result; },
    respond(index, data, code = 200) { assert.ok(calls[index], `Fetch ${index} exists`); calls[index].resolve(new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } })); },
  };
}
for (const name of ['Studio', 'LinkedIn']) test(`${name} cancelled initial mount does not start a fetch`, async t => {
  const ui = harness(t, name); ui.render(); assert.equal(ui.calls.length, 0);
  ui.unmount(); await tick(); assert.equal(ui.calls.length, 0); assert.equal(ui.changes.length, 0);
});
test('Studio initial loading is asynchronous and loads only the requested workspace', async t => {
  const ui = harness(t, 'Studio'); ui.render(); assert.equal(ui.calls.length, 0); await tick();
  assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, '/api/workspace');
  ui.respond(0, workspace('personal_A')); await tick(); const rendered = ui.render();
  assert.match(textOf(rendered), /Fictional personal_A/);
});
test('Studio ignores an unmounted response without adopting its owner', async t => {
  const ui = harness(t, 'Studio'); ui.render(); await tick(); ui.unmount(); ui.respond(0, workspace('personal_OLD')); await tick();
  assert.equal(ui.changes.length, 0); assert.equal(ui.calls.length, 1);
});
test('Studio rejects a different owner instead of loading private data into the old page', async t => {
  const ui = harness(t, 'Studio'); ui.render(); await tick(); ui.respond(0, workspace('personal_B')); await tick();
  const text = textOf(ui.render()); assert.doesNotMatch(text, /Fictional personal_B/); assert.match(text, /Reopen StoryBank/);
  assert.equal(ui.calls.filter(call => call.options?.method === 'POST').length, 0);
});
test('Studio clears private content and blocks old callbacks after a confirmed session loss', async t => {
  const ui = harness(t, 'Studio'); const own = workspace('personal_A');
  own.workspace.data.stories = [{ id: 'private-A', title: 'Private A note', text: 'Private A text', source: '', updatedAt: '2026-10-24', createdAt: '2026-10-24', mediaIds: [] }];
  ui.render(); await tick(); ui.respond(0, own); await tick(); ui.render();
  const bank = ui.find(node => typeof node.type === 'function' && node.type.name === 'StoryBank');
  const command = bank.props.command; const pending = command('createStory', [{ text: 'Original A text' }]);
  assert.equal(new Headers(ui.calls[1].options.headers).get('X-StoryBank-Workspace'), 'personal_A');
  ui.respond(1, { error: 'UNAUTHENTICATED', message: 'Sign in again.' }, 401); await pending;
  const text = textOf(ui.render()); assert.doesNotMatch(text, /Fictional personal_A/); assert.match(text, /Reopen StoryBank/);
  await command('createStory', [{ text: 'Must not leave old form' }]); assert.equal(ui.calls.length, 2);
});
test('LinkedIn unmount discards both pending initial responses without state changes', async t => {
  const ui = harness(t, 'LinkedIn'); ui.render(); await tick(); assert.equal(ui.calls.length, 2); ui.unmount();
  ui.respond(0, status('personal_A')); ui.respond(1, workspace('personal_A')); await tick(); assert.equal(ui.changes.length, 0);
});
test('LinkedIn older workspace completion cannot replace a newer mounted workspace response', async t => {
  const ui = harness(t, 'LinkedIn'); ui.render(); await tick();
  ui.props.workspaceKey = 'personal_B'; ui.render(); await tick(); assert.equal(ui.calls.length, 4);
  ui.respond(2, status('personal_B')); ui.respond(3, workspace('personal_B')); await tick();
  assert.match(textOf(ui.render()), /Fictional personal_B/);
  ui.respond(0, status('personal_A')); ui.respond(1, workspace('personal_A')); await tick();
  assert.match(textOf(ui.render()), /Fictional personal_B/); assert.doesNotMatch(textOf(ui.render()), /Fictional personal_A/);
  assert.equal(ui.calls.filter(call => call.options?.method === 'POST').length, 0);
});
test('publishing home remains an intentional full-document anchor with a narrow explained lint exception', () => {
  const source = readFileSync(new URL('../hosted/components/LinkedInPublishing.tsx', import.meta.url), 'utf8');
  assert.match(source, /full document navigation refreshes the hosted sign-in boundary/);
  assert.match(source, /eslint-disable-next-line @next\/next\/no-html-link-for-pages/);
  assert.match(source, /<a href="\/" className="sb-pub-back">/);
  assert.doesNotMatch(source, /from ['"]next\/link['"]/);
});

test('LinkedIn scheduling requires a verified owner, explicit time review and final confirmation', async t => {
  const ui = harness(t, 'LinkedIn');
  const ready = { ...status('personal_A'), readiness: { ...status('personal_A').readiness, configured: true, publishingEnabled: true, schedulerVerified: true } };
  const draft = { id: 'synthetic-story', title: 'Synthetic draft', text: 'Never sent to LinkedIn.', revision: 1, destinationId: ready.connection.personUrn, activeApprovalId: null };
  const loaded = workspace('personal_A'); loaded.workspace.data.stories = [draft];
  ui.render(); await tick(); ui.respond(0, ready); ui.respond(1, loaded); await tick(); ui.render();
  ui.find(node => node.props?.id === 'publish-draft').props.onChange({ target: { value: draft.id } }); ui.render();
  ui.find(node => node.props?.id === 'publish-mode').props.onChange({ target: { value: 'scheduled' } }); ui.render();
  ui.find(node => node.props?.id === 'publish-time').props.onChange({ target: { value: '2026-10-24T10:00' } }); ui.render();
  ui.find(node => node.type === 'button' && textOf(node) === 'Review exact LinkedIn version').props.onClick();
  assert.equal(ui.calls[2].url, '/api/linkedin/status'); ui.respond(2, ready); await tick();
  assert.equal(ui.calls[3].url, '/api/command'); ui.respond(3, { result: {} }); await tick();
  const publication = JSON.parse(ui.calls[4].options.body); assert.equal(publication.mode, 'scheduled'); assert.ok(publication.dueAt.includes('2026-10-24T10:00:00'));
  const snapshot = { text: draft.text, author: ready.connection.personUrn, displayName: ready.connection.displayName, visibility: 'PUBLIC', sourceRevision: 1, mode: 'scheduled', dueAt: new Date(publication.dueAt).toISOString(), timeZone: publication.timeZone };
  ui.respond(4, { snapshot, hash: 'a'.repeat(64) }); await tick(); ui.respond(5, ready); ui.respond(6, loaded); await tick();
  const reviewed = textOf(ui.render()); assert.match(reviewed, /You authorize this exact version to be sent automatically/); assert.match(reviewed, /UTC instant/); assert.match(reviewed, /15 minutes late means cancellation/);
  assert.equal(ui.calls.filter(call => call.url === '/api/linkedin/publish').length, 0);
  const submit = ui.find(node => node.type === 'button' && textOf(node) === 'Schedule exactly this version').props.onClick;
  submit(); submit(); assert.equal(ui.calls.filter(call => call.url === '/api/linkedin/publish').length, 1);
  const sent = JSON.parse(ui.calls[7].options.body); assert.deepEqual(sent.publication, publication); assert.equal(sent.confirmation, 'PUBLISH_EXACT_VERSION');
  ui.respond(7, { job: { status: 'queued' } }); await tick(); ui.respond(8, ready); ui.respond(9, loaded); await tick();
  assert.match(textOf(ui.render()), /queued for the reviewed time/);
  assert.doesNotMatch(textOf(ui.render()), /Schedule exactly this version/);
  assert.equal(ui.calls.filter(call => call.url === '/api/linkedin/runner').length, 0);
});

test('LinkedIn scheduler controls are absent when readiness is unverified', async t => {
  const ui = harness(t, 'LinkedIn'); ui.render(); await tick(); ui.respond(0, status('personal_A')); ui.respond(1, workspace('personal_A')); await tick();
  const tree = ui.render(); assert.ok(!nodes(tree).some(node => node.props?.id === 'publish-mode' || node.props?.id === 'publish-time'));
});

for (const scenario of ['invalid-time', 'disabled-runner', 'existing-queue']) test(`LinkedIn ${scenario} cannot mutate approval or cancel an existing queued post`, async t => {
  const ui = harness(t, 'LinkedIn');
  const ready = { ...status('personal_A'), readiness: { ...status('personal_A').readiness, configured: true, publishingEnabled: true, schedulerVerified: true }, jobs: [{ id: 'synthetic-queued', story_id: 'synthetic-story', status: 'queued', snapshot: { text: 'Existing queued version.', displayName: 'Synthetic' }, created_at: 0 }] };
  const loaded = workspace('personal_A'); loaded.workspace.data.stories = [{ id: 'synthetic-story', title: 'Synthetic', text: 'Existing queued version.', revision: 1, destinationId: ready.connection.personUrn, activeApprovalId: 'synthetic-approval' }];
  ui.render(); await tick(); ui.respond(0, ready); ui.respond(1, loaded); await tick(); ui.render();
  ui.find(node => node.props?.id === 'publish-draft').props.onChange({ target: { value: 'synthetic-story' } }); ui.render();
  ui.find(node => node.props?.id === 'publish-mode').props.onChange({ target: { value: 'scheduled' } }); ui.render();
  if (scenario !== 'invalid-time') { ui.find(node => node.props?.id === 'publish-time').props.onChange({ target: { value: '2026-10-24T10:00' } }); ui.render(); }
  ui.find(node => node.type === 'button' && textOf(node) === 'Review exact LinkedIn version').props.onClick();
  ui.respond(2, scenario === 'disabled-runner' ? { ...ready, readiness: { ...ready.readiness, schedulerVerified: false } } : ready); await tick();
  const text = textOf(ui.render());
  assert.match(text, scenario === 'invalid-time' ? /Choose a date and time/ : scenario === 'disabled-runner' ? /not verified for this workspace/ : /already has a queued or sending publication/);
  assert.equal(ui.calls.filter(call => call.options?.method === 'POST').length, 0);
});

test('publishing page remounts private review and form state when the signed-in owner changes', () => {
  const source = readFileSync(new URL('../hosted/app/publishing/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const workspaceKey = personalWorkspaceId\(user.userId\)/);
  assert.match(source, /<LinkedInPublishing key=\{workspaceKey\} workspaceKey=\{workspaceKey\}/);
});

test('a queued publication outside limited history still blocks replacement review', async t => {
  const ui = harness(t, 'LinkedIn');
  const ready = { ...status('personal_A'), readiness: { ...status('personal_A').readiness, publishingEnabled: true, schedulerVerified: true }, jobs: [], activeStoryIds: ['synthetic-old-story'] };
  const loaded = workspace('personal_A'); loaded.workspace.data.stories = [{ id: 'synthetic-old-story', title: 'Synthetic old draft', text: 'Previously scheduled.', revision: 1, destinationId: ready.connection.personUrn }];
  ui.render(); await tick(); ui.respond(0, ready); ui.respond(1, loaded); await tick(); ui.render();
  ui.find(node => node.props?.id === 'publish-draft').props.onChange({ target: { value: 'synthetic-old-story' } }); ui.render();
  ui.find(node => node.type === 'button' && textOf(node) === 'Review exact LinkedIn version').props.onClick(); ui.respond(2, ready); await tick();
  assert.match(textOf(ui.render()), /already has a queued or sending publication/); assert.equal(ui.calls.filter(call => call.options?.method === 'POST').length, 0);
});

test('Home binds Studio lifecycle and requester to the verified owner', () => {
  const source = readFileSync(new URL('../hosted/app/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /<Studio key=\{workspaceKey\} expectedWorkspaceKey=\{workspaceKey\}/);
});

test('all private audio players explicitly release playback buffers on unmount', () => {
  const source = readFileSync(new URL('../hosted/app/Studio.tsx', import.meta.url), 'utf8');
  assert.match(source, /audio.pause\(\); audio.removeAttribute\('src'\); audio.load\(\)/);
  assert.equal((source.match(/<audio /g) ?? []).length, 1, 'Only the cleanup-owning wrapper creates native players');
});
