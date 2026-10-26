import { BookOpen } from 'lucide-react';

export default function TesterWelcome({ signInPath }: { signInPath: string }) {
  return <main className="sb-session" aria-labelledby="tester-welcome-title">
    <BookOpen size={34} />
    <h1 id="tester-welcome-title">Your StoryBank testing workspace</h1>
    <p>This hosted app uses ChatGPT sign-in first to open your StoryBank workspace.</p>
    <p>For this manual trial, save an experience, open Draft studio, and create a draft. “Write with your own ChatGPT conversation” prepares a brief you can review and copy. Paste your chosen response back into the draft editor, check it, and save. StoryBank never sends the brief automatically.</p>
    <a className="sb-btn" href={signInPath} target="_top">Sign in to StoryBank with ChatGPT</a>
    <p>Connecting your LinkedIn account is a separate step, using LinkedIn’s official permission screen when connection setup is available. Signing in here does not grant posting access.</p>
    <p>StoryBank never asks you to enter a LinkedIn password, session cookie, or API secret. An entered profile URL is only a bookmark.</p>
  </main>;
}
