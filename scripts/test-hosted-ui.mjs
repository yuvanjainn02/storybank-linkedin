/** Render-level accessibility regressions. Requires the existing hosted dependencies,
 * not a browser, an API key, a new test package or hosted user data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Field from '../hosted/components/StoryField.mjs';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('select label is separate from options and hint, with explicit associations', () => {
  const markup = renderToStaticMarkup(h(Field, { label: 'How many previews?', hint: 'Choose three to five.' }, h('select', { id: 'preview-count' }, h('option', { value: 3 }, '3 previews'))));
  assert.match(markup, /<label for="preview-count">How many previews\?<\/label>/);
  assert.match(markup, /<select id="preview-count" aria-describedby="preview-count-hint">/);
  assert.match(markup, /<small id="preview-count-hint">Choose three to five\.<\/small>/);
  assert.doesNotMatch(markup, /<label[^>]*>[^]*<select[^]*<\/label>/);
});

test('field descriptions preserve validation errors as well as the hint', () => {
  const markup = renderToStaticMarkup(h(Field, { label: 'Plan time', hint: 'Your browser time zone.' }, h('input', { id: 'plan-time', 'aria-invalid': true, 'aria-describedby': 'plan-time-error' })));
  assert.match(markup, /aria-describedby="plan-time-error plan-time-hint"/);
  assert.match(markup, /aria-invalid="true"/);
});

test('generated IDs are unique, linked to labels and do not invent an empty hint', () => {
  const markup = renderToStaticMarkup(h('form', null, h(Field, { label: 'Topic' }, h('input')), h(Field, { label: 'Facts' }, h('textarea'))));
  const ids = [...markup.matchAll(/<label for="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(markup.includes(`id="${id}"`));
  assert.doesNotMatch(markup, /aria-describedby|<small/);
});

test('core form help, placeholders and unsaved status text meet 4.5:1 contrast against their backgrounds', () => {
  const luminance = hex => {
    const values = hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  for (const [text, background] of [['65705b', 'fffef9'], ['65705b', 'f8f8f1'], ['637354', 'fffef9'], ['68745d', 'fffef9'], ['68745d', 'fffefb']]) {
    assert.ok((luminance(background) + .05) / (luminance(text) + .05) >= 4.5, `${text} on ${background}`);
  }
  const css = readFileSync(new URL('../hosted/app/studio.css', import.meta.url), 'utf8');
  for (const color of ['#65705b', '#637354', '#68745d']) assert.ok(css.includes(color));
});

test('server validation errors are focusable, announced and preserve the dismiss action', () => {
  const source = readFileSync(new URL('../hosted/components/FocusedError.tsx', import.meta.url), 'utf8');
  const ts = require('typescript');
  const filename = new URL('../hosted/components/FocusedError.tsx', import.meta.url).pathname;
  const { Module } = require('node:module');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(new URL('../hosted/components', import.meta.url).pathname); module._compile(compiled, filename);
  const markup = renderToStaticMarkup(h(module.exports.default, { message: 'Invalid creator URL.' }, h('button', { 'aria-label': 'Dismiss error' }, 'Dismiss')));
  assert.match(markup, /tabindex="-1" role="alert" class="sb-error"/);
  assert.match(markup, /Invalid creator URL/); assert.match(markup, /aria-label="Dismiss error"/);
  const studio = readFileSync(new URL('../hosted/app/Studio.tsx', import.meta.url), 'utf8');
  assert.equal((studio.match(/<FocusedError key=\{errorAttempt\} message=\{error\}/g) ?? []).length, 2, 'page and modal server errors use the focus notice');
  assert.ok(studio.includes('if (message) setErrorAttempt(value => value + 1)'), 'identical failed attempts remount and focus the error notice');
});

test('server validation focus runs after rendering rather than before the error exists', () => {
  const source = readFileSync(new URL('../hosted/components/FocusedError.tsx', import.meta.url), 'utf8');
  const ts = require('typescript'); const { Module } = require('node:module');
  const filename = new URL('../hosted/components/FocusedError.tsx', import.meta.url).pathname;
  let focused = 0; let effect; let dependencies;
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(new URL('../hosted/components', import.meta.url).pathname);
  const baseRequire = module.require.bind(module);
  module.require = id => id === 'react' ? { ...require('react'), useRef: () => ({ current: { focus() { focused++; } } }), useEffect: (callback, deps) => { effect = callback; dependencies = deps; } } : baseRequire(id);
  module._compile(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  module.exports.default({ message: 'Invalid creator URL.' }); assert.equal(focused, 0); assert.deepEqual(dependencies, ['Invalid creator URL.']); effect(); assert.equal(focused, 1);
  module.exports.default({ message: 'Invalid creator URL.' }); effect(); assert.equal(focused, 2, 'a newly mounted repeated server error is focused again');
});

test('tester entry clearly separates ChatGPT workspace sign-in from LinkedIn connection', () => {
  const source = readFileSync(new URL('../hosted/components/TesterWelcome.tsx', import.meta.url), 'utf8');
  const ts = require('typescript'); const { Module } = require('node:module');
  const filename = new URL('../hosted/components/TesterWelcome.tsx', import.meta.url).pathname;
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(new URL('../hosted/components', import.meta.url).pathname);
  module._compile(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  const markup = renderToStaticMarkup(h(module.exports.default, { signInPath: '/signin-with-chatgpt?return_to=%2F' }));
  assert.match(markup, /href="\/signin-with-chatgpt\?return_to=%2F"/);
  assert.match(markup, /Sign in to StoryBank with ChatGPT/);
  assert.match(markup, /This hosted app uses ChatGPT sign-in first to open your StoryBank workspace/);
  assert.match(markup, /LinkedIn account is a separate step/);
  assert.match(markup, /does not grant posting access/);
  assert.doesNotMatch(markup, /<input|<form|type="password"/);
});
