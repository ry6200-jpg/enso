import fs from "node:fs";
import { EventLog } from "../events/eventLog.js";
import { ProjectionsDb } from "../projections/db.js";
import { RetrievalDb } from "../retrieval/retrievalDb.js";
import { BlobStore } from "../blobs/blobStore.js";
import { getUserDataPaths } from "./userDataPaths.js";
import type { UserStorageBackend } from "./userStorageBackend.js";

export interface UserSessionStores {
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
  blobStore: BlobStore;
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
 *   1. acquireLock(uid) — fails loudly (throws) if another checkout
 *      already holds it; never retried, never queued.
 *   2. download(uid, localDir) — makes localDir an exact mirror of remote.
 *   3. open fresh EventLog/ProjectionsDb/RetrievalDb/BlobStore against
 *      localDir.
 *   4. run the caller's `work` against those stores.
 *   5. close all three DB connections — closing the LAST connection to a
 *      WAL-mode SQLite db checkpoints it and removes the -wal/-shm
 *      sidecars (verified empirically against better-sqlite3), leaving a
 *      single self-contained main file safe to upload alone. This runs
 *      even if `work` threw: EN-010's "message saved before any AI call"
 *      means real durable writes can exist even when a turn ultimately
 *      fails, and those writes must still reach remote storage rather
 *      than being stranded on ephemeral local disk.
 *   6. upload(uid, localDir) — also runs even if `work` threw, for the
 *      same reason.
 *   7. releaseLock(uid) — always, in a finally, whether or not upload
 *      succeeded, so a live (non-crashed) instance's own failure doesn't
 *      needlessly block the next request for the lock's full TTL.
 *
 * If `work` throws AND upload also throws, both are real failures and
 * neither is swallowed — the combined error names both.
 */
export async function withUserSession<T>(
  backend: UserStorageBackend,
  localRoot: string,
  uid: string,
  lockTtlMs: number,
  work: (stores: UserSessionStores) => Promise<T>
): Promise<T> {
  const handle = await backend.acquireLock(uid, lockTtlMs);
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
    } finally {
      eventLog.close();
      projectionsDb.close();
      retrievalDb.close();
    }

    try {
      await backend.upload(uid, paths.dir);
    } catch (uploadErr) {
      if (workError !== undefined) {
        throw new Error(
          `Turn failed AND checkin failed — remote storage still reflects only the last successful checkin. ` +
            `Turn error: ${workError instanceof Error ? workError.message : String(workError)}. ` +
            `Checkin error: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}.`
        );
      }
      throw uploadErr;
    }

    if (workError !== undefined) throw workError;
    return result as T;
  } finally {
    await backend.releaseLock(uid, handle);
  }
}
