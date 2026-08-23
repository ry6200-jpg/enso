/**
 * Cloud Storage checkout/checkin layer, item 1. The interface every route
 * ultimately goes through instead of touching a user's directory directly:
 * `download`/`upload` move a whole user's data tree (events.db,
 * projections.db, retrieval.db, blobs/**) between remote storage and a
 * local ephemeral directory; `acquireLock`/`releaseLock` give exclusive
 * per-user access for the span between a checkout and its matching
 * checkin. Two implementations: LocalStorageBackend (localStorageBackend.ts,
 * a second directory on disk — used for all testing) and GcsStorageBackend
 * (gcsStorageBackend.ts, written now, exercised at deployment).
 *
 * The EventLog/ProjectionsDb/RetrievalDb classes never see this interface
 * at all — they keep taking a local dbPath and opening it normally. This
 * layer only decides what local path is populated with before they're
 * constructed and what happens to it afterward. See userSession.ts for the
 * orchestrator that ties checkout, the DB classes, and checkin together.
 */

/** Thrown by acquireLock when another checkout already holds the lock and it hasn't expired. The caller must fail the request loudly — never retry in a loop, never proceed without the lock. */
export class LockAcquisitionError extends Error {
  constructor(uid: string) {
    super(`Could not acquire the storage lock for user ${JSON.stringify(uid)} — another checkout currently holds it.`);
    this.name = "LockAcquisitionError";
  }
}

/** Opaque proof of ownership returned by acquireLock and required by releaseLock, so a caller can never release a lock it doesn't actually hold (e.g. one that was already reclaimed as stale by someone else). */
export interface LockHandle {
  readonly token: string;
}

export interface UserStorageBackend {
  /**
   * Makes localDir an exact mirror of this user's remote data (wiping
   * anything already at localDir first — see localStorageBackend.ts for
   * why a naive overwrite-only copy would let a since-deleted remote file
   * resurrect on the next checkin). A user with no remote data yet (first
   * ever turn) leaves localDir empty; callers are responsible for letting
   * the DB classes create fresh files there.
   */
  download(uid: string, localDir: string): Promise<void>;

  /** Uploads everything under localDir to this user's remote location, replacing whatever was there. Callers must checkpoint/close any open DB connections against localDir before calling this — see userSession.ts. */
  upload(uid: string, localDir: string): Promise<void>;

  /** Acquires the per-user lock or throws LockAcquisitionError. A lock older than ttlMs is treated as abandoned (a crashed instance) and may be reclaimed instead of blocking. */
  acquireLock(uid: string, ttlMs: number): Promise<LockHandle>;

  /** Releases the lock if — and only if — handle is still the current holder. A no-op if the lock was already reclaimed as stale by someone else; releasing must never delete a lock this caller doesn't actually own. */
  releaseLock(uid: string, handle: LockHandle): Promise<void>;
}
