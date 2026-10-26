import { requireChatGPTUser } from '../chatgpt-auth';
import { personalWorkspaceId } from '../../../server/hosted-d1.mjs';
import LinkedInPublishing from '../../components/LinkedInPublishing';
export const dynamic = 'force-dynamic';
export default async function PublishingPage() {
  const user = await requireChatGPTUser('/publishing');
  const workspaceKey = personalWorkspaceId(user.userId);
  // A different signed-in owner must never inherit private review/form state.
  return <LinkedInPublishing key={workspaceKey} workspaceKey={workspaceKey} />;
}
