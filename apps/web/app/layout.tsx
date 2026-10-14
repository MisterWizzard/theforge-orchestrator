import type { Metadata, Viewport } from 'next';
import './styles.css';
export const metadata: Metadata = {
  title: 'TheForge — Autonomous build control centre',
  description: 'Turn objectives into verified, reviewable completed work.',
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};
// The rail and navigation live in `(shell)/layout.tsx`, so `/login` renders
// without them; this root layout is the document only.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
