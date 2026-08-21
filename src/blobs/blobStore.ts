import fs from "node:fs";
import path from "node:path";
import { newId } from "../ids.js";

export interface StoredBlob {
  id: string;
  relativePath: string;
  absolutePath: string;
  byteLength: number;
}

/**
 * File storage for uploads (EN-051). Bytes never go into SQLite — they live
 * on disk under an id-based path, and that path is what gets recorded in the
 * upload event's payload. This is a storage primitive only: no upload UI,
 * no content inspection, no size/type-based discarding — that's Section 7,
 * out of scope for Phase 1.
 */
export class BlobStore {
  constructor(private readonly rootDir: string) {}

  /** Stores bytes under a fresh id-based path and returns where they landed. */
  put(bytes: Buffer, originalFilename: string): StoredBlob {
    const id = newId();
    // Shard by the first two chars of the id to avoid one giant flat directory.
    const shard = id.slice(0, 2);
    const ext = path.extname(originalFilename);
    const relativePath = path.join(shard, `${id}${ext}`);
    const absolutePath = path.join(this.rootDir, relativePath);

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, bytes);

    return { id, relativePath, absolutePath, byteLength: bytes.length };
  }

  get(relativePath: string): Buffer {
    return fs.readFileSync(this.resolve(relativePath));
  }

  exists(relativePath: string): boolean {
    return fs.existsSync(this.resolve(relativePath));
  }

  /** Removes the bytes for a deleted upload (EN-065). The tombstone event is separate. */
  remove(relativePath: string): void {
    const absolute = this.resolve(relativePath);
    if (fs.existsSync(absolute)) {
      fs.unlinkSync(absolute);
    }
  }

  private resolve(relativePath: string): string {
    const absolute = path.resolve(this.rootDir, relativePath);
    const rootResolved = path.resolve(this.rootDir);
    if (!absolute.startsWith(rootResolved + path.sep) && absolute !== rootResolved) {
      throw new Error(`Refusing to resolve a path outside the blob store root: ${relativePath}`);
    }
    return absolute;
  }
}
