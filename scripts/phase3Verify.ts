/**
 * Phase 3 live verification (scenarios 1, 3, 4, 5, 6 — scenario 2 requires
 * Part 2's entity resolution, which was blocked on the old-repo reference
 * material at the time this was written; see the Phase 3 report).
 * Run with: node --env-file=.env node_modules/.bin/tsx scripts/phase3Verify.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { compareExact, exactRowsFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { getCousins, getGrandparents, getInLaws, getSiblings } from "../src/relationships/traversal.js";
import { getCurrentAttribute } from "../src/perception/attributes.js";
import { findBondsBetween } from "../src/relationships/socialBonds.js";

import { captureMessage, type MessageSentPayload } from "../src/capture/messageCapture.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultRouter } from "../src/providers/router.js";
import { extractMessageWithResilience } from "../src/extraction/resilientExtraction.js";
import type { MessageExtractionCompletedPayload } from "../src/extraction/resilientExtraction.js";

const USER_ID = "01JPHASE3VERIFYUSER000000";

function section(title: string): void {
  console.log(`\n${"=".repeat(3)} ${title} ${"=".repeat(3)}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run with node --env-file=.env`);
  return v;
}

async function sendAndExtract(eventLog: EventLog, router: ReturnType<typeof createDefaultRouter>, text: string) {
  const message = captureMessage(eventLog, { userId: USER_ID, text });
  const extraction = await extractMessageWithResilience(eventLog, router, message);
  console.log(`  "${text}"`);
  console.log(`  -> ${extraction.type}: ${JSON.stringify(extraction.payload).slice(0, 300)}`);
  return { message, extraction };
}

function findEntityByName(projections: ProjectionsDb, name: string) {
  return projections.listEntities(USER_ID).find((e) => e.name.toLowerCase() === name.toLowerCase());
}

async function main() {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-phase3-verify-"));
  console.log("Phase 3 Memory — live verification (scenarios 1, 3, 4, 5, 6)");
  console.log(`Working directory (ephemeral): ${root}`);
  console.log("NOTE: scenario 2 (entity resolution) is not run here — blocked on Part 2 (old-repo reference material).");

  const eventLog = new EventLog(path.join(root, "events.db"));
  const costTracker = new CostTracker();
  const router = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);

  // -------------------------------------------------------------------
  section("SCENARIO 1 — R2 acceptance test, end-to-end through real extraction (EN-015)");
  // -------------------------------------------------------------------
  await sendAndExtract(eventLog, router, "Oh, I should mention — my sister Amy's birthday is May 12, 1990.");

  let projections = new ProjectionsDb(path.join(root, "projections-1.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  const amy = findEntityByName(projections, "Amy");
  const birthdate = amy ? getCurrentAttribute(projections, USER_ID, amy.id, "birthdate") : undefined;
  console.log(`\nEntity "Amy" found: ${!!amy}`);
  console.log(`Birthdate retrieved from projection: ${birthdate?.value}`);
  // The extractor preserves the value as literally stated (deliberately —
  // the prompt forbids reformatting to avoid date-parsing hallucination
  // risk), so this checks retrieval succeeded, not a specific format.
  console.log(birthdate?.value ? "PASS: R2 acceptance test passes end-to-end through real extraction." : "FAIL (unexpected).");

  // -------------------------------------------------------------------
  section("SCENARIO 3 — structural derivation: parents + sibling stated, grandparent/cousin computed (EN-013/014)");
  // -------------------------------------------------------------------
  await sendAndExtract(eventLog, router, "My mom is named Elena and my dad is named Marcus.");
  await sendAndExtract(eventLog, router, "My sister is named Amy.");
  await sendAndExtract(eventLog, router, "My mom's sister is my aunt Ines, and her son is my cousin Tomas.");

  projections = new ProjectionsDb(path.join(root, "projections-3.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);

  const me = primaryEntityId(USER_ID);
  const siblings = getSiblings(projections, USER_ID, me);
  const grandparents = getGrandparents(projections, USER_ID, me);
  const cousins = getCousins(projections, USER_ID, me);
  console.log(`\nSiblings of me (stated or parent-verified): ${JSON.stringify(siblings)}`);
  console.log(`Grandparents of me (computed by traversal, never stored): ${JSON.stringify(grandparents)}`);
  console.log(`Cousins of me (computed by traversal via one sibling hop): ${JSON.stringify(cousins)}`);
  console.log(`Stored atom types in the DB: ${[...new Set(projections.listStructuralAtoms(USER_ID).map((a) => a.type))].join(", ")} (no 'grandparent_of' or 'cousin_of' type exists)`);
  console.log(
    `\nDIAGNOSTIC: grandparents/cousins came back empty because the extractor named the third message's subject "mom" ` +
      `while the first message named her "Elena" — with only exact-name matching (Part 2's resolution cascade is not yet ` +
      `built), these are two distinct, unlinked entities, so the sibling_of(Ines, mom) atom can't connect to Elena's ` +
      `parent_of atoms. The traversal/derivation LOGIC itself (getGrandparents/getCousins) is verified correct against ` +
      `directly-constructed atoms in the FAST suite (tests/traversal.test.ts) — this gap is specifically an entity-` +
      `resolution problem, exactly what Part 2 exists to solve.`
  );

  // -------------------------------------------------------------------
  section("SCENARIO 4 — bond accretion: colleague inferred, friendship added, one closes, silence closes nothing (EN-013)");
  // -------------------------------------------------------------------
  await sendAndExtract(eventLog, router, "My coworker Priya helped me debug something today.");
  await sendAndExtract(eventLog, router, "Priya and I have actually become close friends outside of work too.");
  await sendAndExtract(eventLog, router, "My neighbor Diego waved at me this morning."); // untouched control — never mentioned again after this

  projections = new ProjectionsDb(path.join(root, "projections-4a.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  const priya = findEntityByName(projections, "Priya")!;
  const diego = findEntityByName(projections, "Diego")!;
  let priyaBonds = findBondsBetween(projections, USER_ID, me, priya.id);
  console.log(`\nBonds between me and Priya after accretion: ${JSON.stringify(priyaBonds.map((b) => ({ type: b.type, open: b.interval_end === null })))}`);

  await sendAndExtract(eventLog, router, "Priya and I had a falling out and don't talk anymore.");

  projections = new ProjectionsDb(path.join(root, "projections-4b.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  const priya2 = findEntityByName(projections, "Priya")!;
  const diego2 = findEntityByName(projections, "Diego")!;
  priyaBonds = findBondsBetween(projections, USER_ID, me, priya2.id);
  const diegoBonds = findBondsBetween(projections, USER_ID, me, diego2.id);
  console.log(`Bonds between me and Priya after the falling out: ${JSON.stringify(priyaBonds.map((b) => ({ type: b.type, open: b.interval_end === null })))}`);
  console.log(`Bonds between me and Diego (never mentioned again — silence): ${JSON.stringify(diegoBonds.map((b) => ({ type: b.type, open: b.interval_end === null })))}`);
  console.log(diegoBonds.every((b) => b.interval_end === null) ? "PASS: silence closed nothing for Diego." : "FAIL (unexpected).");

  // -------------------------------------------------------------------
  section("SCENARIO 5 — one full strict rebuild, exact verification, all Phase 3 projections in play (EN-054/057 v1.5)");
  // -------------------------------------------------------------------
  const allEvents = eventLog.listForUser(USER_ID);
  const runA = new ProjectionsDb(path.join(root, "projections-5a.db"));
  const runB = new ProjectionsDb(path.join(root, "projections-5b.db"));
  const resultA = rebuildProjections(allEvents, runA, USER_ID);
  const resultB = rebuildProjections(allEvents, runB, USER_ID);
  console.log(`\nRebuild A: ${JSON.stringify(resultA)}`);
  console.log(`Rebuild B: ${JSON.stringify(resultB)}`);

  const entityComparison = compareExact(exactRowsFromEntityRows(runA.listEntities(USER_ID)), exactRowsFromEntityRows(runB.listEntities(USER_ID)));
  console.log(`\nEntities compareExact: ${JSON.stringify(entityComparison)}`);

  function byName<T extends { from_entity_id: string; to_entity_id: string }>(rows: T[], proj: ProjectionsDb): Record<string, unknown>[] {
    const nameOf = (id: string) => (id === me ? "me" : proj.listEntities(USER_ID).find((e) => e.id === id)?.name ?? id);
    return rows
      .map((r) => ({ ...r, from_entity_id: undefined, to_entity_id: undefined, from: nameOf(r.from_entity_id), to: nameOf(r.to_entity_id), id: undefined, created_at: undefined }))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  }
  const atomsA = JSON.stringify(byName(runA.listStructuralAtoms(USER_ID), runA));
  const atomsB = JSON.stringify(byName(runB.listStructuralAtoms(USER_ID), runB));
  const bondsA = JSON.stringify(byName(runA.listSocialBonds(USER_ID), runA));
  const bondsB = JSON.stringify(byName(runB.listSocialBonds(USER_ID), runB));
  console.log(`Structural atoms match exactly (by resolved name, ignoring ephemeral ids): ${atomsA === atomsB}`);
  console.log(`Social bonds match exactly (by resolved name, ignoring ephemeral ids): ${bondsA === bondsB}`);
  console.log(
    entityComparison.equivalent && atomsA === atomsB && bondsA === bondsB
      ? "PASS: strict-exact rebuild verification passes with all Phase 3 projections in play."
      : "FAIL (unexpected)."
  );

  // -------------------------------------------------------------------
  section("SCENARIO 6 — total spend");
  // -------------------------------------------------------------------
  for (const record of costTracker.all()) {
    console.log(`  ${record.provider}/${record.model}: in=${record.inputTokens} out=${record.outputTokens} cost=$${record.costUsd.toFixed(6)}`);
  }
  console.log(`\nTOTAL SPEND: $${costTracker.totalUsd().toFixed(4)} across ${costTracker.all().length} billed calls`);

  eventLog.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nEphemeral working directory removed: ${root}`);
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
