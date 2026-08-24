/**
 * "Download my transcript" button (production bug batch, item 5 follow-up):
 * pure, browser-independent logic for calling GET /api/export and handing
 * the result off to be saved, pulled out of app/page.tsx specifically so
 * it's FAST-testable — same discipline as app/lib/chatScroll.ts. The actual
 * DOM side effect (blob URL creation, a synthetic <a>/click, revoking the
 * URL) needs a real browser and stays in page.tsx, browser-verified.
 *
 * `authFetch` is injected rather than imported directly from
 * firebaseClient.ts, so a test can supply a fake one with no real
 * Firebase/network dependency — the real caller always passes the app's one
 * true authenticated-fetch wrapper (no new auth pattern invented here).
 */
export interface DownloadTranscriptDeps {
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
  triggerDownload: (blob: Blob, filename: string) => void;
}

const DEFAULT_TRANSCRIPT_FILENAME = "enso-transcript.txt";

/** Reads the filename the export route itself already decided (Content-Disposition), rather than a second, client-side naming scheme that could drift from it. Falls back to a plain default only if the header is missing or unparseable. */
export function extractDownloadFilename(contentDisposition: string | null): string {
  if (!contentDisposition) return DEFAULT_TRANSCRIPT_FILENAME;
  const match = /filename="([^"]+)"/.exec(contentDisposition);
  return match?.[1] ?? DEFAULT_TRANSCRIPT_FILENAME;
}

/**
 * Fetches the plain-text transcript export and hands it to `triggerDownload`.
 * Never fails silently: a non-OK response throws a plain, readable Error
 * for the caller to surface, rather than downloading nothing with no
 * explanation.
 */
export async function downloadTranscript(deps: DownloadTranscriptDeps): Promise<void> {
  const res = await deps.authFetch("/api/export?format=txt");
  if (!res.ok) {
    throw new Error(`Couldn't download your transcript (HTTP ${res.status}). Try again in a moment.`);
  }
  const blob = await res.blob();
  const filename = extractDownloadFilename(res.headers.get("Content-Disposition"));
  deps.triggerDownload(blob, filename);
}
