/** SSR/accessibility checks, not browser interaction or live LinkedIn tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript');
const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = fileURLToPath(new URL('../hosted/components/LinkedInPublishing.tsx', import.meta.url));
const source = readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const module = new Module(filename); module.filename = filename;
module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/components', import.meta.url)));
const baseRequire = module.require.bind(module); module.require = (id) => id.endsWith('.css') ? {} : baseRequire(id);
module._compile(compiled, filename);
const render = () => renderToStaticMarkup(h(module.exports.default, { workspaceKey: 'personal_synthetic' }));
test('publishing screen starts with disabled posting, clear scheduling limits and labeled controls', () => {
  const markup = render();
  assert.match(markup, /Your words. Your final say./);
  assert.match(markup, /<label for="publish-draft">Saved draft<\/label>/);
  assert.match(markup, /<label for="publish-audience">Audience<\/label>/);
  assert.match(markup, /<button disabled="">Review exact LinkedIn version<\/button>/);
  assert.match(markup, /Live posting is disabled/);
  assert.match(markup, /manual plan, not a scheduled LinkedIn publication/);
  assert.match(markup, /Uncertain outcomes are never automatically retried/);
  assert.doesNotMatch(markup, /type="password"|Publish exactly this version/);
});
test('publishing screen explains ChatGPT-first sign-in before connection readiness loads', () => {
  const markup = render();
  assert.match(markup, /This hosted app uses ChatGPT sign-in first to open your StoryBank workspace/);
  assert.match(markup, /Connecting LinkedIn is a separate step/);
  assert.match(markup, /official permission screen when setup is available/);
  assert.match(markup, /ChatGPT sign-in alone does not grant LinkedIn posting access/);
  assert.match(markup, /Checking connection readiness/);
  assert.match(markup, /Live posting is disabled/);
});
test('publishing UI keeps final intent explicit and polls status only, not dispatch', () => {
  assert.ok(source.includes('Publish exactly this version'));
  assert.ok(source.includes("confirmation: 'PUBLISH_EXACT_VERSION'"));
  assert.ok(source.includes('setReview(null)'));
  assert.ok(source.includes("url.origin !== 'https://www.linkedin.com'"));
  assert.match(source, /setInterval\(\(\) => \{ void refresh\(\)/);
  assert.ok(source.includes('workspace.user.workspaceKey !== workspaceKey'));
});
test('publishing error/status announcements and visible focus styling are present', () => {
  assert.ok(source.includes('role="alert"')); assert.ok(source.includes('role="status"'));
  const css = readFileSync(new URL('../hosted/app/publishing.css', import.meta.url), 'utf8');
  assert.ok(css.includes(':focus-visible')); assert.ok(css.includes('white-space:pre-wrap'));
  assert.ok(css.includes('@media(max-width:600px)'));
});

// The actual component after its read-only status request has completed.
test('loaded disabled-provider state keeps OAuth and publication controls unavailable', () => {
  const React = require('react');
  const disabled = { serverTime: '2026-10-23T14:00:00Z', readiness: { configured: false, oauthEnabled: false, publishingEnabled: false, schedulerVerified: false, missing: ['LINKEDIN_CLIENT_SECRET'], scheduling: 'Automatic scheduling is not configured.' }, connection: null, jobs: [] };
  let state = 0;
  const loaded = new Module(filename); loaded.filename = filename; loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  loaded.require = id => id === 'react' ? { ...React, useState(initial) { return [state++ === 0 ? disabled : initial, () => {}]; } } : id.endsWith('.css') ? {} : original(id);
  loaded._compile(compiled, filename);
  const markup = renderToStaticMarkup(h(loaded.exports.default, { workspaceKey: 'personal_synthetic' }));
  assert.match(markup, /This hosted app uses ChatGPT sign-in first/);
  assert.match(markup, /Connection setup is not ready/);
  assert.match(markup, /No LinkedIn account is connected/);
  assert.match(markup, /<button disabled="">Connect with LinkedIn<\/button>/);
  assert.match(markup, /<button disabled="">Review exact LinkedIn version<\/button>/);
  assert.match(markup, /Automatic scheduling is not configured/);
  assert.doesNotMatch(markup, /Checking connection readiness|Publish exactly this version|LINKEDIN_CLIENT_SECRET/);
});
