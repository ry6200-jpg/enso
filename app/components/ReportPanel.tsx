"use client";

import { useState } from "react";
import { authFetch } from "../lib/firebaseClient";
import { WORD_CLASS_LABELS, type WordClass } from "../../src/report/wordClasses";

/**
 * Report page, Stage A (enso-report-methodology.md). Reached from the
 * chat header's kebab menu. Read-only against the corpus — this panel
 * only ever calls POST/GET /api/report, which itself reads the event log
 * and projections and never writes to either (the report is not part of
 * the corpus, methodology Section 6 Q2).
 *
 * Ordering deliberately matches what THIS corpus (~10 words/message, a
 * chat rhythm, not journal entries) actually supports: network and
 * temporal markers first — exact at any message length, the substance of
 * the page — word-class rates last, each annotated with the word count
 * it was computed from, so the thinness of that basis is never hidden.
 */

interface WordClassRateView {
  wordClass: WordClass;
  count: number;
  rate: number;
}

interface WindowNetworkView {
  windowIndex: number;
  activeTieCount: number;
  newEntityCount: number;
  turnover: number | null;
  mentionConcentrationHhi: number | null;
}

interface DormancyView {
  entityId: string;
  name: string;
  lastMentionAt: string;
  daysSinceLastMention: number;
  dormant: boolean;
}

interface ReportViewModel {
  generatedAt: string;
  windowDays: number;
  corpus: { totalMessages: number; firstMessageAt: string | null; lastMessageAt: string | null };
  network: {
    perWindow: WindowNetworkView[];
    dormancy: DormancyView[];
    tieComposition: { relationshipClass: string; count: number }[];
    alterDensity: number | null;
  };
  temporal: {
    sessions: { messageCount: number; start: string; end: string; durationMinutes: number }[];
    burstiness: number | null;
    messageLength: { meanWords: number; medianWords: number; stdevWords: number; minWords: number; maxWords: number };
  };
  wordClasses: { windowIndex: number; totalWords: number; rates: WordClassRateView[] }[];
  windows: { index: number; start: string; end: string; messages: { id: string; recordedAt: string; text: string }[] }[];
  baselines: { windowIndex: number; activeTieCount: { priorWindowCount: number; baseline: { mean: number; stdev: number; deviationInStdevs: number | null } | null } }[];
}

type Phase = "start" | "loading" | "result" | "notEnoughData" | "error";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function DrillDown({ label, messages }: { label: string; messages: { id: string; recordedAt: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-stone-500 underline decoration-dotted hover:text-stone-800">
        {label} ({messages.length} message{messages.length === 1 ? "" : "s"})
      </button>
      {open && (
        <ul className="mt-1 ml-3 border-l border-stone-200 pl-3 space-y-1 max-h-48 overflow-y-auto">
          {messages.map((m) => (
            <li key={m.id} className="text-stone-500">
              <span className="text-stone-400">{formatDate(m.recordedAt)}:</span> {m.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ReportPanel({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("start");
  const [report, setReport] = useState<ReportViewModel | null>(null);
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
      const json = (await res.json()) as { displayable: boolean; report?: ReportViewModel };
      if (!json.displayable) {
        setPhase("notEnoughData");
        return;
      }
      setReport(json.report ?? null);
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

          {phase === "loading" && <p className="text-sm text-stone-500">Computing...</p>}

          {phase === "error" && (
            <div className="space-y-3">
              <p className="text-sm text-red-600">{error}</p>
              <button type="button" onClick={() => setPhase("start")} className="text-sm text-stone-600 underline">
                Back
              </button>
            </div>
          )}

          {phase === "notEnoughData" && <p className="text-sm text-stone-500">Not enough data yet — there's no message history to compute a report from.</p>}

          {phase === "result" && report && (
            <div className="space-y-6">
              <div className="text-xs text-stone-400">
                {report.corpus.totalMessages} messages, {formatDate(report.corpus.firstMessageAt!)} – {formatDate(report.corpus.lastMessageAt!)}. Windowed at {report.windowDays} day{report.windowDays === 1 ? "" : "s"}.
              </div>

              <section className="space-y-2">
                <h3 className="font-medium text-stone-800 text-sm">Network</h3>
                {report.network.tieComposition.length === 0 && <p className="text-sm text-stone-400">No established relationships on record yet.</p>}
                {report.network.tieComposition.length > 0 && (
                  <ul className="text-sm text-stone-600">
                    {report.network.tieComposition.map((t) => (
                      <li key={t.relationshipClass}>{t.relationshipClass}: {t.count}</li>
                    ))}
                  </ul>
                )}
                {report.network.alterDensity !== null && <p className="text-sm text-stone-600">Density among your people: {(report.network.alterDensity * 100).toFixed(0)}%</p>}
                {report.network.dormancy.filter((d) => d.dormant).length > 0 && (
                  <div className="text-sm text-stone-600">
                    Dormant (no mention in {Math.floor(report.network.dormancy[0]!.daysSinceLastMention)}+ days):
                    <ul className="ml-3 list-disc">
                      {report.network.dormancy.filter((d) => d.dormant).map((d) => (
                        <li key={d.entityId}>{d.name} — last mentioned {formatDate(d.lastMentionAt)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.network.perWindow.map((w, i) => {
                  const window = report.windows.find((win) => win.index === w.windowIndex);
                  const baseline = report.baselines.find((b) => b.windowIndex === w.windowIndex)?.activeTieCount;
                  return (
                    <div key={w.windowIndex} className="text-sm text-stone-600 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span>Window {i + 1}: {w.activeTieCount} active tie{w.activeTieCount === 1 ? "" : "s"}, {w.newEntityCount} new</span>
                        {window && <DrillDown label={formatDate(window.start)} messages={window.messages} />}
                      </div>
                      <div className="text-xs text-stone-400">
                        {baseline?.baseline
                          ? `vs. your own baseline: ${baseline.baseline.deviationInStdevs !== null ? `${baseline.baseline.deviationInStdevs.toFixed(1)}σ from your usual ${baseline.baseline.mean.toFixed(1)}` : `usual is ${baseline.baseline.mean.toFixed(1)}, no variation to compare against`} (${baseline.priorWindowCount} prior windows)`
                          : `not enough historical data for a baseline yet (${baseline?.priorWindowCount ?? 0} prior window${(baseline?.priorWindowCount ?? 0) === 1 ? "" : "s"})`}
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-stone-800 text-sm">Temporal</h3>
                <p className="text-sm text-stone-600">{report.temporal.sessions.length} session{report.temporal.sessions.length === 1 ? "" : "s"}</p>
                {report.temporal.burstiness !== null && <p className="text-sm text-stone-600">Burstiness: {report.temporal.burstiness.toFixed(2)} (0 = regular, toward 1 = bursty)</p>}
                <p className="text-sm text-stone-600">
                  Message length: {report.temporal.messageLength.meanWords.toFixed(1)} words avg (median {report.temporal.messageLength.medianWords}, range {report.temporal.messageLength.minWords}–{report.temporal.messageLength.maxWords})
                </p>
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-stone-800 text-sm">Word-class rates</h3>
                <p className="text-xs text-stone-400">A direction to look, not a conclusion — noisy at this corpus's message length. Word count shown for each window so the basis is never hidden.</p>
                {report.wordClasses.map((wc, i) => (
                  <div key={wc.windowIndex} className="text-sm text-stone-600">
                    <div className="text-xs text-stone-400">Window {i + 1} — {wc.totalWords} words</div>
                    <ul className="ml-3">
                      {wc.rates.map((r) => (
                        <li key={r.wordClass}>
                          {WORD_CLASS_LABELS[r.wordClass]}: {(r.rate * 100).toFixed(1)}% ({r.count})
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
