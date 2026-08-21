import { createHash } from "node:crypto";

/** Stable content hash used as the extraction cache key (EN-056). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}
