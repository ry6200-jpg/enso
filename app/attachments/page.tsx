"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface UploadItem {
  uploadEventId: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  extractionStatus: "pending" | "completed" | "failed";
}

interface DeletionImpact {
  uploadEventId: string;
  filename: string;
  removedFactCount: number;
  preservedFactCount: number;
}

/**
 * EN-065: the uploads-list-plus-deletion surface that didn't exist at all
 * before this — there was no way to even see what you'd uploaded, let
 * alone delete one. Its own route, consistent with how People/Horoscope
 * worked before their removal (batch 2, item 6) — not crowded into the
 * chat page. Reached via a small, deliberately unobtrusive link next to
 * the attachment button in app/page.tsx, rather than reintroducing a nav
 * row of the kind that was just removed.
 *
 * One click, inline, no multi-screen wizard (EN-065's explicit
 * requirement): clicking Delete reveals a dry-run preview ("This will
 * also remove N facts...") in the SAME row; Confirm performs the real
 * deletion. Both calls hit routes backed by the identical
 * computeDeletionImpact function (src/attachments/uploadDeletion.ts), so
 * the preview can never promise something deletion doesn't actually do.
 */
export default function AttachmentsPage() {
  const [uploads, setUploads] = useState<UploadItem[] | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function loadUploads() {
    fetch("/api/attachments")
      .then((r) => r.json())
      .then((json: { uploads: UploadItem[] }) => setUploads(json.uploads))
      .catch(() => setUploads([]));
  }

  useEffect(loadUploads, []);

  async function startPreview(uploadEventId: string) {
    setPreviewFor(uploadEventId);
    setImpact(null);
    setLoadingPreview(true);
    const res = await fetch(`/api/attachments/${uploadEventId}/deletion-impact`);
    const json = await res.json();
    setLoadingPreview(false);
    if (res.ok) setImpact(json);
  }

  function cancelPreview() {
    setPreviewFor(null);
    setImpact(null);
  }

  async function confirmDelete(uploadEventId: string) {
    setDeleting(true);
    await fetch(`/api/attachments/${uploadEventId}`, { method: "DELETE" });
    setDeleting(false);
    setPreviewFor(null);
    setImpact(null);
    loadUploads();
  }

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-stone-200">
        <Link href="/" className="text-sm text-stone-500">
          ← Chat
        </Link>
        <span className="text-lg font-bold" style={{ color: "var(--enso-ink)" }}>
          Attachments
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-2xl mx-auto w-full flex flex-col gap-3">
        {uploads === null && <p className="text-sm text-stone-400">Loading...</p>}
        {uploads?.length === 0 && <p className="text-sm text-stone-400">No files uploaded yet.</p>}
        {uploads?.map((u) => (
          <div key={u.uploadEventId} className="border border-stone-200 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium truncate">{u.filename}</div>
                <div className="text-xs text-stone-400">
                  {new Date(u.uploadedAt).toLocaleString()} · {u.extractionStatus}
                </div>
              </div>
              {previewFor !== u.uploadEventId && (
                <button
                  onClick={() => startPreview(u.uploadEventId)}
                  className="shrink-0 text-sm text-stone-500 border border-stone-300 rounded px-3 py-1.5 hover:bg-stone-100"
                >
                  Delete
                </button>
              )}
            </div>

            {previewFor === u.uploadEventId && (
              <div className="mt-3 border-t border-stone-100 pt-3">
                {loadingPreview && <p className="text-sm text-stone-400">Checking what this affects...</p>}
                {impact && (
                  <>
                    <p className="text-sm text-stone-600">
                      {impact.removedFactCount > 0
                        ? `This will also remove ${impact.removedFactCount} fact${impact.removedFactCount === 1 ? "" : "s"} learned only from this file.`
                        : "No facts depend solely on this file."}
                      {impact.preservedFactCount > 0 &&
                        ` ${impact.preservedFactCount} associated fact${impact.preservedFactCount === 1 ? "" : "s"} will be preserved.`}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => confirmDelete(u.uploadEventId)}
                        disabled={deleting}
                        className="text-sm text-white rounded px-3 py-1.5 disabled:opacity-50"
                        style={{ backgroundColor: "var(--enso-red)" }}
                      >
                        Confirm delete
                      </button>
                      <button onClick={cancelPreview} className="text-sm text-stone-500 border border-stone-300 rounded px-3 py-1.5">
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
