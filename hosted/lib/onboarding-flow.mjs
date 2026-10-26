/** Pure first-use helpers. No provider calls, browser storage, or identity selection. */
export const ONBOARDING_STEPS = ['Your identity', 'Writing references', 'A real experience', 'Story outline', 'Your feedback', 'Your writing skill'];
export function freshOnboarding() {
  return { step: 1, status: 'in_progress', experience: { title: '', context: '', action: '', outcome: '', lesson: '' }, demoText: '', feedback: { liked: '', change: '', reason: '', revisedText: '' }, factsApproved: false };
}
export function experienceFacts(experience) {
  return ['context', 'action', 'outcome', 'lesson'].map(key => experience[key].trim()).filter(Boolean);
}
export function demoFromExperience(experience) {
  return [experience.title.trim(), ...experienceFacts(experience)].filter(Boolean).join('\n\n');
}
export function feedbackRecord(state) {
  return [
    'Source: first-use non-AI story outline, based only on this writer’s supplied experience.',
    'Original outline and writer revision are preserved with the onboarding record and exported separately.',
    `Keep: ${state.feedback.liked || 'Not specified'}`,
    `Change: ${state.feedback.change || 'Not specified'}`,
    `Reason: ${state.feedback.reason || 'Not specified'}`,
    'Feedback was recorded verbatim, not interpreted by an AI model.',
  ].join('\n\n');
}
export function wizardError(preferences, nextStep = preferences.onboarding.step) {
  const state = preferences.onboarding;
  if (!Number.isInteger(nextStep) || nextStep < 1 || nextStep > 6) return 'Choose a valid setup step.';
  if (nextStep > 1) {
    if (!preferences.displayName.trim()) return 'Add the name you would like us to use.';
    try {
      const url = new URL(preferences.linkedinProfileUrl || '');
      if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/in\/[^/]+\/?$/.test(url.pathname)) throw new Error();
    } catch { return 'Add your HTTPS LinkedIn profile link, such as https://www.linkedin.com/in/your-name/.'; }
  }
  if (preferences.creators.length > 15) return 'Choose no more than 15 references. Your existing references have not been removed.';
  if (nextStep > 2 && !preferences.creators.length) return 'Add at least one writing reference before continuing.';
  for (const creator of preferences.creators) {
    if (!creator.name.trim() && !creator.profileUrl.trim()) return 'Give each reference a name or LinkedIn profile link.';
    if (creator.sample?.trim() && !creator.rightsConfirmed) return 'Confirm that you have permission to use each pasted writing sample, or remove it.';
  }
  if (nextStep > 3 && (!state.experience.title.trim() || !state.experience.context.trim() || !state.experience.action.trim())) return 'Add a title, what happened, and what you personally did. Results can remain unknown.';
  if (nextStep > 4 && !state.demoText.trim()) return 'Create a non-AI story outline from your real experience first.';
  if (nextStep > 5) {
    const specific = value => value.trim().length >= 3 && !/^(?:good|great|nice|yes|no|ok|okay|fine|bad|love it|like it|looks good)[.!\s]*$/i.test(value.trim());
    if (!specific(state.feedback.liked) && !specific(state.feedback.change)) return 'Add at least one specific observation about what to keep or change.';
    if (state.feedback.revisedText !== state.demoText && !state.feedback.reason.trim()) return 'Tell us why you changed the example so that the lesson is preserved.';
  }
  if (state.status === 'complete') {
    if (!state.factsApproved) return 'Review and confirm the facts before finishing.';
    for (const field of ['voice', 'tone', 'hooks', 'structure', 'vocabulary', 'avoid']) if (!preferences[field]?.trim()) return `Describe your ${field === 'avoid' ? 'writing don’ts' : field} before finishing.`;
  }
  return '';
}

/** Display only. Authority remains the owner-scoped server projection; unsaved
 * references or a stale projection must never appear saved or researched. */
export function creatorResearchMessage(status, savedVersion, referencesDirty = false) {
  if (referencesDirty) return 'Unsaved references. Save to refresh their status. Automatic creator research is not active.';
  if (!status || status.schema !== 'storybank.creator-research-status.v1' || status.profileVersion !== savedVersion || !Number.isSafeInteger(status.referenceCount) || status.referenceCount < 0 || status.referenceCount > 15 || status.researchStatus !== 'not_started' || status.reviewedSourceCount !== 0 || status.automaticResearchAvailable !== false || status.reason !== 'RESEARCH_NOT_CONFIGURED' || status.collectionStatus !== (status.referenceCount ? 'references_saved' : 'no_references')) return 'Refresh to check the saved creator-reference status. Automatic creator research is not active.';
  return status.collectionStatus === 'references_saved'
    ? `${status.referenceCount} reference${status.referenceCount === 1 ? '' : 's'} saved · not yet researched. Automatic creator research is not active.`
    : 'No saved creator references. Automatic creator research is not active.';
}
