/**
 * Minimal dev CLI for ingesting a test message (EN-010, Phase 2 Part 2).
 * No UI exists yet — this exists purely to exercise captureMessage() against
 * a real (non-test) database on disk.
 *
 * Usage:
 *   npx tsx scripts/ingestMessage.ts "some message text"
 *   npx tsx scripts/ingestMessage.ts --attachment-only
 */
import path from "node:path";
import { EventLog } from "../src/events/eventLog.js";
import { captureMessage } from "../src/capture/messageCapture.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

const DATA_DIR = path.join(process.cwd(), "data");

function main(): void {
  const args = process.argv.slice(2);
  const attachmentOnly = args.includes("--attachment-only");
  const text = args.find((a) => !a.startsWith("--"));

  if (!text && !attachmentOnly) {
    console.error('Usage: tsx scripts/ingestMessage.ts "message text" | --attachment-only');
    process.exit(1);
  }

  const eventLog = new EventLog(path.join(DATA_DIR, "events.db"));
  const event = captureMessage(eventLog, {
    userId: PRIMARY_USER_ID,
    text,
    attachmentCount: attachmentOnly ? 1 : 0
  });

  console.log(JSON.stringify(event, null, 2));
  eventLog.close();
}

main();
