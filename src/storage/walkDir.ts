import fs from "node:fs";
import path from "node:path";

/** Every file (not directory) under dir, recursively, as absolute paths. Shared by both UserStorageBackend implementations. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
