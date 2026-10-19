import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptPace",
  description: "Local spend and runaway-loop guard for AI coding tools",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
