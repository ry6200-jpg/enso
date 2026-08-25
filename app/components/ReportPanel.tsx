"use client";

import { useState } from "react";
import { authFetch } from "../lib/firebaseClient";

/**
 * Report page (enso-report-methodology.md, EN-120/121). Reached from the
 * chat header's kebab menu. Read-only against the corpus — this panel
 * only ever calls POST /api/report, which itself reads the event log and
 * projections and never writes to either (the report is not part of the
 * corpus, methodology Section 6 Q2).
 *
 * Prose is the page — see EN-120's own instruction set (proseInstructions.ts)
 * for why: numbers may only ever be the reason a passage exists, never its
 * content. This component renders exactly what the server hands back —
 * prose text plus, behind a drill-down, the real messages each passage is
 * grounded in — and adds no numbers, labels, or framing of its own that
 * the prose layer was built specifically to avoid.
 */

interface ReportTopicView {
  id: string;
  entityName: string | null;
  sourceMessages: { id: string; recordedAt: string; text: string }[];
}

interface ReportPassageView {
  text: string;
  topics: ReportTopicView[];
}

interface ReportProseView {
  passages: ReportPassageView[];
  noTopicsEligible: boolean;
}

type Phase = "start" | "loading" | "result" | "notEnoughData" | "error";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Drill-down: what a passage is built on. Deduped across the passage's own topics — the same message can back more than one. */
function DrillDown({ topics }: { topics: ReportTopicView[] }) {
  const [open, setOpen] = useState(false);
  const messagesById = new Map<string, { id: string; recordedAt: string; text: string }>();
  for (const topic of topics) for (const m of topic.sourceMessages) messagesById.set(m.id, m);
  const messages = [...messagesById.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const names = [...new Set(topics.map((t) => t.entityName).filter((n): n is string => n !== null))];

  return (
    <div className="text-xs mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-stone-400 underline decoration-dotted hover:text-stone-700">
        What this is built on ({messages.length} message{messages.length === 1 ? "" : "s"})
      </button>
      {open && (
        <div className="mt-1 ml-3 border-l border-stone-200 pl-3 space-y-1 max-h-48 overflow-y-auto">
          {names.length > 0 && <div className="text-stone-400">Concerns: {names.join(", ")}</div>}
          <ul className="space-y-1">
            {messages.map((m) => (
              <li key={m.id} className="text-stone-500">
                <span className="text-stone-400">{formatDate(m.recordedAt)}:</span> {m.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ReportPanel({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("start");
  const [prose, setProse] = useState<ReportProseView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setPhase("loading");
    setError(null);
    try {
      const timezone = (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return "UTC";
        }
      })();
      const res = await authFetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timezone }) });
      if (!res.ok) throw new Error(`Report generation failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { displayable: boolean; prose?: ReportProseView };
      if (!json.displayable) {
        setPhase("notEnoughData");
        return;
      }
      setProse(json.prose ?? null);
      setPhase("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate the report. Try again.");
      setPhase("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-white rounded-lg max-w-2xl w-full shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <h2 className="font-semibold text-stone-800">Report</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none" title="Close">
            ×
          </button>
        </div>

        <div className="p-5 space-y-5">
          {phase === "start" && (
            <div className="space-y-3">
              <button type="button" onClick={() => void handleGenerate()} className="rounded bg-stone-800 text-white text-sm px-4 py-2 hover:bg-stone-700">
                Generate report
              </button>
            </div>
          )}

          {phase === "loading" && <p className="text-sm text-stone-500">Reading back through everything...</p>}

          {phase === "error" && (
            <div className="space-y-3">
              <p className="text-sm text-red-600">{error}</p>
              <button type="button" onClick={() => setPhase("start")} className="text-sm text-stone-600 underline">
                Back
              </button>
            </div>
          )}

          {phase === "notEnoughData" && <p className="text-sm text-stone-500">There's no message history yet to build a report from.</p>}

          {phase === "result" && prose && (prose.noTopicsEligible || prose.passages.length === 0) && <p className="text-sm text-stone-500">There isn't enough history yet to say anything real.</p>}

          {phase === "result" && prose && prose.passages.length > 0 && (
            <div className="space-y-5">
              {prose.passages.map((passage, i) => (
                <div key={i} className="space-y-1">
                  <p className="text-sm text-stone-700 leading-relaxed">{passage.text}</p>
                  <DrillDown topics={passage.topics} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
