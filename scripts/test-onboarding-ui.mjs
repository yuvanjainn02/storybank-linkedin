/** Server-render and component event/effect checks with the existing React/TypeScript
 * dependencies. The focus doubles below do not replace real browser/AT verification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshOnboarding, demoFromExperience, experienceFacts, feedbackRecord } from '../hosted/lib/onboarding-flow.mjs';
import { deriveCreatorResearchStatus } from '../server/creator-research-status.mjs';
import { validateWritingProfile, writingSkillDocument } from '../server/writing-profile.mjs';
import { applyEmphasisPreference } from '../hosted/lib/editor-format.mjs';
const require = createRequire(new URL('../hosted/package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const { createElement: h } = React;
const { renderToStaticMarkup } = require('react-dom/server');
const filename = fileURLToPath(new URL('../hosted/components/Onboarding.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const loadOnboarding = hooks => {
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(fileURLToPath(new URL('../hosted/components', import.meta.url)));
  const baseRequire = module.require.bind(module);
  module.require = id => id === 'react' && hooks ? { ...React, ...hooks } : baseRequire(id);
  module._compile(compiled, filename);
  return module.exports.default;
};
const Onboarding = loadOnboarding();
const render = step => {
  const onboarding = freshOnboarding(); onboarding.step = step; onboarding.demoText = 'Only supplied facts.'; onboarding.feedback.revisedText = onboarding.demoText;
  const preferences = { displayName: 'Fictional writer', audience: '', voice: '', goals: '', preferredFormats: '', avoid: '', feedbackGuidance: '', creators: [], onboarding };
  return renderToStaticMarkup(h(Onboarding, { profile: { version: 2, savedAt: '2026-10-23T00:00:00.000Z', preferences }, busy: false, command: async () => {}, onExit: () => {}, onVoice: () => {}, onDirty: () => {} }));
};
for (let step = 1; step <= 6; step++) test(`setup step ${step} renders its progress, labeled fields, save and back controls`, () => {
  const markup = render(step); assert.match(markup, new RegExp(`Step ${step} of 6`)); assert.match(markup, /aria-current="step"/); assert.match(markup, /Save &amp; exit to dashboard/); assert.match(markup, /Save &amp; back/); assert.doesNotMatch(markup, /type="password"/);
  for (const [, id] of markup.matchAll(/<label for="([^"]+)"/g)) assert.ok(markup.includes(`id="${id}"`));
});
test('identity and demo distinguish bookmarks, actual connection status and inactive automatic publishing', () => { assert.match(render(1), /LinkedIn: separate connection/); assert.match(render(1), /scheduled time, and time zone/); assert.match(render(4), /Outline · not AI/); assert.match(render(4), /Real AI drafting is not configured/); });
test('the story outline is not presented as a reference-analysed personalised draft', () => {
  const markup = render(4);
  assert.match(markup, /Your story outline/);
  assert.match(markup, /not a personalised, reference-analysed draft/);
  assert.match(markup, /analyse them in your own conversation before drafting/);
  assert.doesNotMatch(markup, /Your first demo|Demo draft/);
});
test('signed-in onboarding names ChatGPT workspace sign-in and separate LinkedIn permission', () => {
  const markup = render(1);
  assert.match(markup, /This hosted app uses ChatGPT sign-in first to open your StoryBank workspace/);
  assert.match(markup, /Connecting LinkedIn is a separate step/);
  assert.match(markup, /ChatGPT sign-in alone does not grant LinkedIn posting access/);
  assert.match(markup, /No LinkedIn permission or token is granted by entering this URL/);
  assert.match(markup, /Automatic scheduling is not active/);
  assert.doesNotMatch(markup, /type="password"/);
});
test('voice is a deliberate recording action, never an automatic transcription claim', () => { assert.match(render(3), /Record a voice note/); assert.match(render(3), /Automatic transcription is not connected/); });
test('style review exposes six editable sections, provenance, approved facts and Markdown export', () => { const markup = render(6); for (const text of ['Voice', 'Tone', 'Hooks', 'Structure', 'Vocabulary', 'Don’ts', 'Review feedback and its source', 'Facts you approve', 'Edit Markdown', 'Export saved version']) assert.ok(markup.includes(text), text); assert.match(markup, /type="checkbox"/); });

// Run the actual component's event handlers, state transitions and dependency-driven
// effects. Native nodes with refs get focus doubles attached before effects run.
// Keeping hook state and ref nodes across renders is essential to catch an unchanged
// error string failing to request focus on the second identical failed submission.
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.props?.children) : typeof node === 'string' ? node : '';
const visit = (node, callback) => {
  if (Array.isArray(node)) { node.forEach(child => visit(child, callback)); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  callback(node); visit(node.props.children, callback);
};
function interact(t, preferences) {
  const confirmationAnswers = [], confirmations = [];
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, confirm(message) { confirmations.push(message); assert.ok(confirmationAnswers.length, 'Unexpected confirmation in fixture'); return confirmationAnswers.shift(); } } });
  const slots = [], refs = new Map(), focusLog = [], commands = [], dirtyLog = [];
  let cursor = 0, effects = [], tree, activeElement, exits = 0;
  const Component = loadOnboarding({
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    },
  });
  const props = {
    profile: { version: 2, savedAt: '2026-10-23T00:00:00.000Z', preferences }, busy: false,
    command: async (operation, args, message, after) => {
      commands.push({ operation, args, message });
      const result = { ...props.profile, version: props.profile.version + 1, preferences: args[0] };
      props.profile = result; after?.(result);
    },
    onExit: () => { exits++; }, onVoice() {}, onDirty: dirty => dirtyLog.push(dirty),
  };
  const flush = () => {
    cursor = 0; effects = []; tree = Component(props);
    const attached = new Set();
    visit(tree, element => {
      const ref = element.props.ref;
      if (!ref || typeof ref !== 'object') return;
      attached.add(ref);
      if (!refs.has(ref)) refs.set(ref, { focus() { activeElement = this; focusLog.push(this); } });
      const node = refs.get(ref); node.type = element.type; node.props = element.props; ref.current = node;
    });
    for (const [ref] of refs) if (!attached.has(ref)) { ref.current = null; refs.delete(ref); }
    effects.forEach(effect => effect());
  };
  const find = predicate => { let found; visit(tree, node => { if (!found && predicate(node)) found = node; }); assert.ok(found, 'Expected component control exists'); return found; };
  t.after(() => {
    for (const slot of slots) slot?.cleanup?.();
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore); else delete globalThis.window;
  });
  flush();
  return {
    props, commands, focusLog, dirtyLog, flush, find, confirmations,
    answerConfirmation(answer) { confirmationAnswers.push(answer); },
    toggle(predicate, checked) { find(predicate).props.onChange({ target: { checked } }); flush(); },
    get activeElement() { return activeElement; }, get exits() { return exits; },
    focusAway() { activeElement = { type: 'button' }; },
    submit() { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); flush(); },
    click(label) { find(node => node.type === 'button' && textOf(node.props.children) === label).props.onClick(); flush(); },
    edit(predicate, value) { find(predicate).props.onChange({ target: { value } }); flush(); },
  };
}
const validPreferences = step => {
  const onboarding = freshOnboarding(); onboarding.step = step;
  onboarding.experience = { title: 'A fictional form', context: 'I noticed a confusing form.', action: 'I asked for feedback.', outcome: '', lesson: '' };
  onboarding.demoText = 'I noticed a confusing form. I asked for feedback.';
  onboarding.feedback = { liked: 'Keep the short opening.', change: '', reason: '', revisedText: onboarding.demoText };
  return { displayName: 'Fictional writer', linkedinProfileUrl: 'https://www.linkedin.com/in/fictional-writer/', audience: '', voice: 'Direct', tone: 'Warm', hooks: 'Start with the moment', structure: 'Situation, action, lesson', vocabulary: 'Plain language', avoid: 'Invented results', goals: '', preferredFormats: '', feedbackGuidance: '', creators: [{ name: 'Reference', profileUrl: '', notes: 'Clear openings' }], onboarding };
};
test('empty optional creator notes advance through the actual component without removing rights or identity gates', t => {
  const prefs = validPreferences(2); prefs.creators[0].notes = '';
  const ui = interact(t, prefs);
  const notes = ui.find(node => node.type === 'textarea' && node.props.maxLength === 4000);
  assert.notEqual(notes.props.required, true, 'Creator notes are not a native required field');
  ui.submit();
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.commands[0].operation, 'saveWritingProfile');
  assert.equal(ui.commands[0].args[0].creators[0].notes, '');
  assert.equal(ui.props.profile.preferences.onboarding.step, 3);
  assert.equal(ui.activeElement.type, 'h1');
  assert.equal(textOf(ui.activeElement.props.children), 'A real experience');
});
test('reference notice distinguishes saved, unsaved and stale server projections in the actual component', t => {
  const prefs = validPreferences(2), ui = interact(t, prefs);
  ui.props.creatorResearch = deriveCreatorResearchStatus(ui.props.profile); ui.flush();
  const notice = () => textOf(ui.find(node => node.type === 'p' && node.props.role === 'status').props.children);
  assert.match(notice(), /1 reference saved · not yet researched/);
  ui.props.creatorResearch = { ...ui.props.creatorResearch, profileVersion: 1 }; ui.flush();
  assert.match(notice(), /Refresh to check/);
  ui.props.creatorResearch = deriveCreatorResearchStatus(ui.props.profile); ui.flush();
  ui.edit(node => node.type === 'input' && node.props.maxLength === 200, 'Another reference');
  assert.match(notice(), /Unsaved references/);
  assert.match(notice(), /Automatic creator research is not active/);
  assert.equal(ui.commands.length, 0, 'Rendering a status never submits or starts research');
});
const assertErrorFocus = (ui, message) => {
  assert.equal(ui.activeElement?.props?.role, 'alert', 'A failed attempt focuses its error summary');
  assert.equal(ui.activeElement.props.tabIndex, -1, 'Error summary is programmatically focusable without adding a tab stop');
  assert.match(textOf(ui.activeElement.props.children), message);
};
for (const [name, step, prepare, message] of [
  ['non-LinkedIn URL', 1, prefs => { prefs.linkedinProfileUrl = 'https://example.test/in/fictional-writer/'; }, /HTTPS LinkedIn profile/],
  ['missing writing reference', 2, prefs => { prefs.creators = []; }, /at least one writing reference/],
  ['sample without permission', 2, prefs => { prefs.creators[0].sample = 'Fictional sample.'; prefs.creators[0].rightsConfirmed = false; }, /permission to use/],
  ['blank feedback', 5, prefs => { prefs.onboarding.feedback.liked = ''; }, /specific observation/],
  ['nonspecific feedback', 5, prefs => { prefs.onboarding.feedback.liked = 'good'; }, /specific observation/],
  ['revision without explanation', 5, prefs => { prefs.onboarding.feedback.revisedText += ' A revised ending.'; }, /why you changed/],
  ['unconfirmed facts', 6, () => {}, /Review and confirm the facts/],
]) test(`custom ${name} validation focuses the error on every failed submission, including identical retries`, t => {
  const prefs = validPreferences(step); prepare(prefs);
  const original = structuredClone(prefs), ui = interact(t, prefs);
  assert.equal(ui.activeElement.type, 'h1', 'Initial step keeps heading focus');
  for (let attempt = 0; attempt < 3; attempt++) {
    ui.focusAway(); ui.submit(); assertErrorFocus(ui, message);
    assert.equal(ui.commands.length, 0, 'Invalid forms are never saved');
    assert.equal(ui.exits, 0);
  }
  assert.deepEqual(prefs, original, 'Validation preserves the entered form');
  assert.equal(ui.focusLog.filter(node => node.type === 'h1').length, 1, 'Failed submissions do not refocus the step heading');
});
test('editing after a failure clears its summary without stealing focus, then a successful next step focuses its heading', t => {
  const prefs = validPreferences(1); prefs.linkedinProfileUrl = 'https://example.test/in/fictional-writer/';
  const ui = interact(t, prefs); ui.submit(); assertErrorFocus(ui, /HTTPS LinkedIn profile/);
  ui.focusAway();
  ui.edit(node => node.type === 'input' && node.props.type === 'url', 'https://www.linkedin.com/in/fictional-writer/');
  const afterEditing = ui.focusLog.length;
  assert.equal(ui.activeElement.type, 'button', 'Clearing an error does not request focus');
  ui.flush(); assert.equal(ui.focusLog.length, afterEditing, 'Unrelated renders do not steal focus');
  ui.submit();
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.commands[0].operation, 'saveWritingProfile');
  assert.deepEqual(ui.commands[0].args[1], { expectedVersion: 2 });
  assert.equal(ui.props.profile.preferences.onboarding.step, 2);
  assert.equal(ui.activeElement.type, 'h1');
  assert.equal(textOf(ui.activeElement.props.children), 'Writing references');
  assert.equal(ui.focusLog.length, afterEditing + 1, 'Only the new heading receives focus after advancing');
});
test('saving back after failed feedback validation removes the stale error and preserves the feedback', t => {
  const prefs = validPreferences(5); prefs.onboarding.feedback.liked = 'good';
  const ui = interact(t, prefs); ui.submit(); assertErrorFocus(ui, /specific observation/);
  ui.click('Save & back');
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.props.profile.preferences.onboarding.step, 4);
  assert.deepEqual(ui.props.profile.preferences.onboarding.feedback, prefs.onboarding.feedback);
  assert.equal(ui.activeElement.type, 'h1');
  assert.equal(textOf(ui.activeElement.props.children), 'Story outline');
  assert.equal(ui.find(node => node.type === 'section' && node.props.className === 'sb-onboarding').props.children.some(node => node?.props?.role === 'alert'), false);
});
test('a newer saved profile blocks saving and focuses its warning on repeated save-and-exit attempts without replacing local edits', t => {
  const prefs = validPreferences(1), ui = interact(t, prefs);
  ui.edit(node => node.type === 'input' && node.props.autoComplete === 'given-name', 'Unsaved local name');
  ui.props.profile = { ...ui.props.profile, version: 3, preferences: { ...prefs, displayName: 'New remote name' } }; ui.flush();
  for (let attempt = 0; attempt < 2; attempt++) {
    ui.focusAway(); ui.click('Save & exit to dashboard'); assertErrorFocus(ui, /newer saved version/);
  }
  assert.equal(ui.commands.length, 0); assert.equal(ui.exits, 0);
  assert.equal(ui.find(node => node.type === 'input' && node.props.autoComplete === 'given-name').props.value, 'Unsaved local name');
});
test('native required constraints stay enabled and busy submissions do not trigger custom focus or saves', t => {
  const markup = render(1); assert.match(markup, /required=""/); assert.doesNotMatch(markup, /novalidate/i);
  const ui = interact(t, validPreferences(2)); ui.props.busy = true; ui.flush(); ui.focusAway();
  const before = ui.focusLog.length; ui.submit();
  assert.equal(ui.commands.length, 0); assert.equal(ui.focusLog.length, before);
});


test('approving the final facts preserves customized writing guidance', t => {
  const ui = interact(t, validPreferences(6));
  ui.click('Edit Markdown');
  ui.edit(node => node.type === 'textarea' && node.props.className === 'sb-skill-editor', 'My reviewed custom writing guidance.');
  ui.toggle(node => node.type === 'input' && node.props.type === 'checkbox', true);
  assert.equal(ui.find(node => node.type === 'textarea' && node.props.className === 'sb-skill-editor').props.value, 'My reviewed custom writing guidance.');
  ui.submit();
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.commands[0].args[0].skillMarkdown, 'My reviewed custom writing guidance.');
  assert.equal(ui.props.profile.preferences.onboarding.status, 'complete');
  assert.equal(ui.exits, 1);
});

test('changing reviewed writing guidance requires reviewing it again, but a no-op does not', t => {
  const prefs = validPreferences(6); prefs.onboarding.factsApproved = true; prefs.onboarding.status = 'complete';
  prefs.skillMarkdown = 'Custom wording that should survive a no-op.';
  const ui = interact(t, prefs), voice = node => node.type === 'textarea' && node.props.placeholder === 'How you sound as a person';
  ui.edit(voice, prefs.voice);
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, true);
  assert.match(textOf(ui.find(node => node.type === 'pre' && node.props.className === 'sb-guidance sb-skill-preview').props.children), /Custom wording/);
  ui.edit(voice, 'More personal, still direct.');
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false);
  ui.submit(); assertErrorFocus(ui, /Review and confirm the facts/);
  assert.equal(ui.commands.length, 0);
});

test('regenerating an experience protects revision-only feedback on cancel and clears it only on approval', t => {
  const prefs = validPreferences(3); prefs.emphasis = 'manual';
  prefs.onboarding.demoText = demoFromExperience(prefs.onboarding.experience);
  prefs.onboarding.feedback = { liked: '', change: '', reason: '', revisedText: 'My unfinished rewrite that I have not explained yet.' };
  const ui = interact(t, prefs);
  ui.edit(node => node.type === 'input' && node.props.maxLength === 250, 'A changed experience title');
  ui.answerConfirmation(false); ui.submit();
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.commands.length, 0, 'Cancel keeps unsaved experience and revision instead of saving a replacement');
  assert.equal(ui.find(node => node.type === 'input' && node.props.maxLength === 250).props.value, 'A changed experience title');
  ui.answerConfirmation(true); ui.submit();
  assert.equal(ui.commands.length, 1);
  const saved = ui.props.profile.preferences.onboarding;
  assert.equal(saved.step, 4);
  assert.equal(saved.demoText, demoFromExperience(saved.experience));
  assert.deepEqual(saved.feedback, { liked: '', change: '', reason: '', revisedText: saved.demoText });
  assert.equal(prefs.onboarding.feedback.revisedText, 'My unfinished rewrite that I have not explained yet.', 'Previously saved input remains immutable');
});

test('reopening a completed setup and saving without edits does not mark it unfinished', t => {
  const prefs = validPreferences(6); prefs.onboarding.status = 'complete'; prefs.onboarding.factsApproved = true;
  const ui = interact(t, prefs); ui.click('Save & exit to dashboard');
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.props.profile.preferences.onboarding.status, 'complete');
  assert.equal(ui.exits, 1);
});

test('loading a newer saved setup respects cancel then replaces the whole form and version baseline on approval', t => {
  const prefs = validPreferences(1), ui = interact(t, prefs);
  ui.edit(node => node.type === 'input' && node.props.autoComplete === 'given-name', 'Unsaved local name');
  const newer = validPreferences(2); newer.displayName = 'New remote name';
  ui.props.profile = { ...ui.props.profile, version: 7, preferences: newer }; ui.flush();
  ui.answerConfirmation(false); ui.click('Load newer saved version');
  assert.equal(ui.find(node => node.type === 'input' && node.props.autoComplete === 'given-name').props.value, 'Unsaved local name');
  assert.equal(ui.commands.length, 0); assert.equal(ui.dirtyLog.at(-1), true);
  ui.answerConfirmation(true); ui.click('Load newer saved version');
  assert.equal(ui.activeElement.type, 'h1');
  assert.equal(textOf(ui.activeElement.props.children), 'Writing references');
  assert.equal(ui.dirtyLog.at(-1), false);
  ui.submit(); assert.deepEqual(ui.commands[0].args[1], { expectedVersion: 7 });
  assert.equal(ui.props.profile.preferences.displayName, 'New remote name');
});

for (const action of ['Save & back', 'Save & exit to dashboard']) test(`uncleared samples cannot be persisted through ${action}`, t => {
  const prefs = validPreferences(2); prefs.creators[0].sample = 'An optional synthetic writing sample.'; prefs.creators[0].rightsConfirmed = false;
  const ui = interact(t, prefs); ui.click(action); assertErrorFocus(ui, /permission to use/);
  assert.equal(ui.commands.length, 0); assert.equal(ui.exits, 0);
  ui.toggle(node => node.type === 'input' && node.props.type === 'checkbox', true);
  ui.click(action); assert.equal(ui.commands.length, 1);
  assert.equal(ui.commands[0].args[0].creators[0].sample, prefs.creators[0].sample);
  assert.equal(ui.commands[0].args[0].creators[0].rightsConfirmed, true);
});


test('a complete six-step journey persists each checkpoint and finishes only after reviewed facts', t => {
  const prefs = validPreferences(1);
  prefs.onboarding = freshOnboarding(); prefs.creators = []; prefs.emphasis = 'manual';
  prefs.displayName = ''; prefs.linkedinProfileUrl = '';
  for (const field of ['voice', 'tone', 'hooks', 'structure', 'vocabulary', 'avoid']) prefs[field] = '';
  const ui = interact(t, prefs);
  const editField = (label, value) => {
    ui.find(node => node.props?.label === label).props.children.props.onChange({ target: { value } }); ui.flush();
  };
  editField('Preferred name', 'Fictional new writer');
  editField('Your LinkedIn profile URL', 'https://www.linkedin.com/in/fictional-writer/');
  ui.submit(); assert.equal(ui.props.profile.preferences.onboarding.step, 2);
  ui.click('Add a sample or reference'); editField('Writer or sample name', 'Fictional reference');
  ui.submit(); assert.equal(ui.props.profile.preferences.onboarding.step, 3);
  editField('A short title for this experience', 'A fictional form');
  editField('What happened?', 'I noticed a confusing form.');
  editField('What did you personally do?', 'I asked for feedback.');
  ui.submit(); assert.equal(ui.props.profile.preferences.onboarding.step, 4);
  assert.equal(ui.props.profile.preferences.onboarding.demoText, 'A fictional form\n\nI noticed a confusing form.\n\nI asked for feedback.');
  ui.submit(); assert.equal(ui.props.profile.preferences.onboarding.step, 5);
  editField('What should we keep?', 'Keep the short opening.');
  editField('Revise the outline in your own words', 'I asked for feedback after noticing a confusing form.');
  editField('Why do those edits feel more like you?', 'I want to lead with what I did.');
  ui.submit(); assert.equal(ui.props.profile.preferences.onboarding.step, 6);
  for (const [label, value] of [['Voice', 'Direct'], ['Tone', 'Warm'], ['Hooks', 'Start with my action'], ['Structure', 'Short paragraphs'], ['Vocabulary', 'Plain language'], ['Don’ts', 'Invented results']]) editField(label, value);
  ui.submit(); assertErrorFocus(ui, /Review and confirm the facts/); assert.equal(ui.exits, 0);
  ui.toggle(node => node.type === 'input' && node.props.type === 'checkbox', true); ui.submit();
  assert.equal(ui.commands.length, 6);
  assert.deepEqual(ui.commands.map(call => call.args[0].onboarding.step), [2, 3, 4, 5, 6, 6]);
  assert.deepEqual(ui.commands.map(call => call.args[1].expectedVersion), [2, 3, 4, 5, 6, 7]);
  for (const call of ui.commands) assert.doesNotThrow(() => validateWritingProfile(call.args[0]));
  assert.equal(ui.exits, 1); assert.equal(ui.dirtyLog.at(-1), false);
  assert.equal(ui.props.profile.preferences.onboarding.status, 'complete');
  assert.deepEqual(ui.props.profile.preferences.approvedFacts, ['I noticed a confusing form.', 'I asked for feedback.']);
  assert.match(ui.props.profile.preferences.feedbackProvenance, /I want to lead with what I did/);
  assert.equal(ui.props.profile.preferences.onboarding.experience.outcome, '', 'No result is invented to finish');
});

test('unfinished current-step fields save and reopen without fabricating later progress', async t => {
  let saved;
  await t.test('save the unfinished experience', t => {
    const prefs = validPreferences(3); prefs.onboarding.experience.action = '';
    prefs.onboarding.demoText = ''; prefs.onboarding.feedback = freshOnboarding().feedback;
    const ui = interact(t, prefs);
    ui.click('Save & exit to dashboard');
    assert.equal(ui.commands.length, 1); assert.equal(ui.exits, 1);
    saved = ui.props.profile.preferences;
    assert.equal(saved.onboarding.step, 3); assert.equal(saved.onboarding.status, 'in_progress');
    assert.equal(saved.onboarding.experience.action, '');
    assert.doesNotThrow(() => validateWritingProfile(saved));
  });
  await t.test('reopen at the saved step', t => {
    const reopened = interact(t, saved);
    assert.equal(textOf(reopened.activeElement.props.children), 'A real experience');
    reopened.submit(); assertErrorFocus(reopened, /what you personally did/);
    assert.equal(reopened.commands.length, 0);
  });
});

test('editing custom Markdown after approval clears only the old review, not the new guidance', t => {
  const prefs = validPreferences(6); prefs.onboarding.factsApproved = true;
  const ui = interact(t, prefs); ui.click('Edit Markdown');
  ui.edit(node => node.type === 'textarea' && node.props.className === 'sb-skill-editor', 'A newly revised custom guide.');
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false);
  ui.submit(); assertErrorFocus(ui, /Review and confirm the facts/); assert.equal(ui.commands.length, 0);
  ui.toggle(node => node.type === 'input' && node.props.type === 'checkbox', true); ui.submit();
  assert.equal(ui.commands[0].args[0].skillMarkdown, 'A newly revised custom guide.');
});


test('editing a completed experience and saving early clears approved facts until fresh review', t => {
  const prefs = validPreferences(6);
  prefs.onboarding.status = 'complete'; prefs.onboarding.factsApproved = true;
  prefs.approvedFacts = experienceFacts(prefs.onboarding.experience);
  prefs.feedbackProvenance = feedbackRecord(prefs.onboarding);
  const before = structuredClone(prefs), ui = interact(t, prefs);
  ui.click('Save & back'); ui.click('Save & back'); ui.click('Save & back');
  ui.find(node => node.props?.label === 'What happened?').props.children.props.onChange({ target: { value: 'I noticed unclear instructions, not a confusing form.' } }); ui.flush();
  ui.click('Save & exit to dashboard');
  const saved = ui.props.profile.preferences;
  assert.equal(saved.onboarding.step, 3); assert.equal(saved.onboarding.status, 'in_progress');
  assert.equal(saved.onboarding.factsApproved, false);
  assert.deepEqual(saved.approvedFacts, [], 'Proposed experience facts are not authoritative approved facts');
  assert.equal(saved.feedbackProvenance, feedbackRecord(saved.onboarding));
  assert.equal(saved.onboarding.demoText, before.onboarding.demoText, 'Do not discard the earlier demo before the reset confirmation');
  assert.deepEqual(saved.onboarding.feedback, before.onboarding.feedback, 'The earlier demo feedback remains intact until regeneration');
  const exported = writingSkillDocument(ui.props.profile);
  const factsSection = exported.split('## Approved facts')[1].split('## Applied feedback guidance')[0];
  assert.match(factsSection, /Treat these as proposed facts, not approved facts/);
  assert.doesNotMatch(factsSection, /I noticed unclear instructions, not a confusing form/);
  assert.match(factsSection, /Not yet specified/);
  assert.doesNotMatch(factsSection, /I noticed a confusing form\./);
  assert.deepEqual(prefs, before, 'Historical profile remains unchanged');
});

test('saving feedback before the final step refreshes its derived provenance', t => {
  const prefs = validPreferences(5); prefs.feedbackProvenance = feedbackRecord(prefs.onboarding);
  const ui = interact(t, prefs);
  ui.find(node => node.props?.label === 'What should we keep?').props.children.props.onChange({ target: { value: 'Keep the focus on my action.' } }); ui.flush();
  ui.click('Save & back');
  assert.equal(ui.props.profile.preferences.onboarding.step, 4);
  assert.equal(ui.props.profile.preferences.feedbackProvenance, feedbackRecord(ui.props.profile.preferences.onboarding));
  assert.match(ui.props.profile.preferences.feedbackProvenance, /Keep the focus on my action/);
  assert.doesNotMatch(ui.props.profile.preferences.feedbackProvenance, /Keep the short opening/);
});

test('approved demo regeneration clears both feedback fields and their derived provenance in the same checkpoint', t => {
  const prefs = validPreferences(3); prefs.feedbackProvenance = feedbackRecord(prefs.onboarding);
  const ui = interact(t, prefs);
  ui.edit(node => node.type === 'input' && node.props.maxLength === 250, 'A different title');
  ui.answerConfirmation(true); ui.submit();
  const saved = ui.props.profile.preferences;
  assert.equal(saved.onboarding.step, 4);
  assert.equal(saved.onboarding.feedback.liked, '');
  assert.equal(saved.feedbackProvenance, feedbackRecord(saved.onboarding));
  assert.doesNotMatch(saved.feedbackProvenance, /Keep the short opening/);
});


test('unapproved step-six facts remain proposed in the visible review but absent from authoritative preview and partial saves', t => {
  const ui = interact(t, validPreferences(6));
  const proposed = ui.find(node => node.type === 'ul' && node.props.className === 'sb-approved-facts');
  assert.match(textOf(proposed.props.children), /I noticed a confusing form/);
  const preview = textOf(ui.find(node => node.type === 'pre' && node.props.className === 'sb-guidance sb-skill-preview').props.children);
  const factsSection = preview.split('## Approved facts')[1].split('## Applied feedback guidance')[0];
  assert.match(factsSection, /Treat these as proposed facts, not approved facts/);
  assert.match(factsSection, /Not yet specified/);
  assert.doesNotMatch(factsSection, /I noticed a confusing form/);
  ui.click('Save & exit to dashboard');
  assert.deepEqual(ui.props.profile.preferences.approvedFacts, []);
  assert.equal(ui.props.profile.preferences.onboarding.factsApproved, false);
});

test('a same-value experience event preserves approved facts and custom Markdown after navigating back', t => {
  const prefs = validPreferences(6);
  prefs.onboarding.status = 'complete'; prefs.onboarding.factsApproved = true;
  prefs.approvedFacts = experienceFacts(prefs.onboarding.experience);
  prefs.skillMarkdown = 'My completed custom guide.';
  const ui = interact(t, prefs);
  ui.click('Save & back'); ui.click('Save & back'); ui.click('Save & back');
  ui.find(node => node.props?.label === 'What happened?').props.children.props.onChange({ target: { value: prefs.onboarding.experience.context } }); ui.flush();
  assert.equal(ui.dirtyLog.at(-1), false, 'An identical experience value is not an edit');
  ui.click('Save & exit to dashboard');
  const saved = ui.props.profile.preferences;
  assert.equal(saved.onboarding.factsApproved, true);
  assert.deepEqual(saved.approvedFacts, prefs.approvedFacts);
  assert.equal(saved.skillMarkdown, 'My completed custom guide.');
});


for (const emphasis of ['manual', 'hook_takeaway']) test(`unchanged ${emphasis} demo roundtrip preserves the exact custom guide and current approval`, t => {
  const prefs = validPreferences(6); prefs.emphasis = emphasis;
  prefs.onboarding.status = 'complete'; prefs.onboarding.factsApproved = true;
  prefs.onboarding.demoText = applyEmphasisPreference(demoFromExperience(prefs.onboarding.experience), emphasis);
  prefs.onboarding.feedback.revisedText = prefs.onboarding.demoText;
  prefs.approvedFacts = experienceFacts(prefs.onboarding.experience);
  prefs.skillMarkdown = 'My exact reviewed custom guide.\n\nKeep this untouched.';
  const before = structuredClone(prefs), ui = interact(t, prefs);
  ui.click('Save & back'); ui.click('Save & back'); ui.click('Save & back');
  ui.submit();
  assert.equal(ui.props.profile.preferences.onboarding.step, 4);
  assert.equal(ui.confirmations.length, 0, 'Unchanged demo does not request destructive-reset confirmation');
  assert.equal(ui.props.profile.preferences.skillMarkdown, before.skillMarkdown);
  assert.equal(ui.props.profile.preferences.onboarding.factsApproved, true);
  assert.deepEqual(ui.props.profile.preferences.approvedFacts, before.approvedFacts);
  assert.deepEqual(ui.props.profile.preferences.onboarding.feedback, before.onboarding.feedback);
  ui.submit(); ui.submit(); ui.submit();
  assert.equal(ui.props.profile.preferences.onboarding.status, 'complete');
  assert.equal(ui.props.profile.preferences.skillMarkdown, before.skillMarkdown);
  assert.equal(ui.exits, 1);
  assert.deepEqual(prefs, before, 'Roundtrip preserves previous immutable input');
});

test('regenerating a different demo still clears the old custom guide and factual approval', t => {
  const prefs = validPreferences(3); prefs.emphasis = 'manual';
  prefs.onboarding.factsApproved = true;
  prefs.approvedFacts = experienceFacts(prefs.onboarding.experience);
  prefs.skillMarkdown = 'Custom guidance for the earlier demo.';
  assert.notEqual(prefs.onboarding.demoText, demoFromExperience(prefs.onboarding.experience));
  const ui = interact(t, prefs); ui.answerConfirmation(true); ui.submit();
  const saved = ui.props.profile.preferences;
  assert.equal(saved.onboarding.step, 4); assert.equal(ui.confirmations.length, 1);
  assert.equal(saved.skillMarkdown, ''); assert.equal(saved.onboarding.factsApproved, false);
  assert.deepEqual(saved.approvedFacts, []);
  assert.deepEqual(saved.onboarding.feedback, { liked: '', change: '', reason: '', revisedText: saved.onboarding.demoText });
});

test('editing a writing sample requires fresh rights confirmation but a no-op preserves it', t => {
  const prefs = validPreferences(2); prefs.creators[0].sample = 'Permitted fictional excerpt.'; prefs.creators[0].rightsConfirmed = true;
  const ui = interact(t, prefs);
  const sample = node => node.type === 'textarea' && node.props.maxLength === 8000;
  const permission = node => node.type === 'input' && node.props.type === 'checkbox';
  ui.edit(sample, prefs.creators[0].sample);
  assert.equal(ui.find(permission).props.checked, true);
  ui.edit(sample, 'A different fictional excerpt.');
  assert.equal(ui.find(permission).props.checked, false);
  ui.submit(); assert.equal(ui.commands.length, 0); assertErrorFocus(ui, /permission to use/);
  ui.toggle(permission, true); ui.submit();
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.commands[0].args[0].creators[0].sample, 'A different fictional excerpt.');
  assert.equal(ui.commands[0].args[0].creators[0].rightsConfirmed, true);
});
