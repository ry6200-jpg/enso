import type { BlobStore } from "../blobs/blobStore.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { ProjectionsDb } from "../projections/db.js";
import { rebuildProjections } from "../projections/rebuild.js";
import { rebuildRetrievalIndex } from "../retrieval/rebuildRetrievalIndex.js";
import type { RetrievalDb } from "../retrieval/retrievalDb.js";
import type { FileUploadedPayload, UploadDeletedPayload } from "./attachmentCapture.js";

/**
 * EN-065 core mechanism, scoped per the prior scoping report: the sole-
 * provenance case only. EN-066's attestation-survives-deletion exception
 * is deliberately NOT implemented here — see the note on
 * computeDeletionImpact below for exactly why and what that means in
 * practice.
 *
 * This is the ONE place that decides which events an upload deletion
 * eclipses. rebuildProjections, rebuildRetrievalIndex, and
 * computeDeletionImpact all call this same function — never three
 * separate re-derivations of "what does deleting this upload affect,"
 * which is exactly the drift EN-065's "no silent cascade" guarantee
 * depends on not happening.
 */
export function computeEclipsedEventIds(events: EventRecord[]): Set<string> {
  const deletedUploadIds = new Set<string>();
  for (const event of events) {
    if (event.type === "upload_deleted") deletedUploadIds.add((event.payload as UploadDeletedPayload).uploadEventId);
  }
  if (deletedUploadIds.size === 0) return deletedUploadIds;

  const eclipsed = new Set<string>(deletedUploadIds);
  for (const event of events) {
    if (event.type !== "extraction_completed") continue;
    const sourceEventId = (event.payload as { sourceEventId?: string }).sourceEventId;
    if (sourceEventId && deletedUploadIds.has(sourceEventId)) eclipsed.add(event.id);
  }
  return eclipsed;
}

export interface DeletionImpact {
  uploadEventId: string;
  filename: string;
  /** Facts (entity_attributes + structural_atoms + social_bonds rows) whose ENTIRE provenance is within the eclipsed set — these disappear on the next rebuild. */
  removedFactCount: number;
  /** Facts with at least one provenance event OUTSIDE the eclipsed set — corroborated elsewhere, these survive. */
  preservedFactCount: number;
}

/**
 * The dry-run/real impact computation, called BOTH for the one-click
 * confirmation preview and (via deleteUpload below) as part of what
 * actually gets recorded on the tombstone event — the same function
 * either way, never two implementations that could disagree.
 *
 * Works by building a HYPOTHETICAL event stream — the real log plus one
 * synthetic upload_deleted event for the upload in question — and running
 * it through the exact same computeEclipsedEventIds the real rebuild uses.
 * This is what guarantees the preview can never promise something
 * deletion doesn't actually do: it isn't a parallel prediction, it's a
 * dry run of the identical logic.
 *
 * KNOWN, DOCUMENTED GAP (EN-066's attestation exception, deliberately not
 * built here): a fact_confirmed event currently only marks the ENTITY as
 * confirmed (see rebuild.ts's fact_confirmed handling) — it does NOT
 * extend the specific entity_attributes row's own source_event_ids to
 * include the confirmation as independent provenance. That link is what
 * EN-066 depends on to say "a fact the user explicitly affirmed survives
 * deletion of the file it came from." Without it, this function has no
 * way to distinguish an attested fact from an unattested one — an
 * attested fact whose ONLY original source was this upload is currently
 * counted as REMOVED, same as any other sole-provenance fact. This is a
 * real, live gap, not an edge case being silently ignored: it means
 * EN-065 as built right now does not yet honor EN-066's attestation
 * carve-out. Fixing it requires first teaching rebuild.ts's fact_confirmed
 * handling to append the confirmation event to the relevant attribute
 * row's provenance — tracked as a follow-up, not done in this pass.
 */
export function computeDeletionImpact(eventLog: EventLog, projections: ProjectionsDb, userId: string, uploadEventId: string): DeletionImpact {
  const uploadEvent = eventLog.getById(uploadEventId);
  if (!uploadEvent || uploadEvent.type !== "file_uploaded") {
    throw new Error(`computeDeletionImpact: no file_uploaded event found for id ${uploadEventId}`);
  }
  const filename = (uploadEvent.payload as FileUploadedPayload).filename;

  const hypotheticalTombstone: EventRecord = {
    id: "hypothetical-tombstone",
    recordedAt: new Date().toISOString(),
    occurredAt: null,
    type: "upload_deleted",
    actor: "user",
    payload: { uploadEventId, filename, removedFactCount: 0, preservedFactCount: 0 } satisfies UploadDeletedPayload,
    schemaVersion: 1,
    userId
  };
  const eclipsed = computeEclipsedEventIds([...eventLog.listForUser(userId), hypotheticalTombstone]);

  // Three-way, not two-way: a fact with ZERO provenance overlap with this
  // upload is UNRELATED to this deletion entirely and must count toward
  // neither bucket — a real bug caught live during this feature's own
  // first manual test, where an unrelated fact from a completely
  // different document was being reported as "preserved," implying a
  // relationship to this file that never existed. Only a fact that this
  // upload contributed SOMETHING to, but that also has provenance outside
  // it, is genuinely "preserved via corroboration."
  function classify(sourceEventIdsJson: string): "removed" | "preserved" | "unrelated" {
    const ids = JSON.parse(sourceEventIdsJson) as string[];
    const overlapsEclipsed = ids.some((id) => eclipsed.has(id));
    if (!overlapsEclipsed) return "unrelated";
    return ids.every((id) => eclipsed.has(id)) ? "removed" : "preserved";
  }

  let removedFactCount = 0;
  let preservedFactCount = 0;
  const rowGroups = [projections.listAllEntityAttributes(userId), projections.listStructuralAtoms(userId), projections.listSocialBonds(userId)];
  for (const rows of rowGroups) {
    for (const row of rows) {
      const outcome = classify(row.source_event_ids);
      if (outcome === "removed") removedFactCount++;
      else if (outcome === "preserved") preservedFactCount++;
    }
  }

  return { uploadEventId, filename, removedFactCount, preservedFactCount };
}

export interface UploadListItem {
  uploadEventId: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  extractionStatus: "pending" | "completed" | "failed";
}

/**
 * The uploads-list surface (item 6 of the EN-065 build): no such listing
 * existed anywhere before this — deleted uploads are excluded, using the
 * same computeEclipsedEventIds every other consumer uses, so a tombstoned
 * upload disappears from this list exactly when it disappears everywhere
 * else, never a moment later or via separate logic.
 */
export function listUploads(eventLog: EventLog, userId: string): UploadListItem[] {
  const events = eventLog.listForUser(userId);
  const eclipsed = computeEclipsedEventIds(events);

  const extractionStatusBySourceId = new Map<string, "completed" | "failed">();
  for (const event of events) {
    if (event.type === "extraction_completed") extractionStatusBySourceId.set((event.payload as { sourceEventId?: string }).sourceEventId ?? "", "completed");
    if (event.type === "extraction_failed") extractionStatusBySourceId.set((event.payload as { sourceEventId?: string }).sourceEventId ?? "", "failed");
  }

  return events
    .filter((event) => event.type === "file_uploaded" && !eclipsed.has(event.id))
    .map((event) => {
      const payload = event.payload as FileUploadedPayload;
      return {
        uploadEventId: event.id,
        filename: payload.filename,
        mimeType: payload.mimeType,
        uploadedAt: event.recordedAt,
        extractionStatus: extractionStatusBySourceId.get(event.id) ?? "pending"
      };
    });
}

export interface DeleteUploadDeps {
  eventLog: EventLog;
  blobStore: BlobStore;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
  embedder: Embedder;
}

/**
 * The real deletion (EN-065): computes impact (the exact same function the
 * preview uses), removes the physical file bytes, appends the
 * upload_deleted tombstone recording that computed impact, then rebuilds
 * both projections and the retrieval index — mirroring
 * turnMemoryRefresh.ts's refreshMemoryAfterTurn, which rebuilds the same
 * two things after a normal chat turn. This is what makes deletion take
 * effect everywhere immediately (circle-back, retrieval, the People-style
 * entity view) rather than waiting for the next chat message to trigger a
 * rebuild — every consumer reads only the current projection, never raw
 * events directly, so correctness here is enough.
 */
export async function deleteUpload(deps: DeleteUploadDeps, userId: string, uploadEventId: string): Promise<{ tombstoneEvent: EventRecord; impact: DeletionImpact }> {
  const impact = computeDeletionImpact(deps.eventLog, deps.projectionsDb, userId, uploadEventId);

  const uploadEvent = deps.eventLog.getById(uploadEventId)!;
  const uploadPayload = uploadEvent.payload as FileUploadedPayload;
  deps.blobStore.remove(uploadPayload.path);

  const payload: UploadDeletedPayload = {
    uploadEventId,
    filename: impact.filename,
    removedFactCount: impact.removedFactCount,
    preservedFactCount: impact.preservedFactCount
  };
  const tombstoneEvent = deps.eventLog.append({ type: "upload_deleted", actor: "user", payload, userId });

  const allEvents = deps.eventLog.listForUser(userId);
  // Explicit reference date (EN-057) — see rebuildProjections' own doc
  // comment. This is a real per-request rebuild, so "now" is the only
  // sensible value; passed explicitly rather than relied on as a default
  // so the intent reads plainly at the call site.
  rebuildProjections(allEvents, deps.projectionsDb, userId, undefined, new Date());
  await rebuildRetrievalIndex(allEvents, deps.retrievalDb, userId, deps.embedder);

  return { tombstoneEvent, impact };
}
