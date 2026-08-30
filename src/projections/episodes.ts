import type { EpisodeRow } from "./db.js";

export type EpisodeMarkerKind = "incident_reference" | "boundary_start" | "boundary_end";

/**
 * One episodeMarker, already joined to the extraction event it came from —
 * built by rebuild.ts (which has the event log, per-event provenance, and
 * the already-resolved participant entity ids on hand) before being handed
 * to clusterEpisodeMarkers below, which stays a pure function over this
 * flat shape so it's independently testable with no DB or event log at all.
 */
export interface EpisodeMarkerEvent {
  /** The extraction_completed event ULID this marker came from. */
  extractionEventId: string;
  /** The message_sent (or other) event ULID the extraction ran on. */
  sourceEventId: string;
  /** extraction_completed event's own recordedAt — the TOLD-time this marker was captured. */
  toldAt: string;
  kind: EpisodeMarkerKind;
  text: string;
  /** Entity ids already resolved (by rebuild.ts's own resolveName) from the SAME extraction event — reused rather than re-derived, so this stays a pure fold with no entity-resolution logic of its own. */
  participantEntityIds: string[];
}

/**
 * Best-effort, fully deterministic: finds an explicit 4-digit year (1900-
 * 2099) stated directly in a marker's own text — "Back in 1995..." parses;
 * "three years ago" or "when I was in college" does not. This is a
 * deliberate, honest scope limit, not an oversight: resolving a RELATIVE
 * date correctly needs the same referenceDate-aware math
 * buildExtractionSystemPrompt's `attributes` rule already does for
 * eventDate — which requires the LLM and a schema field, and this batch
 * was explicitly scoped to add neither (reusing the existing episodeMarkers
 * taxonomy verbatim, per EN-037 Phase 8.5 rather than a new extraction
 * category). A marker with no explicit year resolves to a null
 * narrativeYear — an honest gap, surfaced as such (see EpisodeRow's own
 * doc comment), never a guess.
 */
export function extractNarrativeYear(text: string): string | null {
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1]! : null;
}

type OpenEpisode = {
  title: string;
  toldStart: string;
  toldEnd: string;
  narrativeYear: string | null;
  participantEntityIds: Set<string>;
  sourceEventIds: Set<string>;
};

function toRow(episode: OpenEpisode): Omit<EpisodeRow, "id" | "user_id" | "created_at"> {
  return {
    title: episode.title,
    told_start: episode.toldStart,
    told_end: episode.toldEnd,
    narrative_year: episode.narrativeYear,
    participant_entity_ids: JSON.stringify([...episode.participantEntityIds].sort()),
    source_event_ids: JSON.stringify([...episode.sourceEventIds].sort())
  };
}

/**
 * EN-037 Phase 8.5: clusters a user's episodeMarkers, in event-log
 * chronological order (callers must pass markerEvents already in that
 * order — this function does no sorting of its own), into coherent
 * episodes.
 *
 * STRUCTURAL clustering, not semantic — boundary_start/boundary_end are
 * explicit narrative signals the extraction prompt already only emits
 * "when the text explicitly signals an incident beginning or concluding"
 * (taxonomySchema.ts, unchanged), so they're a reliable, deterministic
 * grouping key with no text-similarity judgment needed here: a
 * boundary_start opens an episode, every incident_reference before the
 * next boundary_end attaches to it (this is the "argument that unfolded
 * across four conversations" case EN-037 names, as long as the extractor
 * itself keeps the incident open across those messages rather than closing
 * it early — this projection just respects whatever boundary structure it
 * already emitted), and boundary_end closes it. A kind with no currently-
 * open boundary (an incident_reference on its own, or a stray boundary_end
 * with nothing to close) becomes its own one-marker episode.
 *
 * KNOWN, ACCEPTED GAP: this is the ONLY dedup performed across messages. An
 * incident mentioned again in a LATER, unrelated conversation with no
 * boundary markers spanning both is NOT merged into the earlier episode —
 * true semantic dedup would need an embedding or LLM similarity judgment,
 * deliberately not built here (this whole pass makes zero provider calls,
 * purely derived from already-recorded extraction output, consistent with
 * the standing API-budget-protection policy).
 *
 * Title is the OPENING marker's own extracted text, used verbatim — not an
 * LLM-generated summary. EN-037 describes "a generated title"; synthesizing
 * one well would mean an extra provider call per episode, which this batch
 * deliberately does not spend (see the same cost-discipline note above). A
 * synthesized title is a real, separate future enhancement, not silently
 * substituted for here.
 */
export function clusterEpisodeMarkers(markerEvents: readonly EpisodeMarkerEvent[]): Omit<EpisodeRow, "id" | "user_id" | "created_at">[] {
  const episodes: Omit<EpisodeRow, "id" | "user_id" | "created_at">[] = [];
  let open: OpenEpisode | null = null;

  function closeOpen(): void {
    if (!open) return;
    episodes.push(toRow(open));
    open = null;
  }

  function foldIntoOpen(marker: EpisodeMarkerEvent): void {
    const current = open!;
    current.toldEnd = marker.toldAt;
    current.narrativeYear = current.narrativeYear ?? extractNarrativeYear(marker.text);
    for (const id of marker.participantEntityIds) current.participantEntityIds.add(id);
    current.sourceEventIds.add(marker.sourceEventId);
    current.sourceEventIds.add(marker.extractionEventId);
  }

  for (const marker of markerEvents) {
    if (marker.kind === "boundary_start") {
      closeOpen(); // a still-open episode with no matching boundary_end before the next start closes here, told_end = its last-folded marker
      open = {
        title: marker.text,
        toldStart: marker.toldAt,
        toldEnd: marker.toldAt,
        narrativeYear: extractNarrativeYear(marker.text),
        participantEntityIds: new Set(marker.participantEntityIds),
        sourceEventIds: new Set([marker.sourceEventId, marker.extractionEventId])
      };
      continue;
    }
    if (open) {
      foldIntoOpen(marker);
      if (marker.kind === "boundary_end") closeOpen();
      continue;
    }
    // incident_reference (or a stray boundary_end) with nothing open: a standalone, one-marker episode.
    episodes.push(
      toRow({
        title: marker.text,
        toldStart: marker.toldAt,
        toldEnd: marker.toldAt,
        narrativeYear: extractNarrativeYear(marker.text),
        participantEntityIds: new Set(marker.participantEntityIds),
        sourceEventIds: new Set([marker.sourceEventId, marker.extractionEventId])
      })
    );
  }
  closeOpen(); // a trailing open episode with no closing boundary_end at all in this history

  return episodes;
}
