import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editedWritingProfile } from '../hosted/lib/studio-flow.mjs';
import { validateWritingProfile, writingSkillDocument } from '../server/writing-profile.mjs';
test('changing structured guidance clears a stale Markdown override without changing saved history',()=>{
  const saved=validateWritingProfile({voice:'Formal',skillMarkdown:'Use only formal language.',creators:[]});
  const edited=editedWritingProfile(saved,{voice:'Conversational'});
  assert.equal(edited.skillMarkdown,'');assert.equal(saved.skillMarkdown,'Use only formal language.');
  const doc=writingSkillDocument({preferences:edited,version:2,savedAt:'Synthetic fixture'});assert.match(doc,/Conversational/);assert.doesNotMatch(doc,/Use only formal language/);
});
test('reference changes clear stale guidance; no-op edits and legacy shapes remain intact',()=>{
  const saved={voice:'Plain',skillMarkdown:'Old guide',creators:[{name:'One',profileUrl:'',notes:''}]};
  assert.equal(editedWritingProfile(saved,{creators:[]}).skillMarkdown,'');
  assert.equal(editedWritingProfile(saved,{creators:structuredClone(saved.creators)}).skillMarkdown,'Old guide');
  assert.equal(Object.hasOwn(editedWritingProfile({voice:'Old',creators:[]},{voice:'New'}),'skillMarkdown'),false);
});
test('profile editor uses invalidating edits for fields and reference add/edit/remove',()=>{
  const source=readFileSync(new URL('../hosted/app/Studio.tsx',import.meta.url),'utf8').split('function ProfilePanel(')[1].split('function CalibrationPanel(')[0];
  assert.equal((source.match(/editedWritingProfile\(prev,/g)||[]).length,4);
  assert.doesNotMatch(source,/<Field label="Name[^]*?<input required maxLength=\{200\} value=\{creator.name\}/);
  assert.match(source,/earlier versions remain in history/);
});
