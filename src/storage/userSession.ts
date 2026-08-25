import fs from "node:fs";
import { EventLog } from "../events/eventLog.js";
import { ProjectionsDb } from "../projections/db.js";
import { RetrievalDb } from "../retrieval/retrievalDb.js";
import { BlobStore } from "../blobs/blobStore.js";
import { getUserDataPaths } from "./userDataPaths.js";
import { LockAcquisitionError, type LockHandle, type UserStorageBackend } from "./userStorageBackend.js";
import { checkpointDatabase } from "./checkpointDatabase.js";

export interface UserSessionStores {
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
  blobStore: BlobStore;
}

/**
 * Storage durability batch, PART 3 (SIGTERM handling): a process-wide
 * count of checkouts currently in flight (between acquireLock and
 * releaseLock, in either withUserSession or withReadOnlyUserSession),
 * plus a way to wait for it to reach zero. instrumentation.ts's SIGTERM
 * handler uses this to give in-flight requests room to finish their OWN
 * normal lifecycle — checkpoint, upload, release — instead of the
 * process exiting out from under them mid-checkout, which is what turned
 * a normal Cloud Run rollout into the stale-lock incident this batch
 * fixes (Node's default SIGTERM disposition, with no handler registered,
 * terminates promptly with no chance for an in-flight promise to finish).
 * Deliberately does NOT reach into any in-flight `work` and force it to
 * wrap up — an LLM call in progress has no safe early-exit point this
 * layer could invent; the only thing this can honestly do is wait.
 */
let activeCheckouts = 0;
const idleWaiters: Array<() => void> = [];

function checkoutStarted(): void {
  activeCheckouts++;
}

function checkoutFinished(): void {
  activeCheckouts--;
  if (activeCheckouts === 0) {
    while (idleWaiters.length > 0) idleWaiters.shift()!();
  }
}

/** For diagnostics/tests only — never gate application logic on this from outside a shutdown handler. */
export function getActiveCheckoutCount(): number {
  return activeCheckouts;
}

/** Resolves true once no checkout is in flight, or false if timeoutMs elapses first — never rejects. */
export function waitForNoActiveCheckouts(timeoutMs: number): Promise<boolean> {
  if (activeCheckouts === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    idleWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The checkout/checkin orchestrator (item 1) — the layer that sits
 * between a route and a UserStorageBackend. This is the ONLY place that
 * opens EventLog/ProjectionsDb/RetrievalDb against checked-out storage;
 * those classes themselves are unchanged, still taking a plain local
 * dbPath and opening it normally.
 *
 * Sequence, one full cycle per call — see enso-rebuild-requirements.md's
 * Cloud Storage batch report for why this replaced the old
 * globalThis-cached-forever per-user connections in lib/serverPipeline.ts:
 * that model kept connections open across requests, which is incompatible
 * with checkout/checkin ever safely refreshing local disk from remote or
 * ever having a safe moment to upload a consistent snapshot.
 *
 *   1. acquireLock(uid, ttlMs, holder) — fails loudly (throws) if another
 *      checkout already holds it; never retried, never queued.
 *   2. download(uid, localDir) — makes localDir an exact mirror of remote
 *      (may include leftover WAL sidecars from before the storage
 *      durability batch — see download's own doc comment for why that's
 *      safe: opening the db below replays them automatically).
 *   3. open fresh EventLog/ProjectionsDb/RetrievalDb/BlobStore against
 *      localDir.
 *   4. run the caller's `work` against those stores.
 *   5. checkpoint each SQLite db (PRAGMA wal_checkpoint(TRUNCATE),
 *      checkpointDatabase.ts) BEFORE closing — an explicit, independently
 *      verified checkpoint rather than relying on close()'s own implicit
 *      one (a prior version of this comment claimed close() alone was
 *      sufficient; that was never actually verified, and turned out to be
 *      TRUE for a plain single-connection close, but does nothing to
 *      survive the real failure mode: a hard process kill means close()
 *      never runs at all — see checkpointDatabase.ts's own comment and
 *      PART 3 below, which is what actually addresses that case). Runs
 *      even if `work` threw, same reasoning as step 6 below.
 *   6. close all three DB connections.
 *   7. fencing check (isLockCurrent) — if this lock has been reclaimed by
 *      someone else since step 1 (this holder outlived its own TTL), the
 *      upload below is REFUSED rather than attempted: a resurfaced
 *      "zombie" holder must never keep writing as if it still held the
 *      lock. This turn's local writes are lost in that case, the same
 *      honest tradeoff as any other checkin failure.
 *   8. upload(uid, localDir) — runs even if `work` threw, for the same
 *      EN-010 reason step 5 does; excludes WAL sidecars structurally and
 *      uploads new files before deleting stale ones (see upload's own doc
 *      comment) so an interruption here can't leave remote emptier than
 *      it was.
 *   9. releaseLock(uid) — always, in a finally, whether or not upload
 *      succeeded, so a live (non-crashed) instance's own failure doesn't
 *      needlessly block the next request for the lock's full TTL.
 *
 * If `work` throws AND checkpoint/fencing/upload also fails, both are
 * real failures and neither is swallowed — the combined error names both.
 */
export async function withUserSession<T>(
  backend: UserStorageBackend,
  localRoot: string,
  uid: string,
  lockTtlMs: number,
  work: (stores: UserSessionStores) => Promise<T>,
  holder = "unknown"
): Promise<T> {
  const handle = await backend.acquireLock(uid, lockTtlMs, holder);
  checkoutStarted();
  try {
    const paths = getUserDataPaths(localRoot, uid);
    await backend.download(uid, paths.dir);
    fs.mkdirSync(paths.blobsDir, { recursive: true });

    const eventLog = new EventLog(paths.eventsDb);
    const projectionsDb = new ProjectionsDb(paths.projectionsDb);
    const retrievalDb = new RetrievalDb(paths.retrievalDb);
    const blobStore = new BlobStore(paths.blobsDir);

    let workError: unknown;
    let result: T | undefined;
    try {
      result = await work({ eventLog, projectionsDb, retrievalDb, blobStore });
    } catch (err) {
      workError = err;
    }

    let checkinError: unknown;
    for (const [db, dbPath, label] of [
      [eventLog.db, paths.eventsDb, "events.db"],
      [projectionsDb.db, paths.projectionsDb, "projections.db"],
      [retrievalDb.db, paths.retrievalDb, "retrieval.db"]
    ] as const) {
      try {
        checkpointDatabase(db, dbPath, label);
      } catch (err) {
        checkinError ??= err;
      }
    }
    eventLog.close();
    projectionsDb.close();
    retrievalDb.close();

    if (checkinError === undefined) {
      try {
        const stillHeld = await backend.isLockCurrent(uid, handle);
        if (!stillHeld) {
          throw new Error(
            `Lock for user ${JSON.stringify(uid)} was reclaimed by another holder before checkin (this holder outlived its own TTL) — refusing to upload, which would race or clobber the new holder's writes.`
          );
        }
        await backend.upload(uid, paths.dir);
      } catch (err) {
        checkinError = err;
      }
    }

    if (checkinError !== undefined) {
      if (workError !== undefined) {
        throw new Error(
          `Turn failed AND checkin failed — remote storage still reflects only the last successful checkin. ` +
            `Turn error: ${workError instanceof Error ? workError.message : String(workError)}. ` +
            `Checkin error: ${checkinError instanceof Error ? checkinError.message : String(checkinError)}.`
        );
      }
      throw checkinError;
    }

    if (workError !== undefined) throw workError;
    return result as T;
  } finally {
    checkoutFinished();
    await backend.releaseLock(uid, handle);
  }
}

/**
 * Refresh-blank-chat batch: a read-only sibling of withUserSession, for
 * callers whose `work` never mutates anything. Same acquire/download/
 * open/work/close sequence, but skips step 6 (upload) entirely and
 * releases the lock as soon as the read finishes, instead of holding it
 * through a checkin step that has nothing to check in.
 *
 * Why this exists, not just a "use the fast path" optimization: live
 * evidence (real Cloud Run logs) showed GET /api/history and
 * GET /api/zodiac-sidebar's birthdate read colliding at the SAME
 * per-user lock at the exact same millisecond — both fire on the same
 * "just signed in" page load, and both were paying for a full
 * checkout-AND-checkin cycle to do nothing but read. Shortening the
 * read path to checkout-then-release (no checkin) shrinks that collision
 * window directly, rather than papering over the symptom with a retry.
 *
 * DANGER, read before reusing this for a new route: `work` MUST NOT
 * write anything through the stores it's given. Any write survives only
 * on this instance's local ephemeral disk and is never uploaded — not an
 * error, not a warning, a SILENT loss of exactly the kind EN-061 forbids
 * elsewhere in this project. If a route's `work` needs to write, even
 * conditionally, use withUserSession instead.
 *
 * Scroll/history/focus/zodiac batch, item 2 follow-up: shrinking the
 * window (above) reduced collisions but did NOT eliminate them — real
 * Cloud Run logs, checked after that fix had been live for hours, still
 * showed genuine LockAcquisitionError 500s on GET /api/history at the
 * same ~200-270ms fast-fail latency as before. Root cause: the lock is
 * still fully EXCLUSIVE, so two READ-ONLY sessions for the same user
 * (e.g. history and zodiac-sidebar firing on the same page load) still
 * exclude each other even though neither one writes anything and there is
 * nothing for them to actually conflict over. A real reader/writer lock
 * (shared for reads, exclusive for writes) is the correct long-term fix
 * and is a bigger change than this batch's scope; the retry below is the
 * bounded, evidence-based interim mitigation — NOT a blind timer papering
 * over an unknown cause. It only retries the one specific, diagnosed,
 * inherently-transient error class (another read-only session — never a
 * writer, which still fails fast via plain withUserSession above — briefly
 * holding the same lock), retries a small fixed number of times with a
 * short delay, and gives up loudly (the original LockAcquisitionError)
 * if the contention genuinely doesn't clear.
 */
const READ_ONLY_LOCK_RETRY_ATTEMPTS = 3;
const READ_ONLY_LOCK_RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireReadOnlyLockWithRetry(backend: UserStorageBackend, uid: string, ttlMs: number, holder: string): Promise<LockHandle> {
  for (let attempt = 1; attempt <= READ_ONLY_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await backend.acquireLock(uid, ttlMs, holder);
    } catch (err) {
      if (!(err instanceof LockAcquisitionError) || attempt === READ_ONLY_LOCK_RETRY_ATTEMPTS) throw err;
      await delay(READ_ONLY_LOCK_RETRY_DELAY_MS);
    }
  }
  // Unreachable — the loop above always returns or throws — but TypeScript
  // can't see that from a for-loop, and this function must still type as
  // returning Promise<LockHandle>, not Promise<LockHandle | undefined>.
  throw new Error("acquireReadOnlyLockWithRetry: unreachable");
}

export async function withReadOnlyUserSession<T>(
  backend: UserStorageBackend,
  localRoot: string,
  uid: string,
  lockTtlMs: number,
  work: (stores: UserSessionStores) => Promise<T>,
  holder = "unknown"
): Promise<T> {
  const handle = await acquireReadOnlyLockWithRetry(backend, uid, lockTtlMs, holder);
  checkoutStarted();
  try {
    const paths = getUserDataPaths(localRoot, uid);
    await backend.download(uid, paths.dir);
    fs.mkdirSync(paths.blobsDir, { recursive: true });

    const eventLog = new EventLog(paths.eventsDb);
    const projectionsDb = new ProjectionsDb(paths.projectionsDb);
    const retrievalDb = new RetrievalDb(paths.retrievalDb);
    const blobStore = new BlobStore(paths.blobsDir);

    try {
      return await work({ eventLog, projectionsDb, retrievalDb, blobStore });
    } finally {
      eventLog.close();
      projectionsDb.close();
      retrievalDb.close();
    }
  } finally {
    checkoutFinished();
    await backend.releaseLock(uid, handle);
  }
}
