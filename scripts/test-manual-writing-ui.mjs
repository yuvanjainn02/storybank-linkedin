import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const filename = fileURLToPath(new URL('../hosted/components/ManualWritingBrief.tsx', import.meta.url));
const source = readFileSync(filename, 'utf8');
const compile = hooks => {
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/components', import.meta.url)));
  const base = module.require.bind(module); module.require = id => id === 'react' ? { ...React, ...hooks } : base(id);
  module._compile(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return module.exports.default;
};
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
function harness() {
  const state = []; let cursor = 0; const Component = compile({ useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; } });
  return (override = {}) => { cursor = 0; return Component({ title: 'Synthetic draft', draft: 'Existing text', sourceFacts: 'My supplied fact.', profile: { version: 3, preferences: { voice: 'Brief and plain.', feedbackGuidance: 'Keep specific examples.', creators: [{ name: 'Fictional source', sample: 'EXPLICIT_REFERENCE_SAMPLE', rightsConfirmed: true }, { name: 'Restricted source', sample: 'DO_NOT_INCLUDE_SAMPLE', rightsConfirmed: false }, { name: 'Only a bookmark', profileUrl: 'https://example.invalid/profile' }] } }, ...override }); };
}
test('manual panel makes no service call and clearly explains local copy/paste', () => {
  const render = harness(); const tree = render();
  for (const phrase of ['manual copy-and-paste workflow', 'does not call ChatGPT or use an API', 'Nothing is sent automatically', 'paste your chosen draft into this editor']) assert.ok(text(tree).includes(phrase));
  assert.doesNotMatch(source, /fetch\(|window\.open|https:\/\/|action=/);
  const textarea = nodes(tree).find(n => n.type === 'textarea' && n.props.readOnly);
  assert.match(textarea.props.value, /My supplied fact/); assert.match(textarea.props.value, /Brief and plain/);
});
test('unchecking guidance removes it before a user copies the brief', () => {
  const render = harness(); let tree = render();
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: false } });
  tree = render(); const brief = nodes(tree).find(n => n.type === 'textarea' && n.props.readOnly).props.value;
  assert.doesNotMatch(brief, /Brief and plain|Keep specific examples/); assert.match(brief, /writingGuidanceVersion": null/);
});
test('reference text is excluded until its specific checkbox is selected', () => {
  const render = harness(); let tree = render();
  const brief = node => nodes(node).find(n => n.type === 'textarea' && n.props.readOnly).props.value;
  assert.doesNotMatch(brief(tree), /EXPLICIT_REFERENCE_SAMPLE|DO_NOT_INCLUDE_SAMPLE/);
  const checkbox = nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1];
  assert.equal(checkbox.props.checked, false); checkbox.props.onChange({ target: { checked: true } }); tree = render();
  assert.match(brief(tree), /EXPLICIT_REFERENCE_SAMPLE/); assert.doesNotMatch(brief(tree), /DO_NOT_INCLUDE_SAMPLE|https:\/\/example.invalid/);
  nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.onChange({ target: { checked: false } });
  assert.doesNotMatch(brief(render()), /EXPLICIT_REFERENCE_SAMPLE/);
});
test('replacing a reference or profile version cannot reuse its previous opt-in', () => {
  for (const changeVersion of [false, true]) {
    const render = harness(); let tree = render();
    nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } });
    const profile = { version: changeVersion ? 4 : 3, preferences: { creators: [{ name: 'Replacement', sample: 'NEW_UNSELECTED_EXCERPT', rightsConfirmed: true }] } };
    tree = render({ profile });
    assert.equal(nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.checked, false);
    assert.doesNotMatch(nodes(tree).find(n => n.type === 'textarea' && n.props.readOnly).props.value, /NEW_UNSELECTED_EXCERPT|EXPLICIT_REFERENCE_SAMPLE|Replacement/);
  }
});
test('clipboard failure leaves a selectable manual-copy fallback', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('synthetic denial'); } } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  const render = harness(); const tree = render(); nodes(tree).find(n => n.type === 'button').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); assert.match(text(render()), /Clipboard access was blocked/);
  let selected = false; nodes(tree).find(n => n.type === 'textarea' && n.props.readOnly).props.onFocus({ target: { select() { selected = true; } } }); assert.equal(selected, true);
});
test('missing browser clipboard API keeps the manual-copy workflow usable', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  const render = harness(); const tree = render();
  assert.doesNotThrow(() => nodes(tree).find(n => n.type === 'button').props.onClick());
  assert.match(text(render()), /Clipboard access is unavailable/);
});
test('a delayed copy of an older draft never claims the current brief was copied', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let finish;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => new Promise(resolve => { finish = resolve; }) } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  const render = harness(); let tree = render();
  nodes(tree).find(n => n.type === 'button').props.onClick();
  render({ draft: 'New current draft' }); finish(); await new Promise(resolve => setImmediate(resolve));
  tree = render({ draft: 'New current draft' });
  assert.match(text(tree), /brief changed after the previous copy attempt/);
  assert.doesNotMatch(text(tree), /Brief copied\./);
});
