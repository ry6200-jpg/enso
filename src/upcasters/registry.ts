/**
 * Per-type schema-version migration hooks (EN-058). Events are permanent —
 * old event versions must remain replayable forever — so upcasters exist
 * from the first schema even though, today, every real event type is still
 * at version 1 and no migrations are registered for them.
 *
 * Deliberately a plain class rather than a module-level singleton: rebuild
 * owns one registry instance, so tests can register migrations without any
 * risk of leaking state into unrelated tests or into the real event types.
 */
export type UpcastFn = (payload: unknown) => unknown;

export interface UpcastableEvent {
  type: string;
  schemaVersion: number;
  payload: unknown;
}

export class UpcasterRegistry {
  private readonly fns = new Map<string, UpcastFn>();

  register(type: string, fromVersion: number, upcast: UpcastFn): void {
    this.fns.set(`${type}:${fromVersion}`, upcast);
  }

  /** Applies every registered migration in sequence until none apply. */
  apply<T extends UpcastableEvent>(event: T): T {
    let current: UpcastableEvent = event;
    for (;;) {
      const fn = this.fns.get(`${current.type}:${current.schemaVersion}`);
      if (!fn) break;
      current = {
        ...current,
        payload: fn(current.payload),
        schemaVersion: current.schemaVersion + 1
      };
    }
    return current as T;
  }
}
