'use client';

import { useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import Field from './StoryField.mjs';
import { validatePlanTime } from '../lib/studio-flow.mjs';

type Props = {
  story: { id: string; title: string; activeApprovalId: string | null };
  busy: boolean;
  command: (operation: string, args: unknown[], message?: string, after?: () => void) => Promise<void>;
  onClose: () => void;
};

export default function PlanForm({ story, busy, command, onClose }: Props) {
  const [validationError, setValidationError] = useState('');
  const [timePreview, setTimePreview] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const request = useRef({ intent: '', key: '' });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <form onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    // Read the actual native date control on submission. A picker/autofill must
    // not get stuck behind an empty or delayed React change-event mirror.
    const checked = validatePlanTime(input.current?.value ?? '');
    if (!checked.valid) { setValidationError(checked.error); input.current?.focus(); return; }
    setValidationError('');
    const intent = JSON.stringify([story.id, story.activeApprovalId, checked.iso]);
    if (request.current.intent !== intent) request.current = { intent, key: crypto.randomUUID() };
    void command('schedulePlan', [{ storyId: story.id, approvalId: story.activeApprovalId, dueAt: checked.iso, idempotencyKey: request.current.key }], 'Added to your content plan. You will need to publish it yourself.', onClose);
  }}>
    <p>Pick a time for “{story.title || 'Untitled draft'}”. This saves a plan only. It does not schedule a LinkedIn post or send a reminder.</p>
    <Field label="Planned date and time" hint={`Shown in your browser’s time zone: ${timezone}.`}>
      <input ref={input} id="plan-time" name="dueAt" type="datetime-local" required defaultValue="" onInput={() => { setValidationError(''); const checked = validatePlanTime(input.current?.value ?? ''); setTimePreview(checked.valid && checked.iso ? `${new Date(checked.iso).toString()} · UTC: ${checked.iso}` : ''); }} disabled={busy} aria-invalid={!!validationError} aria-describedby={validationError ? 'plan-time-error' : undefined} />
    </Field>
    {timePreview && <p role="status" className="sb-muted">Exact planning time: {timePreview}. During a repeated daylight-saving hour, check this offset carefully; use a different time if it is not the occurrence you intended.</p>}
    {validationError && <div id="plan-time-error" role="alert" className="sb-error">{validationError}</div>}
    <div className="sb-notice amber"><CircleHelp size={17} /><div>You will need to open LinkedIn and share the post yourself. Editing this draft will cancel its current plan.</div></div>
    <div className="sb-actions end">
      <button type="button" className="sb-btn secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="sb-btn" disabled={busy}>Save content plan</button>
    </div>
  </form>;
}
