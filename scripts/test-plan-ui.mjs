/** Native-control contract, event/hook and SSR checks. Not real browser QA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = fileURLToPath(new URL('../hosted/components/PlanForm.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function load(react = React) {
  const module = new Module(filename); module.filename = filename;
  module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/components', import.meta.url)));
  const baseRequire = module.require.bind(module); module.require = id => id === 'react' ? react : baseRequire(id);
  module._compile(compiled, filename); return module.exports.default;
}
const story = { id: 'synthetic-story', title: 'Fictional plan', activeApprovalId: 'synthetic-approval' };
const props = overrides => ({ story, busy: false, command: async () => {}, onClose() {}, ...overrides });
const nodes = node => [node, ...React.Children.toArray(node?.props?.children).flatMap(nodes)];
const future = (days = 2) => {
  const date = new Date(Date.now() + days * 86400000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T12:00`;
};
function harness(overrides = {}) {
  const values = []; let cursor = 0; let focuses = 0; const calls = []; let closed = 0;
  const react = { ...React,
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
  };
  const Component = load(react);
  const input = { value: '', focus() { focuses++; } };
  const options = props({ command: async (...args) => { calls.push(args); }, onClose() { closed++; }, ...overrides });
  const render = () => { cursor = 0; const tree = Component(options); nodes(tree).find(node => node.type === 'input').props.ref.current = input; return tree; };
  return { input, calls, options, render, get focuses() { return focuses; }, get closed() { return closed; }, submit() { const tree = render(); let prevented = false; tree.props.onSubmit({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); } };
}

test('manual plan keeps a labeled required native datetime control and a usable submit action', () => {
  const html = renderToStaticMarkup(React.createElement(load(), props()));
  assert.match(html, /<label for="plan-time">Planned date and time<\/label>/);
  assert.match(html, /id="plan-time" type="datetime-local" required=""/); assert.match(html, /name="dueAt"/);
  assert.match(html, /aria-describedby="plan-time-hint"/);
  assert.match(html, /<button type="submit" class="sb-btn">Save content plan<\/button>/);
  assert.match(html, /does not schedule a LinkedIn post or send a reminder/);
});

test('a valid native picker value submits even without a React change event', () => {
  const h = harness(); h.render(); h.input.value = future(); h.submit();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'schedulePlan');
  assert.equal(h.calls[0][1][0].dueAt, new Date(h.input.value).toISOString());
  assert.equal(h.calls[0][1][0].storyId, story.id); assert.equal(h.calls[0][1][0].approvalId, story.activeApprovalId);
  assert.equal(h.focuses, 0); assert.equal(h.closed, 0);
  h.calls[0][3](); assert.equal(h.closed, 1);
});

test('empty, invalid and past native values never save and focus the control on every failure', () => {
  const h = harness();
  for (const value of ['', 'invalid', '2026-02-30T12:00', '2000-01-01T12:00', '2000-01-01T12:00']) { h.input.value = value; h.submit(); }
  assert.equal(h.calls.length, 0); assert.equal(h.focuses, 5);
  const tree = h.render(); assert.ok(nodes(tree).some(node => node.props?.role === 'alert'));
  assert.equal(nodes(tree).find(node => node.type === 'input').props['aria-invalid'], true);
});

test('input clears custom validation and preserves the browser-owned date value', () => {
  const h = harness(); h.submit(); h.input.value = future();
  nodes(h.render()).find(node => node.type === 'input').props.onInput();
  const control = nodes(h.render()).find(node => node.type === 'input');
  assert.equal(control.props['aria-invalid'], false); assert.equal(control.props.value, undefined);
  h.submit(); assert.equal(h.calls.length, 1);
});

test('idempotency follows exact time, story and approval even when native values change without events', () => {
  const h = harness(); h.input.value = future(); h.submit(); h.submit();
  assert.equal(h.calls[0][1][0].idempotencyKey, h.calls[1][1][0].idempotencyKey);
  h.input.value = future(3); h.submit();
  assert.notEqual(h.calls[1][1][0].idempotencyKey, h.calls[2][1][0].idempotencyKey);
  h.options.story = { ...story, activeApprovalId: 'new-approval' }; h.submit();
  assert.notEqual(h.calls[2][1][0].idempotencyKey, h.calls[3][1][0].idempotencyKey);
});

test('busy form cannot save through a direct submit and still allows cancel', () => {
  const h = harness({ busy: true }); h.input.value = future(); h.submit(); assert.equal(h.calls.length, 0);
  const tree = h.render(); const controls = nodes(tree);
  assert.equal(controls.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  assert.equal(controls.find(node => node.type === 'input').props.disabled, true);
  controls.find(node => node.type === 'button' && node.props.type === 'button').props.onClick(); assert.equal(h.closed, 1);
});

test('manual plan displays exact UTC and local offset after a valid time selection, clears it on invalid input', () => {
  const h = harness(); h.input.value = future();
  nodes(h.render()).find(node => node.type === 'input').props.onInput();
  let status = nodes(h.render()).find(node => node.props?.role === 'status');
  assert.ok(status);
  assert.ok(JSON.stringify(status.props.children).includes(new Date(h.input.value).toISOString()));
  h.input.value = ''; nodes(h.render()).find(node => node.type === 'input').props.onInput();
  assert.equal(nodes(h.render()).some(node => node.props?.role === 'status'), false);
});
