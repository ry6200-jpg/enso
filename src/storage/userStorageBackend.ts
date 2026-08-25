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
   * the DB classes create fresh files there. May legitimately download
   * leftover `-wal`/`-shm` sidecar files from before the storage
   * durability batch (PART 1) — that is correct, not a bug: SQLite
   * replays a WAL automatically the moment any connection opens the main
   * file normally, so any committed-but-unchekpointed data in a legacy
   * sidecar is folded in and preserved the instant this user's next write
   * session opens it, with zero special-case code. `upload` (below) then
   * naturally cleans the sidecar away on that same session's checkin.
   */
  download(uid: string, localDir: string): Promise<void>;

  /**
   * Uploads everything under localDir to this user's remote location,
   * replacing whatever was there — except `-wal`/`-shm`/`-journal`
   * sidecar files, which are never uploaded regardless of whether one
   * happens to exist locally (storage durability batch, PART 1): callers
   * must checkpoint (`checkpointDatabase.ts`) and close any open DB
   * connections against localDir before calling this, so in the normal
   * case no sidecar exists locally to begin with — this exclusion is a
   * second, structural line of defense, not the only one. Ordering is
   * upload-new-then-delete-stale, never the reverse (PART 3): a caller
   * interrupted partway through must be left with a mix of old and new
   * files, at worst orphaned extras that a later checkin cleans up — never
   * a state emptier than what existed before the upload started.
   */
  upload(uid: string, localDir: string): Promise<void>;

  /** Acquires the per-user lock or throws LockAcquisitionError. A lock older than ttlMs is treated as abandoned (a crashed instance) and may be reclaimed instead of blocking. `holder` (storage durability batch, PART 2) is a free-text diagnostic identity — e.g. `"<revision>/<instance>"` — recorded on the lock object purely for production debugging (so a stuck lock's owner is nameable, not a mystery); it plays no role in the locking logic itself, which is still decided entirely by `expiresAt` and the token-based compare-and-swap. */
  acquireLock(uid: string, ttlMs: number, holder?: string): Promise<LockHandle>;

  /** Releases the lock if — and only if — handle is still the current holder. A no-op if the lock was already reclaimed as stale by someone else; releasing must never delete a lock this caller doesn't actually own. */
  releaseLock(uid: string, handle: LockHandle): Promise<void>;

  /**
   * Storage durability batch, PART 2 (fencing): true only if `handle` is
   * still the CURRENT lock holder — i.e. nobody has broken/reclaimed this
   * lock since it was acquired. A live holder that has simply outlived its
   * own TTL (a slow turn, not a crash) must check this immediately before
   * any write that depends on exclusive access, and must not perform that
   * write if it returns false — proceeding anyway would let a resurfaced
   * "zombie" holder overwrite or race whoever legitimately took over. See
   * userSession.ts's use of this immediately before `upload`.
   */
  isLockCurrent(uid: string, handle: LockHandle): Promise<boolean>;
}
