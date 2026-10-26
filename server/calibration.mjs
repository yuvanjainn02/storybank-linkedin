import { fail } from './errors.mjs';

export function validateCalibration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((field) => !['topic', 'facts', 'count'].includes(field))) {
    fail('INVALID_CALIBRATION', 'Provide a topic, facts, and a variant count only.');
  }
  const { topic, facts, count = 3 } = input;
  if (typeof topic !== 'string' || !topic.trim() || topic.length > 500 || !Array.isArray(facts) || facts.length < 1 || facts.length > 10 || facts.some((fact) => typeof fact !== 'string' || !fact.trim() || fact.length > 2_000)) {
    fail('INVALID_CALIBRATION', 'Supply a topic and 1 to 10 concrete facts, each up to 2000 characters.');
  }
  if (!Number.isInteger(count) || count < 3 || count > 5) fail('INVALID_CALIBRATION', 'Choose 3 to 5 draft previews.');
  return { topic, facts: [...facts], count };
}

/** Deterministic format previews, not AI writing or creator-style research. */
export function draftFactPreviews({ topic, facts, count }, profile = {}) {
  const paragraphs = facts.join('\n\n');
  const bullets = facts.map((fact) => `• ${fact}`).join('\n');
  // Only affirmative formatting preferences affect this deliberately limited
  // preview. Free feedback is retained for review, not interpreted as commands.
  const positiveFeedback = (profile.feedbackGuidance ?? '').split('\n').filter((line) => line.startsWith('Prefer: ')).join('\n');
  const concise = /concise|brief|short/i.test(`${profile.voice ?? ''} ${profile.preferredFormats ?? ''} ${positiveFeedback}`);
  const primary = concise ? facts.join('\n') : paragraphs;
  return [
    { label: 'Direct account', text: `${topic}\n\n${primary}` },
    { label: 'Fact list', text: `${topic}\n\n${bullets}` },
    { label: 'Facts first', text: `${paragraphs}\n\nTopic: ${topic}` },
    { label: 'Notebook', text: `Notes on ${topic}\n\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n\n')}` },
    { label: 'Compact summary', text: `${topic}\n\n${facts.join(' ')}` },
  ].slice(0, count).map((variant) => ({ ...variant, kind: 'non_ai_template_preview' }));
}

export function validateFeedback(input) {
  const allowed = new Set(['variantId', 'likes', 'dislikes', 'editReasons', 'feedback', 'editedText']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((field) => !allowed.has(field))) {
    fail('INVALID_FEEDBACK', 'Feedback accepts only the variant ID, likes, dislikes, edit reasons, feedback, and edited text.');
  }
  const normalized = { likes: [], dislikes: [], editReasons: '', feedback: '', editedText: null, ...input };
  if (typeof normalized.variantId !== 'string' || !normalized.variantId) fail('INVALID_FEEDBACK', 'A draft preview must be selected.');
  for (const field of ['likes', 'dislikes']) {
    if (!Array.isArray(normalized[field]) || normalized[field].length > 10 || normalized[field].some((value) => typeof value !== 'string' || !value.trim() || value.length > 500)) {
      fail('INVALID_FEEDBACK', `${field} must contain at most 10 short, nonempty observations.`);
    }
    normalized[field] = [...normalized[field]];
  }
  for (const field of ['editReasons', 'feedback']) {
    if (typeof normalized[field] !== 'string' || normalized[field].length > 2_000) fail('INVALID_FEEDBACK', `${field} must be text up to 2000 characters.`);
  }
  if (normalized.editedText !== null && (typeof normalized.editedText !== 'string' || normalized.editedText.length > 20_000)) fail('INVALID_FEEDBACK', 'An edited draft must be text up to 20000 characters.');
  if (!normalized.likes.length && !normalized.dislikes.length && !normalized.editReasons.trim() && !normalized.feedback.trim() && normalized.editedText === null) fail('EMPTY_FEEDBACK', 'Add at least one observation or an edited draft.');
  return normalized;
}

export function proposedGuidance(existing, feedback) {
  const additions = feedback.map((item, index) => [
    `Feedback ${index + 1}:`,
    ...item.likes.map((like) => `Prefer: ${like}`),
    ...item.dislikes.map((dislike) => `Avoid: ${dislike}`),
    ...(item.editReasons ? [`Reason for edits: ${item.editReasons}`] : []),
    ...(item.feedback ? [`Writer’s feedback: ${item.feedback}`] : []),
    ...(item.editedText !== null ? ['An edited example was supplied. Review the original calibration before applying this guidance.'] : []),
  ].join('\n')).join('\n\n');
  const full = [existing, additions].filter(Boolean).join('\n\n');
  return { guidance: full.slice(0, 16_000), truncated: full.length > 16_000 };
}
