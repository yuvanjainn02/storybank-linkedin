import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { handleHostedRequest } from '../../../../server/hosted-http.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleHostedRequest(request, { user: await getChatGPTUser(), db: env.DB, env, allowLocalDevelopment: import.meta.env.DEV });
}
