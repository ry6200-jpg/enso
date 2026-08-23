/**
 * Mobile layout and scroll fixes batch: pure, browser-independent scroll-
 * pinning logic, pulled out of app/page.tsx specifically so it's FAST-
 * testable — everything else this batch touches (ResizeObserver wiring,
 * actual scrollTop assignment, textarea auto-grow via scrollHeight) needs
 * a real DOM and is verified by browser instead, per this batch's own
 * instruction not to invent tests for behavior a browser is the only
 * honest way to check.
 */

/** Distance-from-bottom threshold (px) below which the user is considered "at the bottom" — new messages auto-scroll into view. Past this, they've deliberately scrolled up to read history, and auto-scroll must not interrupt that. */
export const AUTO_SCROLL_THRESHOLD_PX = 80;

/**
 * True when the scrollable message list is close enough to its bottom
 * edge that a new message should auto-scroll into view. Measured as
 * distance from the BOTTOM, not scroll position from the top, so it's
 * independent of how tall the transcript is — a long history scrolled to
 * its end and a short one both read as "pinned" the same way.
 */
export function isPinnedToBottom(scrollTop: number, scrollHeight: number, clientHeight: number, thresholdPx: number = AUTO_SCROLL_THRESHOLD_PX): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return distanceFromBottom <= thresholdPx;
}
