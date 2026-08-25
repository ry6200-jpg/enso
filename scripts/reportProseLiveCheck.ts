/**
 * MAKES REAL LLM CALLS — costs real money every time it's run. Only runs
 * one if selectReportTopics finds at least one eligible topic (it prints
 * eligible-topic count first and exits before calling anything if there
 * are none, so an empty/thin corpus costs nothing). Not a fixture to run
 * repeatedly — see EN-120's own cost discipline (ONE live generation, no
 * repeated tuning on phrasing).
 *
 * One-off verification (not part of the app): runs the real report
 * pipeline (computeReport -> selectReportTopics -> generateReportProse)
 * against a given events.db/projections.db pair and prints the result
 * plainly to the terminal. Never touches GCS itself — pass it local file
 * paths (e.g. a preserved read-only snapshot; never point it at a live
 * checkout another process might still be using).
 *
 * Usage: node --env-file=.env --import tsx scripts/reportProseLiveCheck.ts <events.db path> <projections.db path> <uid>
 */
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { computeReport } from "../src/report/computeReport.js";
import { selectReportTopics } from "../src/report/reportTopics.js";
import { generateReportProse } from "../src/report/generateReportProse.js";

const [eventsPath, projectionsPath, uid] = process.argv.slice(2);
if (!eventsPath || !projectionsPath || !uid) {
  console.error("usage: node --env-file=.env --import tsx scripts/reportProseLiveCheck.ts <events.db> <projections.db> <uid>");
  process.exit(1);
}

const eventLog = new EventLog(eventsPath);
const projectionsDb = new ProjectionsDb(projectionsPath);

const report = computeReport(eventLog, projectionsDb, uid, "America/Los_Angeles");
console.log(`Corpus: ${report.corpus.totalMessages} messages, ${report.windows.length} windows.`);

const entities = projectionsDb.listEntities(uid).map((e) => ({ id: e.id, name: e.name, sourceEventIds: JSON.parse(e.source_event_ids) as string[] }));
const topics = selectReportTopics(report, entities);
console.log(`Eligible topics: ${topics.length}`);
for (const t of topics) console.log(`  - ${t.id} (${t.kind}, direction=${t.direction}, entity=${t.entityName}, ${t.sourceMessages.length} source messages, wordClassSupport=${t.hasSupportingWordClassSignal})`);

if (topics.length === 0) {
  console.log("\nNo topics eligible — generateReportProse will make zero API calls and return an empty report. Stopping here (nothing to generate).");
  eventLog.close();
  projectionsDb.close();
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set.");
  process.exit(1);
}

const result = await generateReportProse(report, entities, apiKey);
console.log(`\n=== Generated ${result.passages.length} passage(s) ===\n`);
for (const p of result.passages) {
  console.log(p.text);
  console.log(`[grounded in: ${p.topics.map((t) => t.id).join(", ")}]`);
  console.log();
}

const fullText = result.passages.map((p) => p.text).join(" ");
const BANNED_WORDS = ["concentration", "turnover", "density", "diversity", "burstiness", "deviation", "baseline"];
const hasDigit = /\d/.test(fullText);
const bannedWordHit = BANNED_WORDS.find((w) => fullText.toLowerCase().includes(w));
console.log("=== NO-NUMERAL / NO-METRIC-NAME GATE ===");
console.log(`Contains a digit: ${hasDigit}`);
console.log(`Contains a banned metric word: ${bannedWordHit ?? "none"}`);
console.log(hasDigit || bannedWordHit ? "GATE FAILED" : "GATE PASSED");

eventLog.close();
projectionsDb.close();
