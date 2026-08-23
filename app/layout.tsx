import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enso",
  description: "A private relationship journal with an AI companion."
};

/**
 * Mobile layout fix batch: `interactiveWidget: "resizes-content"` is what
 * makes the on-screen keyboard actually resize the layout instead of
 * overlaying it (the default `resizes-visual` leaves the LAYOUT viewport —
 * and therefore this page's `h-dvh` — untouched while only the VISUAL
 * viewport shrinks, which is exactly how a fixed-flex-flow bottom input row
 * ends up hidden behind the keyboard on iOS Safari). Combined with `h-dvh`
 * below (not `h-full`/`100%`, which historically resolves against the
 * layout viewport and doesn't react to a live keyboard/toolbar change at
 * all), the browser itself keeps the header/input pinned and the message
 * list as the one scrolling region with no JS resize listener needed —
 * confirmed live via a simulated visualViewport resize (real hardware
 * keyboard behavior can't be driven from this environment; see the mobile
 * layout report for exactly what was and wasn't verified).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content"
};

/**
 * `h-dvh` (not `h-full`) on <html>, `h-dvh flex flex-col overflow-hidden`
 * on <body> — EN-036's original fix used `h-full`, which is a fine, stable
 * cap on desktop but doesn't participate in a mobile browser's dynamic
 * viewport (address bar show/hide, keyboard open/close) at all; `h-dvh`
 * does, and is what makes the keyboard-safe behavior above actually take
 * effect. The chat page's message list still depends on this being a
 * hard, page-level cap so IT scrolls (flex-1 min-h-0 overflow-y-auto)
 * while the header/composer stay pinned, rather than the whole page
 * scrolling as one unit.
 *
 * Mobile layout and scroll fixes batch: `overflow-hidden` added here is
 * the root of that same shell — the document itself must never scroll as
 * a whole; the message list inside app/page.tsx is the ONLY scroll
 * container on the page. Without this, a momentary height mismatch during
 * composer growth or a keyboard transition could let the whole page
 * rubber-band, which is exactly the kind of "scroll into a broken-looking
 * half-state" this batch exists to close off.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-dvh antialiased">
      <body className="h-dvh flex flex-col overflow-hidden">{children}</body>
    </html>
  );
}
