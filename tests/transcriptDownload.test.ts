import { describe, expect, it, vi } from "vitest";
import { downloadTranscript, extractDownloadFilename } from "../app/lib/transcriptDownload.js";

function fakeResponse(opts: { ok: boolean; status?: number; contentDisposition?: string | null; blob?: Blob }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    headers: new Headers(opts.contentDisposition ? { "Content-Disposition": opts.contentDisposition } : {}),
    blob: async () => opts.blob ?? new Blob(["transcript text"], { type: "text/plain" })
  } as unknown as Response;
}

describe("downloadTranscript (production bug batch, item 5 follow-up: download button)", () => {
  it("calls the export endpoint through the injected authenticated fetch wrapper — never a plain, unauthenticated fetch", async () => {
    const authFetch = vi.fn().mockResolvedValue(fakeResponse({ ok: true, contentDisposition: 'attachment; filename="enso-transcript-2026-08-24.txt"' }));
    const triggerDownload = vi.fn();

    await downloadTranscript({ authFetch, triggerDownload });

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith("/api/export?format=txt");
  });

  it("hands the response blob and the server's own filename to triggerDownload on success", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const authFetch = vi.fn().mockResolvedValue(fakeResponse({ ok: true, contentDisposition: 'attachment; filename="enso-transcript-2026-08-24.txt"', blob }));
    const triggerDownload = vi.fn();

    await downloadTranscript({ authFetch, triggerDownload });

    expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(triggerDownload).toHaveBeenCalledWith(blob, "enso-transcript-2026-08-24.txt");
  });

  it("a failed request (non-OK response) throws a real, readable error rather than failing silently", async () => {
    const authFetch = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 401 }));
    const triggerDownload = vi.fn();

    await expect(downloadTranscript({ authFetch, triggerDownload })).rejects.toThrow(/401/);
    expect(triggerDownload).not.toHaveBeenCalled();
  });

  it("a network-level failure (authFetch itself rejects, e.g. signed out) also propagates rather than being swallowed", async () => {
    const authFetch = vi.fn().mockRejectedValue(new Error("authFetch called with no signed-in user."));
    const triggerDownload = vi.fn();

    await expect(downloadTranscript({ authFetch, triggerDownload })).rejects.toThrow(/no signed-in user/);
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});

describe("extractDownloadFilename", () => {
  it("reads the filename out of a real Content-Disposition header", () => {
    expect(extractDownloadFilename('attachment; filename="enso-transcript-2026-08-24.txt"')).toBe("enso-transcript-2026-08-24.txt");
  });

  it("reads the json-format filename just as well", () => {
    expect(extractDownloadFilename('attachment; filename="enso-transcript-2026-08-24.json"')).toBe("enso-transcript-2026-08-24.json");
  });

  it("falls back to a plain default when the header is absent", () => {
    expect(extractDownloadFilename(null)).toBe("enso-transcript.txt");
  });

  it("falls back to a plain default when the header is present but has no filename in it", () => {
    expect(extractDownloadFilename("attachment")).toBe("enso-transcript.txt");
  });
});
