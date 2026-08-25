import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "../projections/db.js";
import type { MessageSentPayload } from "../capture/messageCapture.js";
import { computeReportWindows, getReportWindowDays, type ReportWindow, type ReportWindowMessage } from "./reportWindows.js";
import { computeWordClassMarkers, type WordClassWindowResult } from "./markers/wordClassMarkers.js";
import { computeNetworkMarkers, type NetworkMarkers } from "./markers/networkMarkers.js";
import { computeTemporalMarkers, type TemporalMarkers } from "./markers/temporalMarkers.js";
import { computeBaseline, type BaselineResult } from "./markers/baseline.js";
import { ALL_WORD_CLASSES, type WordClass } from "./wordClasses.js";

/**
 * Report page, Stage A orchestrator — the one function the route calls.
 * Pure with respect to its inputs (an EventLog/ProjectionsDb it only ever
 * READS, per this batch's own instruction: the report reads the event
 * log and projections and must never write to them, since it is not
 * part of the corpus, methodology Section 6 Q2). FAST-testable directly
 * against a seeded EventLog/ProjectionsDb, no route/HTTP layer needed.
 */

export interface CorpusSpan {
  totalMessages: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface WindowMarkerBaselines {
  windowIndex: number;
  activeTieCount: BaselineResult;
  mentionConcentrationHhi: BaselineResult | null;
  lexicalDiversityTypeTokenRatio: BaselineResult;
  wordClassRates: { wordClass: WordClass; baseline: BaselineResult }[];
}

export interface ReportResult {
  generatedAt: string;
  windowDays: number;
  corpus: CorpusSpan;
  network: NetworkMarkers;
  temporal: TemporalMarkers;
  wordClasses: WordClassWindowResult[];
  /** One entry per window — null/no-baseline fields mean "not enough prior windows yet," never a fabricated trend. */
  baselines: WindowMarkerBaselines[];
  /** methodology Section 4.3, falsifiability spot-check: every displayed line drills down to the actual events it was computed from. Message text included — this is the owner viewing their own report about their own data, not a third party. */
  windows: { index: number; start: string; end: string; messages: ReportWindowMessage[] }[];
}

/** Below this, Stage A shows an honest "not enough data yet" rather than any of the above. */
export function hasAnyDisplayableData(eventLog: EventLog, userId: string): boolean {
  return eventLog.listForUser(userId).some((e) => e.type === "message_sent");
}

function toReportMessages(eventLog: EventLog, userId: string): ReportWindowMessage[] {
  // Methodology Section 1: "The user's own message_sent events only. Enso's replies are excluded
  // from ALL marker computation" — every marker below, network/temporal/word-class alike, is
  // computed only from what the owner themselves wrote.
  return eventLog
    .listForUser(userId)
    .filter((e) => e.type === "message_sent")
    .map((e) => ({ id: e.id, recordedAt: e.recordedAt, text: (e.payload as MessageSentPayload).text }));
}

/** Network markers for exactly one window, reusing computeNetworkMarkers rather than a second implementation — used for baseline computation, where each prior window needs its own scalar value. */
function networkForWindow(projections: ProjectionsDb, userId: string, window: ReportWindow, recordedAtByMessageId: Map<string, string>, now: string) {
  return computeNetworkMarkers(projections, userId, [window], recordedAtByMessageId, now).perWindow[0]!;
}

export function computeReport(eventLog: EventLog, projections: ProjectionsDb, userId: string, timezone: string, now: string = new Date().toISOString(), windowDays: number = getReportWindowDays()): ReportResult {
  const messages = toReportMessages(eventLog, userId);
  const recordedAtByMessageId = new Map(messages.map((m) => [m.id, m.recordedAt]));

  const windows = computeReportWindows(messages, windowDays);
  const sortedByRecordedAt = [...messages].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  const corpus: CorpusSpan = {
    totalMessages: messages.length,
    firstMessageAt: sortedByRecordedAt[0]?.recordedAt ?? null,
    lastMessageAt: sortedByRecordedAt[sortedByRecordedAt.length - 1]?.recordedAt ?? null
  };

  const network = computeNetworkMarkers(projections, userId, windows, recordedAtByMessageId, now);
  const temporal = computeTemporalMarkers(messages, windows, timezone);
  const wordClasses = windows.map((w) => computeWordClassMarkers(w));

  const baselines: WindowMarkerBaselines[] = windows.map((window, i) => {
    const priorWindows = windows.slice(0, i);

    const currentNetwork = network.perWindow[i]!;
    const priorNetwork = priorWindows.map((w) => networkForWindow(projections, userId, w, recordedAtByMessageId, now));

    const priorHhi = priorNetwork.map((n) => n.mentionConcentrationHhi).filter((v): v is number => v !== null);

    const priorTtr = priorWindows.map((w) => computeTemporalMarkers(w.messages, [w], timezone).lexicalDiversityByWindow[0]!.typeTokenRatio);
    const currentTtr = temporal.lexicalDiversityByWindow[i]!.typeTokenRatio;

    const currentWordClassResult = wordClasses[i]!;
    const priorWordClassResults = priorWindows.map((w) => computeWordClassMarkers(w));
    const wordClassRates = ALL_WORD_CLASSES.map((wc) => {
      const currentRate = currentWordClassResult.rates.find((r) => r.wordClass === wc)!.rate;
      const priorRates = priorWordClassResults.map((r) => r.rates.find((rr) => rr.wordClass === wc)!.rate);
      return { wordClass: wc, baseline: computeBaseline(currentRate, priorRates) };
    });

    return {
      windowIndex: window.index,
      activeTieCount: computeBaseline(currentNetwork.activeTieCount, priorNetwork.map((n) => n.activeTieCount)),
      mentionConcentrationHhi: currentNetwork.mentionConcentrationHhi !== null ? computeBaseline(currentNetwork.mentionConcentrationHhi, priorHhi) : null,
      lexicalDiversityTypeTokenRatio: computeBaseline(currentTtr, priorTtr),
      wordClassRates
    };
  });

  return {
    generatedAt: now,
    windowDays,
    corpus,
    network,
    temporal,
    wordClasses,
    baselines,
    windows: windows.map((w) => ({ index: w.index, start: w.start.toISOString(), end: w.end.toISOString(), messages: w.messages }))
  };
}
