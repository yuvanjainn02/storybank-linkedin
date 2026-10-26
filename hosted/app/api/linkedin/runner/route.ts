import { env } from 'cloudflare:workers';
import { handleLinkedInRunnerRequest } from '../../../../../server/linkedin-runner.mjs';
export const dynamic = 'force-dynamic';
// No visitor identity is synthesized from request headers. The separate runner
// capability is bound to one server-configured owner, even on a public Site.
export async function POST(request: Request) {
  return handleLinkedInRunnerRequest(request, { db: env.DB, env });
}
