import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { handleAudioRequest } from '../../../../../server/hosted-audio.mjs';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return handleAudioRequest(request, { user: await getChatGPTUser(), db: env.DB, env, bucket: env.BUCKET, allowLocalDevelopment: import.meta.env.DEV });
}
export const GET = handle;
export const DELETE = handle;
