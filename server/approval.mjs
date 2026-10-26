import { createHash, timingSafeEqual } from 'node:crypto';
import { plainText } from './plain-text.mjs';

// Fixed fields and order prevent ambiguous object-order hashing. All
// publish-relevant fields belong here; adding a field requires a schema bump.
export function approvalSnapshot(story) {
  return Object.freeze({
    schema: 'storybank.approval.v2',
    tenantId: story.tenantId,
    storyId: story.id,
    revision: story.revision,
    title: story.title,
    text: plainText(story.text),
    editorText: story.text,
    source: story.source,
    platform: story.platform,
    destinationId: story.destinationId,
    mediaIds: Object.freeze([...story.mediaIds]),
  });
}

export function hashSnapshot(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

export function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left ?? '') || !/^[a-f0-9]{64}$/.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
