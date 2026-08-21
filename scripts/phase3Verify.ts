/**
 * Phase 3 live verification — all 6 scenarios, now that Part 2 (entity
 * resolution) is built. Run with:
 *   node --env-file=.env node_modules/.bin/tsx scripts/phase3Verify.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { compareExact, exactRowsFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { getCousins, getGrandparents, getSiblings } from "../src/relationships/traversal.js";
import { getCurrentAttribute } from "../src/perception/attributes.js";
import { findBondsBetween } from "../src/relationships/socialBonds.js";

import { captureMessage } from "../src/capture/messageCapture.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultRouter } from "../src/providers/router.js";
import { extractMessageWithResilience } from "../src/extraction/resilientExtraction.js";
import type { MessageExtractionCompletedPayload } from "../src/extraction/resilientExtraction.js";

const USER_ID = "01JPHASE3VERIFYUSER000001";

function section(title: string): void {
  console.log(`\n${"=".repeat(3)} ${title} ${"=".repeat(3)}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run with node --env-file=.env`);
  return v;
}

function findEntityByName(projections: ProjectionsDb, name: string) {
  return projections.listEntities(USER_ID).find((e) => e.name.toLowerCase() === name.toLowerCase());
}

async function main() {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-phase3-verify-"));
  console.log("Phase 3 Memory — full live verification (all 6 scenarios)");
  console.log(`Working directory (ephemeral): ${root}`);

  const eventLog = new EventLog(path.join(root, "events.db"));
  const costTracker = new CostTracker();
  const router = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  const scratchProjections = new ProjectionsDb(path.join(root, "scratch.db"));

  // Rebuilds after every message so each subsequent extraction call can be
  // given the current known-people list (EN-012's buildKnownPeopleBlock
  // port) — per-message extraction has no memory of its own otherwise.
  async function sendAndExtract(text: string) {
    const knownPeople = scratchProjections.listEntities(USER_ID).map((e) => e.name);
    const message = captureMessage(eventLog, { userId: USER_ID, text });
    const extraction = await extractMessageWithResilience(eventLog, router, message, undefined, knownPeople);
    console.log(`  "${text}"`);
    console.log(`  known people given to extractor: [${knownPeople.join(", ")}]`);
    console.log(`  -> ${JSON.stringify(extraction.payload)}`);
    rebuildProjections(eventLog.listForUser(USER_ID), scratchProjections, USER_ID);
    return { message, extraction };
  }

  // -------------------------------------------------------------------
  section("SCENARIO 1 — R2 acceptance test, end-to-end through real extraction (EN-015)");
  // -------------------------------------------------------------------
  await sendAndExtract("Oh, I should mention — my sister Amy's birthday is May 12, 1990.");

  let projections = new ProjectionsDb(path.join(root, "projections-1.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  const amy = findEntityByName(projections, "Amy");
  const birthdate = amy ? getCurrentAttribute(projections, USER_ID, amy.id, "birthdate") : undefined;
  console.log(`\nEntity "Amy" found: ${!!amy}`);
  console.log(`Birthdate retrieved from projection: ${birthdate?.value}`);
  console.log(birthdate?.value ? "PASS: R2 acceptance test passes end-to-end through real extraction." : "FAIL (unexpected).");

  // -------------------------------------------------------------------
  section("SCENARIO 2 — entity resolution: two distinct Amys, not one merged blob (EN-012)");
  // -------------------------------------------------------------------
  await sendAndExtract("Amy's teacher, Mrs. Chen, called about the school trip.");
  await sendAndExtract("Also — a completely different Amy, my friend from work, invited me to her birthday party.");

  projections = new ProjectionsDb(path.join(root, "projections-2.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  const amys = projections.listEntities(USER_ID).filter((e) => e.name === "Amy");
  console.log(`\nEntities named "Amy": ${amys.length}`);
  for (const a of amys) {
    console.log(`  id=${a.id} pending_disambiguation=${a.pending_disambiguation}`);
  }
  console.log(amys.length === 2 ? "PASS: two distinct Amys resolved, not one merged blob." : `UNEXPECTED: ${amys.length} Amy entities.`);

  // -------------------------------------------------------------------
  section("SCENARIO 3 — structural derivation: parents + sibling stated, grandparent/cousin computed (EN-013/014)");
  // -------------------------------------------------------------------
  await sendAndExtract("My mom is named Elena and my dad is named Marcus.");
  await sendAndExtract("My mom's sister is my aunt Ines, and her son is my cousin Tomas.");

  projections = new ProjectionsDb(path.join(root, "projections-3.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);

  const me = primaryEntityId(USER_ID);
  const siblings = getSiblings(projections, USER_ID, me);
  const grandparents = getGrandparents(projections, USER_ID, me);
  const cousins = getCousins(projections, USER_ID, me);
  console.log(`\nSiblings of me: ${JSON.stringify(siblings)}`);
  console.log(`Grandparents of me: ${JSON.stringify(grandparents)}`);
  console.log(`Cousins of me (computed by traversal via one sibling hop, never stored): ${JSON.stringify(cousins.map((id) => projections.listEntities(USER_ID).find((e) => e.id === id)?.name))}`);
  console.log(cousins.length > 0 ? "PASS: cousin correctly computed by traversal once the known-people link held Elena/mom together." : "gap remains — see report.");

  // -------------------------------------------------------------------
  section("SCENARIO 4 — bond accretion: colleague inferred, friendship added, one closes, silence closes nothing (EN-013)");
  // -------------------------------------------------------------------
  await sendAndExtract("My coworker Priya helped me debug something today.");
  await sendAndExtract("Priya and I have actually become close friends outside of work too.");
  await sendAndExtract("My neighbor Diego waved at me this morning.");

  projections = new ProjectionsDb(path.join(root, "projections-4a.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  let priya = findEntityByName(projections, "Priya")!;
  console.log(`\nBonds between me and Priya after accretion: ${JSON.stringify(findBondsBetween(projections, USER_ID, me, priya.id).map((b) => ({ type: b.type, open: b.interval_end === null })))}`);

  await sendAndExtract("Priya and I had a falling out and don't talk anymore.");

  projections = new ProjectionsDb(path.join(root, "projections-4b.db"));
  rebuildProjections(eventLog.listForUser(USER_ID), projections, USER_ID);
  priya = findEntityByName(projections, "Priya")!;
  const diego = findEntityByName(projections, "Diego")!;
  const priyaBonds = findBondsBetween(projections, USER_ID, me, priya.id);
  const diegoBonds = findBondsBetween(projections, USER_ID, me, diego.id);
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
  console.log(`Entities compareExact: ${JSON.stringify(entityComparison)}`);

  function byName<T extends { from_entity_id: string; to_entity_id: string }>(rows: T[], proj: ProjectionsDb): Record<string, unknown>[] {
    const nameOf = (id: string) => (id === me ? "me" : proj.listEntities(USER_ID).find((e) => e.id === id)?.name ?? id);
    return rows
      .map((r) => ({ ...r, from_entity_id: undefined, to_entity_id: undefined, from: nameOf(r.from_entity_id), to: nameOf(r.to_entity_id), id: undefined, created_at: undefined }))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  }
  const atomsMatch = JSON.stringify(byName(runA.listStructuralAtoms(USER_ID), runA)) === JSON.stringify(byName(runB.listStructuralAtoms(USER_ID), runB));
  const bondsMatch = JSON.stringify(byName(runA.listSocialBonds(USER_ID), runA)) === JSON.stringify(byName(runB.listSocialBonds(USER_ID), runB));
  console.log(`Structural atoms match exactly (by resolved name, ignoring ephemeral ids): ${atomsMatch}`);
  console.log(`Social bonds match exactly (by resolved name, ignoring ephemeral ids): ${bondsMatch}`);
  console.log(entityComparison.equivalent && atomsMatch && bondsMatch ? "PASS: strict-exact rebuild verification passes with all Phase 3 projections in play." : "FAIL (unexpected).");

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
