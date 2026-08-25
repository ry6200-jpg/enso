import fs from "node:fs";
import type Database from "better-sqlite3";

/**
 * Storage durability batch, PART 1 (deploy-race stale lock investigation):
 * forces a full WAL checkpoint and truncation before a database is
 * uploaded, so checkin ships one self-contained `.db` file per database
 * instead of a main file plus separate `-wal`/`-shm` objects with no
 * cross-object atomicity on GCS — a checkin interrupted between those
 * uploads used to leave a torn, inconsistent state (confirmed live: exactly
 * these sidecar files were found sitting in production after a deploy-race
 * crash).
 *
 * Precision on WHY, confirmed empirically while building this (see
 * tests/storageDurability.test.ts): a plain `close()` on the sole open
 * connection to a WAL-mode database DOES already auto-checkpoint — that
 * part of userSession.ts's old comment was correct. The actual gap is
 * narrower and worse: a hard process termination (SIGKILL after a Cloud
 * Run rollout eviction, which is exactly what happened in the real
 * incident) means `close()` never runs AT ALL, so whatever implicit
 * checkpoint it would have performed never happens either. Making the
 * checkpoint explicit and independently verified here doesn't, by itself,
 * survive a hard kill any better than the implicit one did — PART 3's
 * SIGTERM handling is what actually prevents the kill from happening
 * mid-checkout in the first place during a normal rollout. What this
 * function adds on its own: a checkable, fail-loud guarantee at the one
 * moment this code chooses to rely on it, instead of an unverified
 * assumption about an implicit side effect of a different call.
 *
 * Verified, not assumed, per explicit instruction: checks BOTH the
 * pragma's own `busy` flag AND the actual `-wal` file size on disk
 * afterward — either signal alone could in principle be wrong (a
 * mis-parsed pragma result, a filesystem write not yet visible to a
 * subsequent stat) and checking both costs nothing. Throws — fails loud —
 * rather than silently letting a caller upload a database that might
 * still hold committed-but-unflushed transactions in its WAL.
 */
export function checkpointDatabase(db: Database.Database, dbPath: string, label: string): void {
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
  const result = rows[0];
  if (!result || result.busy !== 0) {
    throw new Error(
      `checkpointDatabase: ${label} WAL checkpoint did not complete cleanly (busy=${result?.busy ?? "no result row returned"}) — refusing to treat it as safe to upload as a single self-contained file.`
    );
  }
  const walPath = `${dbPath}-wal`;
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  if (walSize !== 0) {
    throw new Error(`checkpointDatabase: ${label} checkpoint reported success (busy=0) but ${walPath} is still ${walSize} bytes on disk — refusing to upload.`);
  }
}
