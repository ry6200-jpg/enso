import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeUidForPath } from "./userDataPaths.js";
import { LockAcquisitionError, type LockHandle, type UserStorageBackend } from "./userStorageBackend.js";
import { walk } from "./walkDir.js";

interface LockMeta {
  token: string;
  expiresAt: number;
  /** Storage durability batch, PART 2 — diagnostic only, see userStorageBackend.ts's acquireLock doc comment. */
  holder: string;
}

/** Storage durability batch, PART 1: never upload/copy a WAL sidecar file, structurally, regardless of what a caller failed to clean up. */
function isSidecarFile(name: string): boolean {
  return name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal");
}

function readLockMeta(lockDir: string): LockMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "meta.json"), "utf8")) as LockMeta;
  } catch {
    // Missing/unreadable meta means either no lock, or another acquirer's
    // mkdir succeeded a moment ago and its meta.json write hasn't landed
    // yet — either way, staleness can't be determined, so this is treated
    // as "held, not expired" by the caller (fail loud, never guess).
    return null;
  }
}

/**
 * "A second directory on disk" backend (item 1) — used for every test in
 * this batch, no GCS credentials required. remoteRoot plays the role real
 * remote storage will play at deployment; a caller's localDir plays the
 * role of this Cloud Run instance's ephemeral local disk.
 *
 * Locking uses directory creation as the atomic primitive: `fs.mkdirSync`
 * with no `recursive` option throws EEXIST if the target already exists,
 * which is atomic at the filesystem level (the same technique libraries
 * like proper-lockfile use) — a real mutual-exclusion guarantee for
 * concurrent callers in this process, not an in-memory flag that a
 * distinct backend instance could see straight through. Reclaiming a
 * stale lock (rmSync the expired lock dir, then retry the mkdir once) has
 * a narrow race window between the rm and the retry that a second real
 * OS process could in principle win — acceptable for a local dev/test
 * double; GcsStorageBackend uses a genuine compare-and-swap (generation
 * preconditions) for the real deployment guarantee.
 */
export class LocalStorageBackend implements UserStorageBackend {
  constructor(private readonly remoteRoot: string) {}

  private userDir(uid: string): string {
    return path.join(this.remoteRoot, "users", sanitizeUidForPath(uid));
  }

  private lockDir(uid: string): string {
    return path.join(this.remoteRoot, ".locks", sanitizeUidForPath(uid));
  }

  async download(uid: string, localDir: string): Promise<void> {
    // Wipe first, not overwrite-in-place: a file remote no longer has
    // (deleted since the last checkin, e.g. via /api/wipe or an attachment
    // deletion from another instance) must not survive as a stale local
    // leftover that then gets silently re-uploaded on the next checkin,
    // resurrecting content the user deleted.
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.mkdirSync(localDir, { recursive: true });

    const remoteUserDir = this.userDir(uid);
    if (!fs.existsSync(remoteUserDir)) return; // first-ever turn for this user — nothing to fetch yet
    fs.cpSync(remoteUserDir, localDir, { recursive: true });
  }

  /**
   * Storage durability batch, PART 1 + PART 3: never uploads a `-wal`/
   * `-shm`/`-journal` sidecar, and copies the new/updated files FIRST,
   * deleting anything stale (present remotely, absent locally) only
   * afterward — never the reverse. An interruption partway through this
   * now leaves, at worst, an orphaned extra file remotely (recoverable,
   * cleaned up by the next successful checkin) rather than a remote
   * directory wiped before its replacement finished landing, which is
   * strictly worse than not having uploaded at all.
   */
  async upload(uid: string, localDir: string): Promise<void> {
    const remoteUserDir = this.userDir(uid);
    fs.mkdirSync(remoteUserDir, { recursive: true });

    const localFiles = fs.existsSync(localDir) ? walk(localDir).filter((f) => !isSidecarFile(f)) : [];
    for (const absolute of localFiles) {
      const relative = path.relative(localDir, absolute);
      const destination = path.join(remoteUserDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(absolute, destination);
    }

    const localRelativeSet = new Set(localFiles.map((f) => path.relative(localDir, f)));
    for (const remoteAbsolute of walk(remoteUserDir)) {
      const relative = path.relative(remoteUserDir, remoteAbsolute);
      if (!localRelativeSet.has(relative)) fs.rmSync(remoteAbsolute, { force: true });
    }
  }

  async acquireLock(uid: string, ttlMs: number, holder = "unknown"): Promise<LockHandle> {
    const lockDir = this.lockDir(uid);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });

    const tryCreate = (): boolean => {
      try {
        fs.mkdirSync(lockDir);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    };

    const writeMeta = (): LockHandle => {
      const token = crypto.randomUUID();
      fs.writeFileSync(path.join(lockDir, "meta.json"), JSON.stringify({ token, expiresAt: Date.now() + ttlMs, holder } satisfies LockMeta));
      return { token };
    };

    if (tryCreate()) return writeMeta();

    const existing = readLockMeta(lockDir);
    const isStale = existing !== null && Date.now() >= existing.expiresAt;
    if (!isStale) throw new LockAcquisitionError(uid);

    fs.rmSync(lockDir, { recursive: true, force: true });
    if (!tryCreate()) throw new LockAcquisitionError(uid); // someone else reclaimed it first
    return writeMeta();
  }

  async releaseLock(uid: string, handle: LockHandle): Promise<void> {
    const lockDir = this.lockDir(uid);
    const existing = readLockMeta(lockDir);
    if (existing === null || existing.token !== handle.token) return; // already reclaimed by someone else — never delete a lock we don't own
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  async isLockCurrent(uid: string, handle: LockHandle): Promise<boolean> {
    const existing = readLockMeta(this.lockDir(uid));
    return existing !== null && existing.token === handle.token;
  }
}
