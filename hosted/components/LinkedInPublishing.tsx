'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import '../app/publishing.css';
import { scheduledPublicationTime } from '../lib/publication-time.mjs';

type Story = { id: string; title: string; text: string; revision: number; destinationId: string | null; activeApprovalId: string | null };
type Publication = { storyId: string; expectedRevision: number; visibility: 'PUBLIC' | 'CONNECTIONS'; dueAt: string; timeZone: string; mode: 'now' | 'scheduled' };
type Snapshot = { text: string; author: string; displayName: string; visibility: string; sourceRevision: number; mode: string; dueAt: string; timeZone: string };
type Job = { id: string; story_id?: string; status: string; reason: string | null; snapshot: Snapshot; post_urn: string | null; created_at: number };
type Status = { serverTime: string; readiness: { configured: boolean; oauthEnabled: boolean; publishingEnabled: boolean; schedulerVerified: boolean; missing: string[]; scheduling: string }; connection: { displayName: string; personUrn: string; status: string; expiresAt: string } | null; jobs: Job[]; activeStoryIds?: string[] };
type Review = { snapshot: Snapshot; hash: string; publication: Publication; idempotencyKey: string; preparedAt: number };

export default function LinkedInPublishing({ workspaceKey }: { workspaceKey: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'CONNECTIONS'>('PUBLIC');
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  const mounted = useRef(false);
  const refreshSequence = useRef(0);
  const invalidateRefresh = useCallback(() => { refreshSequence.current++; }, []);
  const request = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'x-storybank-request': '1', 'x-storybank-workspace': workspaceKey }, body: JSON.stringify(body) }) });
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error('The response could not be confirmed. Refresh and check the publication history before trying again.'); }
    if (!response.ok) throw new Error(data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : 'The request could not be completed.');
    return data as T;
  }, [workspaceKey]);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [next, workspace] = await Promise.all([request<Status>('/api/linkedin/status'), request<{ user: { workspaceKey: string }; workspace: { data: { stories: Story[] } } }>('/api/workspace')]);
    if (!mounted.current || sequence !== refreshSequence.current) return;
    if (workspace.user.workspaceKey !== workspaceKey) { setReview(null); setStatus(null); setStories([]); throw new Error('Your signed-in workspace changed. Reload this page.'); }
    setStatus(next); setStories(workspace.workspace.data.stories);
  }, [request, workspaceKey]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      try { await refresh(); } catch (cause) { if (active) setError((cause as Error).message); }
    });
    return () => { active = false; mounted.current = false; invalidateRefresh(); };
  }, [refresh, invalidateRefresh]);
  // Read-only UI polling never sends a publication. It only reports an already
  // started request and stale-lease recovery, not a hidden browser scheduler.
  useEffect(() => {
    if (!status?.jobs.some((job) => job.status === 'sending')) return;
    const id = setInterval(() => { void refresh().catch((cause) => setError(cause.message)); }, 5000);
    return () => clearInterval(id);
  }, [status, refresh]);
  async function act(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The result is uncertain. Check the publication history before retrying.'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function connect() {
    if (!window.confirm('Connect this StoryBank workspace to LinkedIn? LinkedIn will ask for your basic profile and permission to post as you. StoryBank will store an encrypted access token on its server. It does not need your password or email address.')) return;
    await act(async () => {
      const data = await request<{ authorizationUrl: string }>('/api/linkedin/connect', { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' });
      const url = new URL(data.authorizationUrl);
      if (url.origin !== 'https://www.linkedin.com' || url.pathname !== '/oauth/v2/authorization') throw new Error('The connection destination could not be verified.');
      window.location.assign(url.href);
    });
  }
  async function prepare() {
    const draft = stories.find((story) => story.id === selected);
    if (!draft || !status?.connection) return;
    setReview(null);
    await act(async () => {
      // Validate readiness and time before changing source destination/approval:
      // an invalid scheduling form must never cancel an existing queued post.
      const serverStatus = await request<Status>('/api/linkedin/status');
      if (serverStatus.connection?.status !== 'connected' || serverStatus.connection.personUrn !== status.connection!.personUrn) throw new Error('Your LinkedIn connection changed. Refresh before reviewing this post.');
      if (!serverStatus.readiness.publishingEnabled) throw new Error('Live posting is disabled. No publication was changed.');
      if (mode === 'scheduled' && !serverStatus.readiness.schedulerVerified) throw new Error('Automatic scheduling is not verified for this workspace. No post was queued.');
      const timing = mode === 'scheduled' ? scheduledPublicationTime(scheduledAt, Date.parse(serverStatus.serverTime)) : { dueAt: serverStatus.serverTime, timeZone: 'UTC' };
      if (serverStatus.activeStoryIds?.includes(draft.id) || serverStatus.jobs.some(job => job.story_id === draft.id && ['queued', 'sending'].includes(job.status))) throw new Error('This draft already has a queued or sending publication. Cancel its queued version before preparing another; an in-flight post cannot be recalled.');
      let current = draft;
      if (current.destinationId !== status.connection!.personUrn) {
        current = (await request<{ result: Story }>('/api/command', { operation: 'updateStory', args: [current.id, { destinationId: status.connection!.personUrn }, { expectedRevision: current.revision }] })).result;
      }
      // This internal review is not permission to publish. The separate final
      // preview below binds exact text, account, audience and publication mode.
      // Mint a new source-review generation for each deliberate final review.
      // A cancelled/rejected publication approval can never be reused.
      await request('/api/command', { operation: 'approveStory', args: [current.id, { expectedRevision: current.revision }] });
      const publication: Publication = { storyId: current.id, expectedRevision: current.revision, visibility, ...timing, mode };
      const preview = await request<{ snapshot: Snapshot; hash: string }>('/api/linkedin/preview', publication);
      setReview({ ...preview, publication, idempotencyKey: crypto.randomUUID(), preparedAt: Date.now() });
      await refresh();
    });
  }
  async function publish() {
    if (!review) return;
    if (Date.now() - review.preparedAt > 55_000) { setReview(null); setError('This review expired. Review the current version again before publishing.'); return; }
    const savedReview = review;
    // Hide final action immediately. On an uncertain response we retain no
    // automatic retry path; the stored idempotency key remains in this closure.
    setReview(null);
    await act(async () => {
      const data = await request<{ job: Job }>('/api/linkedin/publish', { publication: savedReview.publication, previewHash: savedReview.hash,
        idempotencyKey: savedReview.idempotencyKey, confirmation: 'PUBLISH_EXACT_VERSION' });
      setMessage(data.job.status === 'published' ? 'LinkedIn confirmed the post. Its post identifier is recorded below.' : data.job.status === 'unknown' ? 'LinkedIn’s result is uncertain. Check your LinkedIn profile before doing anything else. StoryBank will not retry it.' : data.job.status === 'queued' && savedReview.publication.mode === 'scheduled' ? 'This exact version is queued for the reviewed time. Keep its source unchanged. It will be cancelled if more than 15 minutes late.' : `Publication status: ${data.job.status}.`);
      await refresh();
    });
  }
  const connection = status?.connection;
  return <main className="sb-publishing">
    {/* A full document navigation refreshes the hosted sign-in boundary and clears client workspace state. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    <a href="/" className="sb-pub-back">← Back to your writing studio</a>
    <header><p className="sb-pub-eyebrow">STORYBANK · OFFICIAL LINKEDIN CONNECTION</p><h1>Your words. Your final say.</h1><p>Connect your own account, review the exact version, then publish only when you choose.</p><p>This hosted app uses ChatGPT sign-in first to open your StoryBank workspace. Connecting LinkedIn is a separate step, using LinkedIn’s official permission screen when setup is available. ChatGPT sign-in alone does not grant LinkedIn posting access.</p></header>
    {error && <div role="alert" className="sb-pub-alert">{error}</div>}
    {message && <div role="status" className="sb-pub-notice">{message}</div>}
    <section className="sb-pub-card" aria-labelledby="connection-title"><h2 id="connection-title">1. Your LinkedIn connection</h2>
      {!status ? <p>Checking connection readiness…</p> : <>
        {connection ? <><p><strong>{connection.displayName}</strong> · {connection.status === 'connected' ? 'Connected' : 'Reconnect required'}</p><p className="sb-pub-small">{connection.personUrn}<br />Expires {new Date(connection.expiresAt).toLocaleString()}.</p></> : <p>No LinkedIn account is connected.</p>}
        {!status.readiness.oauthEnabled && <p className="sb-pub-notice">Connection setup is not ready. No OAuth permission or publishing token has been activated through this page.</p>}
        <div className="sb-pub-actions"><button disabled={busy || !status.readiness.oauthEnabled} onClick={() => void connect()}>{connection ? 'Reconnect with LinkedIn' : 'Connect with LinkedIn'}</button>
          {connection && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm('Disconnect LinkedIn and cancel any posts that have not started sending? Already published or in-flight posts cannot be recalled.')) void act(async () => { const data = await request<{ message: string }>('/api/linkedin/disconnect', { confirmation: 'DISCONNECT_LINKEDIN' }); setReview(null); setMessage(data.message); await refresh(); }); }}>Disconnect</button>}
          <button className="secondary" disabled={busy} onClick={() => void act(refresh)}>Refresh status</button></div>
        <p className="sb-pub-small">Official permissions: basic profile and posting as you. No email permission, password, browser cookies, or other creators’ posts. Access tokens are encrypted on the server, not end-to-end encrypted.</p>
      </>}
    </section>
    <section className="sb-pub-card" aria-labelledby="publish-title"><h2 id="publish-title">2. Review before publishing</h2>
      <p>Text posts only. Unicode emphasis is preserved exactly. Editing the source draft, changing its approval, or reconnecting cancels its queued version.</p>
      <label htmlFor="publish-draft">Saved draft</label><select id="publish-draft" value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setReview(null); }}><option value="">Choose a draft</option>{stories.map((story) => <option key={story.id} value={story.id}>{story.title || 'Untitled draft'}</option>)}</select>
      <label htmlFor="publish-audience">Audience</label><select id="publish-audience" value={visibility} disabled={busy} onChange={(event) => { setVisibility(event.target.value as 'PUBLIC' | 'CONNECTIONS'); setReview(null); }}><option value="PUBLIC">Public · anyone on LinkedIn</option><option value="CONNECTIONS">Your first-degree connections</option></select>
      {status?.readiness.schedulerVerified && <>
        <label htmlFor="publish-mode">When to publish</label><select id="publish-mode" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as 'now' | 'scheduled'); setReview(null); }}><option value="now">Publish now</option><option value="scheduled">Schedule a time</option></select>
        {mode === 'scheduled' && <><label htmlFor="publish-time">Date and time in your browser’s timezone</label><input id="publish-time" type="datetime-local" value={scheduledAt} disabled={busy} onChange={(event) => { setScheduledAt(event.target.value); setReview(null); }} /><p className="sb-pub-small">The final review shows the exact timezone and offset. If delivery is more than 15 minutes late, the post is cancelled, not sent unexpectedly.</p></>}
      </>}
      <button disabled={busy || !selected || connection?.status !== 'connected' || !status?.readiness.publishingEnabled} onClick={() => void prepare()}>Review exact LinkedIn version</button>
      {!status?.readiness.publishingEnabled && <p className="sb-pub-notice">Live posting is disabled. This page does not pretend a draft has been published.</p>}
      {review && <div className="sb-pub-review" aria-live="polite"><h3>Final review</h3><p><strong>{review.snapshot.displayName}</strong><br />{review.snapshot.author}<br />Audience: {review.snapshot.visibility === 'PUBLIC' ? 'Public' : 'First-degree connections'} · {review.snapshot.mode === 'scheduled' ? 'Scheduled publication' : 'Publish now'} · Revision {review.snapshot.sourceRevision}</p>{review.snapshot.mode === 'scheduled' && <p>Time: {review.publication.dueAt}<br />Timezone: {review.snapshot.timeZone}<br />UTC instant: {review.snapshot.dueAt}<br />You authorize this exact version to be sent automatically at this time. Delivery is best effort; more than 15 minutes late means cancellation.</p>}<pre>{review.snapshot.text}</pre><p>This exact text will be sent to LinkedIn. Check every claim and make sure you want to share it with this audience.</p><div className="sb-pub-actions"><button disabled={busy} onClick={() => void publish()}>{review.snapshot.mode === 'scheduled' ? 'Schedule exactly this version' : 'Publish exactly this version'}</button><button className="secondary" disabled={busy} onClick={() => setReview(null)}>Go back</button></div></div>}
    </section>
    <section className="sb-pub-card"><h2>Automatic scheduling</h2><p>{status?.readiness.scheduling || 'Checking scheduler readiness…'}</p><p>Your studio’s content calendar remains a manual plan, not a scheduled LinkedIn publication. {status?.readiness.schedulerVerified ? 'Only the separate final scheduling review above creates an automatic publication.' : 'You can copy a reviewed post and use LinkedIn’s own scheduler.'}</p></section>
    <section className="sb-pub-card"><h2>Publication history</h2><p>Uncertain outcomes are never automatically retried. Check LinkedIn manually if a result is marked unknown.</p>
      {!status?.jobs.length ? <p>No publications have been requested.</p> : <ul className="sb-pub-jobs">{status.jobs.map((job) => <li key={job.id}><strong>{job.status === 'unknown' ? 'Unknown · check LinkedIn before retrying' : job.status}</strong><span>{new Date(job.created_at).toLocaleString()} · {job.snapshot.displayName}</span><p>{job.snapshot.text.slice(0, 180)}{job.snapshot.text.length > 180 ? '…' : ''}</p>{job.reason && <small>{job.reason.replaceAll('_', ' ')}</small>}{job.post_urn && <p>LinkedIn post ID: {job.post_urn}</p>}{job.status === 'queued' && <button className="secondary" disabled={busy} onClick={() => void act(async () => { await request('/api/linkedin/cancel', { jobId: job.id }); await refresh(); })}>Cancel queued version</button>}</li>)}</ul>}
    </section>
  </main>;
}
