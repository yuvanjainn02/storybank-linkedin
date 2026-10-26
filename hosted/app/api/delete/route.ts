import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { handleHostedRequest, jsonResponse } from '../../../../server/hosted-http.mjs';
import { cleanupOwnerAudio } from '../../../../server/hosted-audio.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  const response = await handleHostedRequest(request, { user, db: env.DB, env, allowLocalDevelopment: import.meta.env.DEV });
  if (!response.ok) return response;
  const data = await response.json() as Record<string, unknown>;
  try {
    const audioCleanup = await cleanupOwnerAudio({ user, db: env.DB, bucket: env.BUCKET });
    const pendingAudioCleanup = audioCleanup.remaining > 0 || audioCleanup.failures.length > 0;
    return jsonResponse({ ...data, audioCleanup, pendingAudioCleanup }, pendingAudioCleanup ? 202 : 200);
  } catch {
    return jsonResponse({ ...data, pendingAudioCleanup: true, audioCleanup: { deleted: null, remaining: null }, message: 'Writing data was cleared. Recording cleanup could not be confirmed; please retry workspace deletion.' }, 202);
  }
}
