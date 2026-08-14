import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'PromptPace | Speed Control & Auto-Debit Shield for Autonomous AI Agents',
  description:
    'Real-time proxy speed governor and trip budget shield for Claude Code, Grok, and autonomous AI agents. Prevents death loops and unwanted Stripe auto-debits.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark`}>
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
