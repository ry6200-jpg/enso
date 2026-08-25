import fs from "node:fs";
import path from "node:path";

/**
 * Per-user data paths (Cloud migration prerequisite batch, item 2). One
 * directory per user, holding their own events.db/projections.db/
 * retrieval.db/blobs — the file-boundary isolation decided over the
 * alternative of a single shared set of files with user_id filtering.
 *
 * Rationale, recorded so it isn't lost: a real audit of ProjectionsDb
 * found ~10 methods (getEntityById, getStructuralAtomById,
 * getSocialBondById, getPerceptionLogForFact, touchEntity,
 * updateEntityName, setEntityConfirmed, setPendingDisambiguation,
 * closeStructuralAtom, closeSocialBond) that query by bare row id with NO
 * user_id check at all — safe today only because every caller happens to
 * pass an already-scoped id, with nothing enforcing it. File-boundary
 * isolation makes that entire bug class structurally impossible rather
 * than something to keep auditing for: if another user's row isn't in the
 * file this connection opened, it cannot be read or written, regardless
 * of what id a future bug or route passes in. The existing user_id
 * columns and filters stay exactly as they are — this is defence in
 * depth, not a replacement for them.
 *
 * DailyContentCache is deliberately NOT included here: its own schema
 * (daily_content_cache, dailyContentCache.ts) has no user_id column at
 * all — it caches AI-generated daily zodiac content keyed only by sign
 * and date, which is the same content for every user sharing a sign on a
 * given day. Sharing it is correct, not an oversight; it stays a single
 * global cache, not per-user.
 */

export interface UserDataPaths {
  /** This user's own root directory — everything below is scoped inside it. */
  dir: string;
  eventsDb: string;
  projectionsDb: string;
  retrievalDb: string;
  blobsDir: string;
  /** Report page (Stage A, methodology Section 4.1's prediction capture) — a small JSON file, deliberately NOT the event log or a projection: the report reads the corpus but never writes to it, and a prediction is metadata about a report-viewing session, not a message the owner sent. Included in checkout/checkin automatically (both storage backends copy the whole per-user directory generically), so it's durable and cross-device without any backend code change. */
  reportPredictionsPath: string;
}

/**
 * Firebase UIDs are opaque, platform-generated alphanumeric strings — but
 * this value now becomes a filesystem path component, so it gets the same
 * defensive treatment any path-building-from-external-input needs: reject
 * anything outside a strict allowlist rather than trust the source. This
 * should never actually reject a real Firebase UID; it exists for the
 * case where verification is ever bypassed or a token is corrupted.
 */
const SAFE_UID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function sanitizeUidForPath(uid: string): string {
  if (!SAFE_UID_PATTERN.test(uid)) {
    throw new Error(`Refusing to build a filesystem path from an unsafe user id: ${JSON.stringify(uid)}`);
  }
  return uid;
}

export function getUserDataPaths(rootDir: string, uid: string): UserDataPaths {
  const safeUid = sanitizeUidForPath(uid);
  const dir = path.join(rootDir, "users", safeUid);
  return {
    dir,
    eventsDb: path.join(dir, "events.db"),
    projectionsDb: path.join(dir, "projections.db"),
    retrievalDb: path.join(dir, "retrieval.db"),
    blobsDir: path.join(dir, "blobs"),
    reportPredictionsPath: path.join(dir, "report-predictions.json")
  };
}

/**
 * The actual wipe operation, extracted as a pure(ish) function so it's
 * FAST-testable directly — lib/serverPipeline.ts's resetUserData calls
 * this rather than duplicating it, so the isolation guarantee under test
 * is the real code path, not a reimplementation of it. Closes whatever
 * connections the caller already had open for this user (never anyone
 * else's), deletes ONLY `paths.dir`, then recreates it empty. Scoped
 * strictly to the one directory passed in — this function has no way to
 * reach any other user's directory even if given a wrong uid, since it
 * never constructs a path itself, only deletes the one it's handed.
 */
export function wipeUserDirectory(paths: UserDataPaths, openConnections: { close(): void }[]): void {
  for (const connection of openConnections) connection.close();
  fs.rmSync(paths.dir, { recursive: true, force: true });
  fs.mkdirSync(paths.dir, { recursive: true });
}
