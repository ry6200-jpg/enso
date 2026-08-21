import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { UpcasterRegistry } from "../src/upcasters/registry.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

describe("UpcasterRegistry (EN-058)", () => {
  it("migrates a synthetic v1 payload to v2 shape and bumps schema_version", () => {
    const registry = new UpcasterRegistry();
    // Synthetic migration: a fabricated event type's v1 payload had a flat
    // `note` string; v2 adds a `tags` array, defaulted for old events.
    registry.register("__test_synthetic_type__", 1, (payload) => ({
      ...(payload as { note: string }),
      tags: [] as string[]
    }));

    const v1Event = {
      type: "__test_synthetic_type__",
      schemaVersion: 1,
      payload: { note: "hello" }
    };

    const migrated = registry.apply(v1Event);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.payload).toEqual({ note: "hello", tags: [] });
  });

  it("chains multiple migrations (v1 -> v2 -> v3) in order", () => {
    const registry = new UpcasterRegistry();
    registry.register("__chain_type__", 1, (payload) => ({ ...(payload as object), stepOne: true }));
    registry.register("__chain_type__", 2, (payload) => ({ ...(payload as object), stepTwo: true }));

    const migrated = registry.apply({ type: "__chain_type__", schemaVersion: 1, payload: {} });

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.payload).toEqual({ stepOne: true, stepTwo: true });
  });

  it("is a no-op passthrough when no migration is registered for a type/version", () => {
    const registry = new UpcasterRegistry();
    const event = { type: "message_sent", schemaVersion: 1, payload: { text: "hi" } };
    expect(registry.apply(event)).toEqual(event);
  });

  it("is actually invoked during replay, not just available to call (wired into rebuild)", () => {
    const eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
    const projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));

    eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "Hello Diego." },
      userId: PRIMARY_USER_ID
    });

    let applyCalls = 0;
    const registry = new UpcasterRegistry();
    const originalApply = registry.apply.bind(registry);
    registry.apply = ((event: Parameters<typeof originalApply>[0]) => {
      applyCalls++;
      return originalApply(event);
    }) as typeof registry.apply;

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID, registry);

    expect(applyCalls).toBe(1); // one event was replayed, and it passed through the registry
  });
});
