import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enso",
  description: "A private relationship journal with an AI companion."
};

/**
 * `h-full` (not `min-h-full`) on <html>, `h-full flex flex-col` on <body>
 * — EN-036's exact fix: the chat page's message list depends on this being
 * a hard cap so IT scrolls (flex-1 overflow-y-auto) while the input bar
 * stays pinned below it, rather than the whole page scrolling as one unit.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full flex flex-col">{children}</body>
    </html>
  );
}
