import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ReportPredictionStore } from "../src/report/reportPredictionStore.js";
import { freshTestDbPath } from "../src/test/dbPath.js";

function freshPath(name: string): string {
  // Reuses the same isolated-per-test-file directory scheme as SQLite test dbs — this file just
  // happens to be JSON, not a database (see reportPredictionStore.ts for why).
  return freshTestDbPath(import.meta.url, name).replace(/\.db$/, ".json");
}

describe("ReportPredictionStore (report page, Stage A, Section 4.1 — prediction capture)", () => {
  it("list() is empty for a file that doesn't exist yet", () => {
    const store = new ReportPredictionStore(freshPath("predictions"));
    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeNull();
  });

  it("save() persists a real, timestamped prediction, readable back", () => {
    const store = new ReportPredictionStore(freshPath("predictions"));
    const saved = store.save({ central: "Mom", recurring: "work stress", absent: "nothing" });
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBeTruthy();
    expect(store.list()).toEqual([saved]);
    expect(store.latest()).toEqual(saved);
  });

  it("save() is append-only — an existing prediction is never edited or removed", () => {
    const store = new ReportPredictionStore(freshPath("predictions"));
    const first = store.save({ central: "Mom", recurring: "work", absent: "nothing" });
    const second = store.save({ central: "Elena", recurring: "money", absent: "family" });
    expect(store.list()).toEqual([first, second]);
    expect(store.latest()).toEqual(second);
  });

  it("survives a fresh instance against the same file — durable, not in-memory only", () => {
    const filePath = freshPath("predictions");
    const first = new ReportPredictionStore(filePath);
    first.save({ central: "Mom", recurring: "work", absent: "nothing" });

    const second = new ReportPredictionStore(filePath);
    expect(second.list()).toHaveLength(1);
  });

  it("a corrupted file degrades to an empty list rather than throwing — this is UI metadata, never the corpus", () => {
    const filePath = freshPath("predictions");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not valid json");
    const store = new ReportPredictionStore(filePath);
    expect(() => store.list()).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("creates its parent directory on first save if it doesn't exist yet", () => {
    const filePath = freshPath("nested/predictions");
    const store = new ReportPredictionStore(filePath);
    expect(() => store.save({ central: "x", recurring: "y", absent: "z" })).not.toThrow();
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
