'use client';

import { useState } from 'react';
import Field from './StoryField.mjs';
import { manualWritingBrief } from '../lib/manual-writing-brief.mjs';
import type { Profile } from './Onboarding';

export default function ManualWritingBrief({ title, draft, sourceFacts, profile, reviewFeedback }: { reviewFeedback?: string; title: string; draft: string; sourceFacts: string; profile?: Profile }) {
  const [facts, setFacts] = useState(sourceFacts);
  const [includeGuidance, setIncludeGuidance] = useState(true);
  const [referenceSelection, setReferenceSelection] = useState<{ fingerprint: string; indexes: number[] }>({ fingerprint: '', indexes: [] });
  const [copyResult, setCopyResult] = useState<{ brief: string; message: string } | null>(null);
  const suppliedReferences = (profile?.preferences.creators ?? []).map((creator, index) => ({ creator, index }));
  const fingerprint = JSON.stringify([profile?.version ?? 0, suppliedReferences.map(({ creator }) => [creator.name, creator.profileUrl, creator.sample, creator.rightsConfirmed])]);
  // A changed/reordered source clears consent synchronously, before rendering
  // a brief or allowing copy. An effect would leave one stale render exposed.
  const selectedReferences = referenceSelection.fingerprint === fingerprint ? referenceSelection.indexes : [];
  const brief = manualWritingBrief({ title, facts, draft, reviewFeedback, preferences: includeGuidance ? profile?.preferences : {}, profileVersion: includeGuidance ? profile?.version : 0, selectedReferences: suppliedReferences.filter(({ index }) => selectedReferences.includes(index)).map(({ creator }) => creator) });
  const status = copyResult ? copyResult.brief === brief ? copyResult.message : 'The brief changed after the previous copy attempt. Review it and copy again before pasting.' : '';
  return <details className="sb-panel sb-space-top">
    <summary>Write with your own ChatGPT conversation</summary>
    <p>This is a manual copy-and-paste workflow. StoryBank does not call ChatGPT or use an API. Your ChatGPT subscription does not connect itself to this website.</p>
    <ol><li>Review the facts, select any supplied reference excerpts, and check the exact brief. Remove anything you do not want to share.</li><li>Copy the brief into your own ChatGPT conversation. Analyse the actual reference writing first, then use your real experience to draft.</li><li>Check the response, then paste your chosen draft into this editor and save it.</li></ol>
    <Field label="Facts for this post" hint="Only this post’s notes. These edits stay in this panel until you leave; they are not saved to your story bank."><textarea maxLength={20000} value={facts} onChange={event => { setFacts(event.target.value); setCopyResult(null); }} placeholder="What happened? What did you do? What can you truthfully say changed?" /></Field>
    <label className="sb-check"><input type="checkbox" checked={includeGuidance} onChange={event => { setIncludeGuidance(event.target.checked); setCopyResult(null); }} />Include my saved writing guidance{profile ? ` (version ${profile.version})` : ' when available'}</label>
    <fieldset><legend>References to review before drafting</legend><p className="sb-muted">Nothing is selected by default. Changing the saved profile or references resets this selection. Selected names and links are requests for manual review, not researched sources. An excerpt is included only if you confirmed you may use it.</p>{suppliedReferences.length ? suppliedReferences.map(({ creator, index }) => <div key={index}><label className="sb-check"><input type="checkbox" checked={selectedReferences.includes(index)} onChange={event => { const checked = event.target.checked; setReferenceSelection(current => { const indexes = current.fingerprint === fingerprint ? current.indexes : []; return { fingerprint, indexes: checked ? [...new Set([...indexes, index])] : indexes.filter(item => item !== index) }; }); setCopyResult(null); }} />Include {creator.name || `reference ${index + 1}`} {creator.rightsConfirmed && creator.sample?.trim() ? `(${creator.sample.length.toLocaleString()} characters supplied)` : '(no eligible excerpt)'}</label>{creator.rightsConfirmed && !!creator.sample?.trim() && <details><summary>Review supplied excerpt</summary><pre className="sb-guidance">{creator.sample}</pre></details>}</div>) : <p>No references are saved. Add them in Personal setup → Writing references, or provide them directly in your own conversation.</p>}<p>If a link cannot be reached or does not show actual posts, paste the post or attach screenshots in your ChatGPT conversation. StoryBank does not support screenshot upload or automatic image analysis. No reference-informed draft should be claimed until actual writing has been reviewed.</p></fieldset>
    <p className="sb-muted">Includes only this draft, its saved review feedback, the facts above, selected writing guidance and checked reference names, links and eligible excerpts. No other stories, unselected samples, audio, account metadata or LinkedIn permissions are included. Nothing is sent automatically. Pasting into ChatGPT shares the copied text with that service under your account’s settings.</p>
    <Field label="Writing brief to review and copy"><textarea readOnly rows={9} value={brief} onFocus={event => event.target.select()} /></Field>
    <button type="button" className="sb-btn secondary" onClick={() => { if (!navigator.clipboard?.writeText) { setCopyResult({ brief, message: 'Clipboard access is unavailable. Select the writing brief above and copy it manually.' }); return; } void navigator.clipboard.writeText(brief).then(() => setCopyResult({ brief, message: 'Brief copied. Paste it into your own ChatGPT conversation when you are ready.' })).catch(() => setCopyResult({ brief, message: 'Clipboard access was blocked. Select the writing brief above and copy it manually.' })); }}>Copy reviewed writing brief</button>
    {status && <p role="status" className="sb-inline-hint">{status}</p>}
  </details>;
}
