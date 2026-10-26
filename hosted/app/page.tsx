import { getChatGPTUser, chatGPTSignInPath } from './chatgpt-auth';
import Studio from './Studio';
import TesterWelcome from '../components/TesterWelcome';
import { personalWorkspaceId } from '../../server/hosted-d1.mjs';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) return <TesterWelcome signInPath={chatGPTSignInPath('/')} />;
  // Reset private forms, audio and review state across authenticated owners.
  const workspaceKey = personalWorkspaceId(user.userId);
  return <Studio key={workspaceKey} expectedWorkspaceKey={workspaceKey} />;
}
