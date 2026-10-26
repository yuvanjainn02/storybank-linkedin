/** Actual ProfilePanel render/event regressions. Synthetic data, no browser/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = fileURLToPath(new URL('../hosted/app/Studio.tsx', import.meta.url));
const compiled = ts.transpileModule(`${readFileSync(filename, 'utf8')}\nexport { ProfilePanel };`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function load(react) {
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/app', import.meta.url)));
  const base = module.require.bind(module);
  module.require = id => id === 'react' ? react : id.endsWith('.css') || ['../components/Onboarding', '../components/PlanForm', '../components/FocusedError', '../components/ManualWritingBrief'].includes(id) ? {} : base(id);
  module._compile(compiled, filename); return module.exports.ProfilePanel;
}
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.props?.children) : ['string', 'number'].includes(typeof node) ? String(node) : '';
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const profile = () => ({ version: 2, savedAt: '2026-10-23T00:00:00Z', preferences: { displayName: 'Fictional writer', audience: '', voice: 'Clear', goals: '', preferredFormats: '', avoid: '', feedbackGuidance: '', creators: [{ name: '', profileUrl: 'https://www.linkedin.com/in/fictional-reference/', notes: '' }], onboarding: { step: 1, status: 'in_progress', experience: { title: 'Saved fictional experience' } } } });
function harness(t, { confirm = false, busy = false } = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window'); const prompts = [], calls = [], values = []; let cursor = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm(message) { prompts.push(message); return confirm; } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'window', prior); else delete globalThis.window; });
  const Component = load({ ...React, useEffect() {}, useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; } });
  const current = profile(), older = { ...profile(), version: 1, preferences: { ...profile().preferences, displayName: 'Earlier fictional writer' } };
  const options = { current, profiles: [older, current], busy, command: async (...args) => { calls.push(args); }, onReset() {}, onContinue() {}, onDirty() {} };
  let tree;
  const render = () => { cursor = 0; tree = Component(options); return tree; };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected profile control'); return node; };
  render();
  return { prompts, calls, options, render, find, html: () => renderToStaticMarkup(render()), editName(value) { find(node => node.type === 'input' && node.props.placeholder === 'Your name').props.onChange({ target: { value } }); render(); }, openHistory() { find(node => typeof node.type === 'function' && textOf(node) === 'Version history (2)').props.onClick(); render(); }, restore(index = 0) { nodes(tree).filter(node => typeof node.type === 'function' && textOf(node) === 'Restore as a new version')[index].props.onClick(); render(); } };
}
test('declining restore preserves an unsaved profile and sends no save', t => {
  const ui = harness(t); ui.editName('Unsaved fictional name'); ui.openHistory(); ui.restore();
  assert.equal(ui.prompts.length, 1); assert.match(ui.prompts[0], /unsaved/i); assert.equal(ui.calls.length, 0);
  assert.equal(ui.find(node => node.type === 'input' && node.props.placeholder === 'Your name').props.value, 'Unsaved fictional name');
});
test('confirmed restore uses the selected saved version and latest compare-and-set', t => {
  const ui = harness(t, { confirm: true }); ui.editName('Unsaved fictional name'); ui.openHistory(); ui.restore(1);
  assert.equal(ui.prompts.length, 1); assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0][0], 'saveWritingProfile');
  assert.deepEqual(ui.calls[0][1], [ui.options.profiles[0].preferences, { expectedVersion: 2 }]);
});
test('unchanged profile restore does not add an unnecessary discard confirmation', t => {
  const ui = harness(t); ui.openHistory(); ui.restore(); assert.equal(ui.prompts.length, 0); assert.equal(ui.calls.length, 1);
});
test('busy restore cannot dispatch even if its click handler is invoked directly', t => {
  const ui = harness(t, { busy: true }); ui.openHistory(); ui.restore(); assert.equal(ui.prompts.length, 0); assert.equal(ui.calls.length, 0);
});
test('history exposes URL-only references and structured onboarding for review', t => {
  const ui = harness(t); ui.openHistory(); const html = ui.html();
  assert.match(html, /https:\/\/www.linkedin.com\/in\/fictional-reference\//); assert.match(html, /Saved fictional experience/);
  assert.doesNotMatch(html, /\[object Object\]/); assert.doesNotMatch(html, /<dt>Writers<\/dt><dd>None added/);
});

test('profile sample edits reset rights consent and never alter another profile version', t => {
  const ui = harness(t);
  ui.options.current.preferences.creators[0].sample = 'Original synthetic sample.';
  ui.options.current.preferences.creators[0].rightsConfirmed = true;
  // New mount with saved sample state is tested through the existing editor control.
  const field = ui.find(node => node.props?.label === 'Your writing sample (optional)');
  const input = nodes(field).find(node => node.type === 'textarea');
  input.props.onChange({ target: { value: 'A revised synthetic sample.' } });
  ui.render();
  const rights = ui.find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(rights.props.checked, false);
  assert.match(ui.html(), /Aim for 5–10/);
  assert.equal(ui.options.current.preferences.creators[0].sample, 'Original synthetic sample.');
  rights.props.onChange({ target: { checked: true } }); ui.render();
  assert.match(ui.html(), /1 rights-cleared samples in this form/);
});
