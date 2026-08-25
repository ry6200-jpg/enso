/**
 * Standing corpus-readiness fixture (report page, Stage A). Reports corpus
 * size, window count, MIN_PRIOR_WINDOWS_FOR_BASELINE satisfaction, and
 * dormancy-candidate count for a given events.db/projections.db pair —
 * i.e. whether a corpus is deep enough to exercise the report layer's own
 * gates at all, before generating anything. Read-only, no LLM call, no
 * writes. Depends only on already-shipped Stage A code (computeReport,
 * baseline.ts) — deliberately does not report prose-layer topic
 * eligibility (that needs reportTopics.ts, still unshipped pending the
 * no-numeral gate; see scripts/reportProseLiveCheck.ts once that lands).
 *
 * Usage: npx tsx scripts/reportCorpusCheck.ts <events.db> <projections.db> <uid>
 */
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { computeReport } from "../src/report/computeReport.js";
import { MIN_PRIOR_WINDOWS_FOR_BASELINE } from "../src/report/markers/baseline.js";

const [eventsPath, projectionsPath, uid] = process.argv.slice(2);
if (!eventsPath || !projectionsPath || !uid) {
  console.error("usage: npx tsx scripts/reportCorpusCheck.ts <events.db> <projections.db> <uid>");
  process.exit(1);
}

const eventLog = new EventLog(eventsPath);
const projectionsDb = new ProjectionsDb(projectionsPath);

const report = computeReport(eventLog, projectionsDb, uid, "America/Los_Angeles");
console.log(`Messages: ${report.corpus.totalMessages}`);
console.log(`Span: ${report.corpus.firstMessageAt} -> ${report.corpus.lastMessageAt}`);
console.log(`Windows (windowDays=${report.windowDays}): ${report.windows.length}`);
console.log(`MIN_PRIOR_WINDOWS_FOR_BASELINE: ${MIN_PRIOR_WINDOWS_FOR_BASELINE}`);
console.log(`Windows with enough PRIOR windows for a baseline (index >= ${MIN_PRIOR_WINDOWS_FOR_BASELINE}): ${report.windows.filter((w) => w.index >= MIN_PRIOR_WINDOWS_FOR_BASELINE).length} of ${report.windows.length}`);

console.log(`\nDormancy candidates: ${report.network.dormancy.filter((d) => d.dormant).length} dormant of ${report.network.dormancy.length} established entities considered`);

eventLog.close();
projectionsDb.close();
