/** Decorative Unicode is plain text, not LinkedIn rich-text formatting. */
const bold = new Map();
for (const [first, last, target] of [[65, 90, 0x1d5d4], [97, 122, 0x1d5ee], [48, 57, 0x1d7ec]]) {
  for (let point = first; point <= last; point++) bold.set(String.fromCodePoint(point), String.fromCodePoint(target + point - first));
}
const regular = new Map([...bold].map(([source, target]) => [target, source]));
export const accessiblePlainText = text => Array.from(String(text), char => regular.get(char) || char).join('');
export const codePointLength = text => Array.from(String(text)).length;
export function applyEmphasisPreference(text, preference = 'manual') {
  if (preference === 'manual') return text;
  const source = accessiblePlainText(text);
  if (preference === 'none') return source;
  if (preference !== 'hook_takeaway') return text;
  const parts = source.split(/(\n\s*\n)/);
  const eligible = parts.map((part, index) => ({ part, index })).filter(({ part, index }) => index % 2 === 0 && part.trim() && !/^(?:#[^\s#]+\s*)+$/.test(part.trim()));
  const selected = new Set([eligible[0]?.index, eligible.at(-1)?.index]);
  return parts.map((part, index) => selected.has(index) ? Array.from(part, char => bold.get(char) || char).join('') : part).join('');
}
function safeRange(text, start, end) {
  start = Math.max(0, Math.min(text.length, Math.trunc(start) || 0));
  end = Math.max(start, Math.min(text.length, Math.trunc(end) || 0));
  const low = index => index > 0 && /[\uDC00-\uDFFF]/.test(text[index] || '') && /[\uD800-\uDBFF]/.test(text[index - 1]);
  if (low(start)) start--;
  if (low(end)) end++;
  return [start, end];
}
export function toggleSelectedBold(text, start, end) {
  if (start === end) return { text, start, end, changed: false };
  [start, end] = safeRange(text, start, end);
  const selected = Array.from(text.slice(start, end));
  const mapped = selected.filter(char => bold.has(char) || regular.has(char));
  if (!mapped.length) return { text, start, end, changed: false };
  const remove = mapped.every(char => regular.has(char));
  const replacement = selected.map(char => remove ? regular.get(char) || char : bold.get(char) || char).join('');
  return { text: text.slice(0, start) + replacement + text.slice(end), start, end: start + replacement.length, changed: true };
}
export function toggleSelectedMarkers(text, start, end, marker = '*') {
  if (start === end) return { text, start, end, changed: false };
  [start, end] = safeRange(text, start, end);
  const selection = text.slice(start, end);
  if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
    return { text: text.slice(0, start - marker.length) + selection + text.slice(end + marker.length), start: start - marker.length, end: end - marker.length, changed: true };
  }
  if (selection.startsWith(marker) && selection.endsWith(marker) && selection.length > marker.length * 2) {
    const replacement = selection.slice(marker.length, -marker.length);
    return { text: text.slice(0, start) + replacement + text.slice(end), start, end: start + replacement.length, changed: true };
  }
  return { text: text.slice(0, start) + marker + selection + marker + text.slice(end), start: start + marker.length, end: end + marker.length, changed: true };
}
