/** Converts the browser's local datetime input to an explicit reviewed offset.
 * A missing DST wall time is rejected, never silently normalized. A repeated
 * wall time uses the browser's earlier occurrence; final review shows offset
 * and UTC instant so the user can distinguish it before authorizing. */
export function scheduledPublicationTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Error('Choose a date and time for your post.');
  const date = new Date(value);
  const pad = value => String(value).padStart(2, '0');
  const local = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (!Number.isFinite(date.getTime()) || local !== value) throw new Error('That local time does not exist. Check the date and daylight saving time.');
  if (date.getTime() <= now + 60_000 || date.getTime() > now + 90 * 86400_000) throw new Error('Choose a time more than one minute ahead and within 90 days.');
  const offset = -date.getTimezoneOffset();
  const suffix = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return { dueAt: `${value}:00${suffix}`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
