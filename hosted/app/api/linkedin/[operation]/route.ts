import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { handleLinkedInRequest } from '../../../../../server/linkedin-http.mjs';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return handleLinkedInRequest(request, { user: await getChatGPTUser(), db: env.DB, env, allowLocalDevelopment: import.meta.env.DEV });
}
export const GET = handle;
export const POST = handle;
