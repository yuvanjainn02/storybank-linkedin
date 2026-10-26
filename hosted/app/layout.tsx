import type { Metadata } from 'next';
import './studio.css';
export const metadata: Metadata = {
  title: 'StoryBank tester · Your own writing workspace',
  description: 'Sign in with ChatGPT for your StoryBank workspace. LinkedIn account connection is a separate permission step.',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><aside role="note" aria-label="Public manual writing trial" style={{ padding: '12px 20px', background: '#fff2c6', color: '#272d24', borderBottom: '1px solid #bda96a', fontSize: '14px', lineHeight: 1.5 }}><strong>Public manual writing trial.</strong> Sign in for your own workspace. Use synthetic test content only. Copy a reviewed writing brief to your own ChatGPT conversation, then paste the draft back here. No automatic AI, transcription, creator research, LinkedIn publishing or delivery of scheduled posts is active.</aside>{children}</body></html>;
}
