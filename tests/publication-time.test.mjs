import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const moduleUrl = new URL('../hosted/lib/publication-time.mjs', import.meta.url).href;
function convert(tz, value, now) {
  const source = `import { scheduledPublicationTime } from ${JSON.stringify(moduleUrl)}; try { console.log(JSON.stringify({ result: scheduledPublicationTime(${JSON.stringify(value)}, ${JSON.stringify(now)}) })); } catch (error) { console.log(JSON.stringify({ error: error.message })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('scheduled local time includes the exact browser timezone offset and IANA zone', () => {
  assert.deepEqual(convert('Asia/Kolkata', '2026-10-25T09:30', Date.parse('2026-10-24T10:00Z')).result, { dueAt: '2026-10-25T09:30:00+05:30', timeZone: 'Asia/Calcutta' });
  assert.deepEqual(convert('America/New_York', '2026-10-25T09:30', Date.parse('2026-10-24T10:00Z')).result, { dueAt: '2026-10-25T09:30:00-04:00', timeZone: 'America/New_York' });
});
test('nonexistent DST time and impossible dates are rejected instead of normalized', () => {
  for (const value of ['2027-03-14T02:30', '2027-02-30T10:00']) assert.match(convert('America/New_York', value, Date.parse('2027-02-20T10:00Z')).error, /does not exist/);
});
test('repeated DST time uses an explicit distinguishable offset', () => {
  assert.equal(convert('America/New_York', '2026-11-01T01:30', Date.parse('2026-10-24T10:00Z')).result.dueAt, '2026-11-01T01:30:00-04:00');
});
test('past, near and excessively distant schedule times cannot reach final review', () => {
  const now = Date.parse('2026-10-24T10:00Z');
  for (const value of ['2026-10-24T09:00', '2026-10-24T10:01', '2027-02-24T10:00']) assert.match(convert('UTC', value, now).error, /one minute ahead/);
  for (const value of ['', 'invalid', '2026-10-25T10:00Z']) assert.match(convert('UTC', value, now).error, /Choose a date and time/);
});
