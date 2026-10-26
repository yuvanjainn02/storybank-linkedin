/** Component event/SSR checks, not live browser QA. No network or account data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = fileURLToPath(new URL('../hosted/app/Studio.tsx', import.meta.url));
const compiled = ts.transpileModule(`${readFileSync(filename, 'utf8')}\nexport { DraftEditor, CalendarPanel };`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.props?.children) : ['string', 'number'].includes(typeof node) ? String(node) : '';
function harness(component = 'DraftEditor') {
  const values = [], calls = []; let cursor = 0;
  const react = { ...React, useEffect() {}, useRef: initial => ({ current: initial }), useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; } };
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/app', import.meta.url)));
  const base = module.require.bind(module); module.require = id => id === 'react' ? react : id.endsWith('.css') || ['../components/Onboarding', '../components/PlanForm', '../components/FocusedError', '../components/ManualWritingBrief'].includes(id) ? (() => null) : base(id);
  module._compile(compiled, filename);
  const story = { id: 'fictional-draft', title: 'Fictional agenda', text: 'I changed the agenda.', source: '', revision: 2, activeApprovalId: 'fictional-approval', reviewFeedback: 'Earlier feedback', updatedAt: '2026-10-25T12:00:00Z', mediaIds: [] };
  const options = { story, stories: [story], jobs: [{ id: 'fictional-plan', storyId: story.id, dueAt: '2000-01-01T12:00:00Z', status: 'planned', reason: null }], notes: [], calibrations: [], busy: false, command: async (...args) => { calls.push(args); }, onPlan() {}, onDelete() {}, onDirty() {}, onDraft() {}, onStudio() {} };
  const render = () => { cursor = 0; return module.exports[component](options); };
  const find = predicate => { const node = nodes(render()).find(predicate); assert.ok(node, 'Expected workflow control'); return node; };
  return { calls, options, render, find, html: () => renderToStaticMarkup(render()), feedback(value) { const field = find(n => n.props?.label === 'What should change before approval?'); nodes(field).find(n => n.type === 'textarea').props.onChange({ target: { value } }); }, reject() { return find(n => typeof n.type === 'function' && textOf(n) === 'Reject & save feedback'); } };
}
test('reject requires feedback and sends exact-revision mutation, not deletion/posting/profile changes', () => {
  const ui = harness(); assert.equal(ui.reject().props.disabled, true);
  ui.feedback('  Keep the opening plain.  '); assert.equal(ui.reject().props.disabled, false); ui.reject().props.onClick();
  assert.deepEqual(ui.calls[0].slice(0, 2), ['updateStory', ['fictional-draft', { reviewFeedback: 'Keep the opening plain.' }, { expectedRevision: 2 }]]);
  assert.match(ui.html(), /Last saved review feedback/); assert.match(ui.html(), /Earlier feedback/);
  ui.calls[0][3](); assert.equal(ui.reject().props.disabled, true);
});
test('unsaved edits and busy state block rejection without losing typed feedback', () => {
  const ui = harness(); ui.feedback('Keep the opening plain.');
  ui.find(n => n.type === 'textarea' && n.props.id === 'draft-text').props.onChange({ target: { value: 'Unsaved revision.' } });
  assert.equal(ui.reject().props.disabled, true); assert.match(ui.html(), /Keep the opening plain/); assert.equal(ui.calls.length, 0);
  const busy = harness(); busy.feedback('A change'); busy.options.busy = true; assert.equal(busy.reject().props.disabled, true);
});
test('manual overdue queue never asserts an external publication outcome', () => {
  const ui = harness('CalendarPanel'); const html = ui.html();
  assert.match(html, /Time passed · share manually/); assert.match(html, /does not automatically publish or send reminders/);
  assert.doesNotMatch(html, /Time passed · not posted|Published successfully/);
});

test('pending feedback guards draft mutation and planning actions until saved or explicitly cleared', () => {
  const ui = harness(); ui.feedback('Keep this feedback.');
  for (const label of ['Save changes', 'Add to content plan', 'Reapprove / move plan', 'Remove approval']) {
    const button = ui.find(n => typeof n.type === 'function' && textOf(n) === label);
    assert.equal(button.props.disabled, true, label);
  }
  assert.equal(ui.find(n => n.type === 'fieldset').props.disabled, true);
  ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(ui.calls.length, 0);
  ui.find(n => typeof n.type === 'function' && textOf(n) === 'Clear unsaved feedback').props.onClick();
  assert.equal(ui.find(n => typeof n.type === 'function' && textOf(n) === 'Remove approval').props.disabled, false);
});
