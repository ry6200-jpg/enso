import fs from "node:fs";
import path from "node:path";
import { newId } from "../ids.js";

/**
 * Report page, Stage A (methodology Section 4.1: prediction capture).
 * "Before the report is generated, the user records what they expect it
 * to show... Stored, timestamped, shown side by side with the result
 * afterward." Deliberately a plain JSON file, not a SQLite table or a
 * new event type — this is metadata about a report-viewing session, not
 * corpus content, and the report "must never write to" the event log or
 * projections (this batch's own instruction, matching the methodology's
 * own Section 6 recommendation: the report reads the event log and never
 * writes to it, or its later analysis would be reading its own
 * influence). Plain-file discipline mirrors BlobStore's own simplicity —
 * this data has no need for SQL.
 */

export interface ReportPrediction {
  id: string;
  createdAt: string;
  central: string;
  recurring: string;
  absent: string;
}

interface PredictionFileShape {
  predictions: ReportPrediction[];
}

export class ReportPredictionStore {
  constructor(private readonly filePath: string) {}

  private readAll(): ReportPrediction[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PredictionFileShape;
      return Array.isArray(parsed.predictions) ? parsed.predictions : [];
    } catch {
      // A corrupted or partially-written file degrades to "no predictions on record" rather than
      // throwing — this is supplementary UI metadata, not the corpus; losing it is never a data-loss event.
      return [];
    }
  }

  /** Appends a new, timestamped prediction and returns it. Never edits or removes an existing one — predictions are themselves a small append-only record of what the owner expected, turn by turn, over time. */
  save(input: { central: string; recurring: string; absent: string }): ReportPrediction {
    const prediction: ReportPrediction = { id: newId(), createdAt: new Date().toISOString(), ...input };
    const all = [...this.readAll(), prediction];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ predictions: all } satisfies PredictionFileShape, null, 2));
    return prediction;
  }

  list(): ReportPrediction[] {
    return this.readAll();
  }

  latest(): ReportPrediction | null {
    const all = this.readAll();
    return all.length > 0 ? all[all.length - 1]! : null;
  }
}
