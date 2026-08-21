import { monotonicFactory } from "ulid";

// Plain ulid() can produce two ids in the same millisecond that don't sort in
// call order (the random component isn't ordered). Since ULID order doubles
// as log order (EN-050), we need the monotonic variant, which guarantees each
// id sorts after the previous one generated in this process.
const monotonicUlid = monotonicFactory();

/** ULIDs everywhere — no auto-incrementing integer primary keys (EN-050). */
export function newId(): string {
  return monotonicUlid();
}
