import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { sanitizeUidForPath } from "./userDataPaths.js";
import { LockAcquisitionError, type LockHandle, type UserStorageBackend } from "./userStorageBackend.js";
import { walk } from "./walkDir.js";

interface LockMeta {
  token: string;
  expiresAt: number;
  /** Storage durability batch, PART 2 — diagnostic only, see userStorageBackend.ts's acquireLock doc comment. */
  holder: string;
}

function isGcsErrorCode(err: unknown, code: number): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

/** Storage durability batch, PART 1: never upload a WAL sidecar file, structurally, regardless of what a caller failed to clean up. */
function isSidecarFile(name: string): boolean {
  return name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal");
}

/**
 * GCS backend (item 1) — written now, exercised at deployment (the next
 * batch adds the real bucket, credentials, and Cloud Run wiring; nothing
 * here is called by any test in this batch). Mirrors LocalStorageBackend's
 * contract exactly so userSession.ts and every route built against it
 * needs zero changes once this backend goes live — swapping backends is a
 * one-line change in lib/serverPipeline.ts, not a rewrite.
 *
 * Locking uses GCS's own generation preconditions for a genuine
 * compare-and-swap, unlike LocalStorageBackend's directory-mkdir trick
 * (which only guarantees atomicity within one Node process): saving with
 * `ifGenerationMatch: 0` succeeds only if the object doesn't exist yet (an
 * atomic create), and reclaiming an expired lock re-saves conditioned on
 * the EXACT generation just read — if another instance reclaims it first,
 * that generation has already changed and our write is rejected, so two
 * instances racing to reclaim the same stale lock can never both succeed.
 *
 * IMPORTANT for whoever deploys this: Cloud Run must be configured with
 * `--max-instances=1`. The per-user lock makes a second concurrent writer
 * structurally impossible even with more than one instance, but
 * max-instances=1 is deliberate belt-and-braces on top of that — not an
 * oversight to "clean up" once this backend is live. Do not remove it
 * without first re-deriving why it's here.
 */
export class GcsStorageBackend implements UserStorageBackend {
  private readonly storage: Storage;

  constructor(private readonly bucketName: string) {
    this.storage = new Storage();
  }

  private bucket() {
    return this.storage.bucket(this.bucketName);
  }

  private userPrefix(uid: string): string {
    return `users/${sanitizeUidForPath(uid)}/`;
  }

  private lockObjectName(uid: string): string {
    return `locks/${sanitizeUidForPath(uid)}.json`;
  }

  async download(uid: string, localDir: string): Promise<void> {
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.mkdirSync(localDir, { recursive: true });

    const prefix = this.userPrefix(uid);
    const [files] = await this.bucket().getFiles({ prefix });
    for (const file of files) {
      const relative = file.name.slice(prefix.length);
      if (relative === "") continue; // a bare "directory placeholder" object, if one exists
      const destination = path.join(localDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await file.download({ destination });
    }
  }

  /**
   * Storage durability batch, PART 1 + PART 3: never uploads a `-wal`/
   * `-shm`/`-journal` sidecar (structural, regardless of what the caller
   * left on local disk), and — the ordering fix — uploads the new/updated
   * files FIRST, deleting anything stale (present remotely, absent
   * locally) only afterward, never the reverse. The old delete-then-
   * upload order meant a checkin interrupted partway through (a crash,
   * SIGKILL after a rollout eviction) could leave the remote prefix
   * EMPTIER than before the upload started — objectively worse than not
   * uploading at all. Uploading first means an interruption leaves, at
   * worst, an orphaned stale file remotely (recoverable, cleaned up by the
   * next successful checkin), never data that used to exist and no longer
   * does.
   */
  async upload(uid: string, localDir: string): Promise<void> {
    const prefix = this.userPrefix(uid);

    const localFiles = fs.existsSync(localDir) ? walk(localDir).filter((f) => !isSidecarFile(f)) : [];
    const localRelatives = localFiles.map((absolute) => path.relative(localDir, absolute).split(path.sep).join("/"));
    await Promise.all(localFiles.map((absolute, i) => this.bucket().upload(absolute, { destination: prefix + localRelatives[i] })));

    const localRelativeSet = new Set(localRelatives);
    const [remoteFiles] = await this.bucket().getFiles({ prefix });
    await Promise.all(remoteFiles.filter((file) => !localRelativeSet.has(file.name.slice(prefix.length))).map((file) => file.delete()));
  }

  async acquireLock(uid: string, ttlMs: number, holder = "unknown"): Promise<LockHandle> {
    const file = this.bucket().file(this.lockObjectName(uid));
    const token = crypto.randomUUID();
    const meta: LockMeta = { token, expiresAt: Date.now() + ttlMs, holder };

    try {
      await file.save(JSON.stringify(meta), { preconditionOpts: { ifGenerationMatch: 0 } });
      return { token };
    } catch (err) {
      if (!isGcsErrorCode(err, 412)) throw err;
    }

    // The lock object already exists — read it and decide whether it's stale.
    const [buffer] = await file.download();
    const existing = JSON.parse(buffer.toString("utf8")) as LockMeta;
    if (Date.now() < existing.expiresAt) throw new LockAcquisitionError(uid);

    const [metadata] = await file.getMetadata();
    try {
      // Reclaim: only succeeds if nobody has touched the object since the
      // generation just read above — a real compare-and-swap.
      await file.save(JSON.stringify(meta), { preconditionOpts: { ifGenerationMatch: Number(metadata.generation) } });
      return { token };
    } catch (err) {
      if (isGcsErrorCode(err, 412)) throw new LockAcquisitionError(uid); // someone else reclaimed it first
      throw err;
    }
  }

  async releaseLock(uid: string, handle: LockHandle): Promise<void> {
    const file = this.bucket().file(this.lockObjectName(uid));
    let existing: LockMeta;
    let generation: string | number | undefined;
    try {
      const [buffer] = await file.download();
      existing = JSON.parse(buffer.toString("utf8")) as LockMeta;
      const [metadata] = await file.getMetadata();
      generation = metadata.generation;
    } catch (err) {
      if (isGcsErrorCode(err, 404)) return; // no lock object at all — nothing to release
      throw err;
    }
    if (existing.token !== handle.token) return; // already reclaimed by someone else — never delete a lock we don't own

    try {
      await file.delete({ ifGenerationMatch: Number(generation) });
    } catch (err) {
      // The only benign case: someone reclaimed the lock (their write
      // changed the generation) between our read above and this delete —
      // functionally the same "already reclaimed" case just discovered one
      // step later. Anything else is a real failure and must surface.
      if (!isGcsErrorCode(err, 412)) throw err;
    }
  }

  async isLockCurrent(uid: string, handle: LockHandle): Promise<boolean> {
    const file = this.bucket().file(this.lockObjectName(uid));
    try {
      const [buffer] = await file.download();
      const existing = JSON.parse(buffer.toString("utf8")) as LockMeta;
      return existing.token === handle.token;
    } catch (err) {
      if (isGcsErrorCode(err, 404)) return false; // no lock object at all — definitely not current
      throw err;
    }
  }
}
