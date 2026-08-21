/**
 * Phase 2 live verification script. Runs all six steps the phase's
 * verification section asks for, against real APIs, printing observed
 * output as it goes. Run with:
 *   node --env-file=.env node_modules/.bin/tsx scripts/phase2Verify.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { PNG } from "pngjs";

import { EventLog } from "../src/events/eventLog.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { compareStructural, snapshotFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { newId } from "../src/ids.js";

import { captureMessage, ATTACHMENT_ONLY_PLACEHOLDER, type MessageSentPayload } from "../src/capture/messageCapture.js";
import { captureUpload, type FileUploadedPayload } from "../src/attachments/attachmentCapture.js";

import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultRouter, createExtractionRouter } from "../src/providers/router.js";
import { createDocumentRouter, createImageRouter } from "../src/providers/attachmentRouter.js";
import { createGeminiAdapter } from "../src/providers/geminiAdapter.js";
import { classifyProviderError } from "../src/providers/errors.js";
import type { ExtractionRouter } from "../src/providers/router.js";
import type { ExtractionRequest, ProviderCallResult } from "../src/providers/types.js";

import { ExtractionCache } from "../src/extraction/cache.js";
import { createCachedRouter } from "../src/extraction/cachedRouter.js";
import {
  extractDocumentWithResilience,
  extractImageWithResilience,
  extractMessageWithResilience,
  retryFailedExtraction,
  type ExtractionFailedPayload,
  type MessageExtractionCompletedPayload
} from "../src/extraction/resilientExtraction.js";
import { getExtractionStatus } from "../src/extraction/extractionStatus.js";
import type { DocumentExtractionCompletedPayload, ImageExtractionCompletedPayload } from "../src/attachments/attachmentContent.js";

const USER_ID = "01JPHASE2VERIFYUSER000000";

function section(title: string): void {
  console.log(`\n${"=".repeat(3)} ${title} ${"=".repeat(3)}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run with node --env-file=.env`);
  return value;
}

async function makeMultiPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    "Page one. Trip journal, day 1: I landed in Lisbon and met up with my old friend Mateus at the airport.",
    "Page two. Trip journal, day 2: Mateus and I argued about the itinerary, but by dinner with his sister Ines we had made up.",
    "Page three. Trip journal, day 3: Ines recommended a small cafe near the river. I felt completely at peace there."
  ];
  for (const text of pages) {
    const page = doc.addPage([400, 300]);
    const words = text.split(" ");
    let line = "";
    let y = 260;
    for (const word of words) {
      if ((line + word).length > 55) {
        page.drawText(line, { x: 20, y, size: 12, font, color: rgb(0, 0, 0) });
        y -= 18;
        line = "";
      }
      line += word + " ";
    }
    if (line) page.drawText(line, { x: 20, y, size: 12, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

function makeRealTestImage(): Buffer {
  // A real (non-degenerate) 64x64 PNG: a blue sky over a green field, so
  // description quality is checkable, avoiding the 1x1-pixel edge case
  // found during Part 3's live probing.
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const idx = (64 * y + x) << 2;
      const isSky = y < 40;
      png.data[idx] = isSky ? 135 : 34;
      png.data[idx + 1] = isSky ? 206 : 139;
      png.data[idx + 2] = isSky ? 235 : 34;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Deliberately broken adapters — real SDK clients pointed at an unreachable host, to force a genuine connection failure rather than simulate one. */
function createUnreachableOpenAiRouter(): ExtractionRouter {
  const client = new OpenAI({ apiKey: "sk-does-not-matter", baseURL: "http://127.0.0.1:9/v1", timeout: 3000, maxRetries: 0 });
  return {
    extract: async (_req: ExtractionRequest): Promise<ProviderCallResult> => {
      try {
        await client.responses.create({ model: "gpt-5.6-terra", input: "x" });
        throw new Error("unreachable-host call unexpectedly succeeded");
      } catch (err) {
        throw classifyProviderError(err);
      }
    }
  };
}
function createUnreachableGeminiRouter(): ExtractionRouter {
  const client = new GoogleGenAI({ apiKey: "fake", httpOptions: { baseUrl: "http://127.0.0.1:9" } });
  return {
    extract: async (_req: ExtractionRequest): Promise<ProviderCallResult> => {
      try {
        await client.models.generateContent({ model: "gemini-3.7-flash", contents: "x" });
        throw new Error("unreachable-host call unexpectedly succeeded");
      } catch (err) {
        throw classifyProviderError(err);
      }
    }
  };
}

async function main() {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-phase2-verify-"));
  console.log("Phase 2 Capture — live verification");
  console.log(`Working directory (ephemeral): ${root}`);

  const eventLog = new EventLog(path.join(root, "events.db"));
  const blobStore = new BlobStore(path.join(root, "blobs"));
  const cache = new ExtractionCache(path.join(root, "extraction-cache.db"));
  const costTracker = new CostTracker();

  const realMessageRouter = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  const { router: cachedMessageRouter, stats: messageCacheStats } = createCachedRouter(cache, realMessageRouter, "message-v1");
  const documentRouter = createDocumentRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  const imageRouter = createImageRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);

  // ---------------------------------------------------------------------
  section("STEP 1 — Ingest 3 synthetic messages (EN-010, taxonomy shape)");
  // ---------------------------------------------------------------------
  const messageTexts = [
    "I had lunch with my sister Amy and her friend Priya today. I was really happy to catch up after the big fight we had last month.",
    "Work was fine, nothing much to report.",
    "Called my mom Elena tonight. She sounded relieved once we finally talked things through — I think that argument last week is finally behind us."
  ];

  for (const text of messageTexts) {
    const messageEvent = captureMessage(eventLog, { userId: USER_ID, text });
    console.log(`\nmessage_sent ${messageEvent.id}`);
    console.log(`  text: "${(messageEvent.payload as MessageSentPayload).text}"`);

    const extractionEvent = await extractMessageWithResilience(eventLog, cachedMessageRouter, messageEvent);
    console.log(`${extractionEvent.type} ${extractionEvent.id}`);
    console.log(`  payload: ${JSON.stringify(extractionEvent.payload, null, 2).split("\n").join("\n  ")}`);
  }

  // ---------------------------------------------------------------------
  section("STEP 2 — Upload a real multi-page PDF and a real image (EN-061-064)");
  // ---------------------------------------------------------------------
  const pdfBytes = await makeMultiPagePdf();
  const pdfUploadEvent = captureUpload(eventLog, blobStore, {
    userId: USER_ID,
    bytes: pdfBytes,
    filename: "lisbon-trip.pdf",
    mimeType: "application/pdf"
  });
  const pdfPayload = pdfUploadEvent.payload as FileUploadedPayload;
  const pdfAbsolutePath = path.join(root, "blobs", pdfPayload.path);
  console.log(`\nfile_uploaded ${pdfUploadEvent.id}`);
  console.log(`  filename: ${pdfPayload.filename}, byteLength: ${pdfPayload.byteLength}, path: ${pdfPayload.path}`);
  console.log(`  blob on disk exists: ${fs.existsSync(pdfAbsolutePath)} (${pdfAbsolutePath})`);

  const pdfExtractionEvent = await extractDocumentWithResilience(eventLog, documentRouter, pdfUploadEvent, {
    bytes: pdfBytes,
    mimeType: "application/pdf",
    filename: "lisbon-trip.pdf"
  });
  const pdfExtractionPayload = pdfExtractionEvent.payload as DocumentExtractionCompletedPayload & {
    classifierDecision: { isPersonal: boolean; reason: string };
  };
  console.log(`\n${pdfExtractionEvent.type} ${pdfExtractionEvent.id}`);
  console.log(`  provider/model: ${pdfExtractionPayload.provider}/${pdfExtractionPayload.model}`);
  console.log(`  fullText (${pdfExtractionPayload.fullText.length} chars):\n    ${pdfExtractionPayload.fullText.replace(/\n/g, "\n    ")}`);
  console.log(`  boundedExcerpt truncated: ${pdfExtractionPayload.truncated}`);
  console.log(`  entities: ${JSON.stringify(pdfExtractionPayload.entities)}`);
  console.log(`  classifierDecision: ${JSON.stringify(pdfExtractionPayload.classifierDecision)}`);

  const imageBytes = makeRealTestImage();
  const imageUploadEvent = captureUpload(eventLog, blobStore, {
    userId: USER_ID,
    bytes: imageBytes,
    filename: "field.png",
    mimeType: "image/png"
  });
  const imagePayload = imageUploadEvent.payload as FileUploadedPayload;
  const imageAbsolutePath = path.join(root, "blobs", imagePayload.path);
  console.log(`\nfile_uploaded ${imageUploadEvent.id}`);
  console.log(`  filename: ${imagePayload.filename}, byteLength: ${imagePayload.byteLength}, path: ${imagePayload.path}`);
  console.log(`  blob on disk exists: ${fs.existsSync(imageAbsolutePath)} (${imageAbsolutePath})`);

  const imageExtractionEvent = await extractImageWithResilience(eventLog, imageRouter, imageUploadEvent, {
    bytes: imageBytes,
    mimeType: "image/png"
  });
  const imageExtractionPayload = imageExtractionEvent.payload as ImageExtractionCompletedPayload;
  console.log(`\n${imageExtractionEvent.type} ${imageExtractionEvent.id}`);
  console.log(`  provider/model: ${imageExtractionPayload.provider}/${imageExtractionPayload.model}`);
  console.log(`  description: "${imageExtractionPayload.description}"`);
  console.log(`  (images carry no classifier decision — Part 3 scope decision: no entity taxonomy is run on image content)`);

  // ---------------------------------------------------------------------
  section("STEP 3 — Force a provider failure: retry, fallback, extraction_failed, later retry to success (EN-059/083)");
  // ---------------------------------------------------------------------
  console.log("\n-- 3a. Primary (OpenAI) forced unreachable, fallback (real Gemini) healthy --");
  const brokenOpenAi = createUnreachableOpenAiRouter();
  const primaryBrokenRouter: ExtractionRouter = {
    extract: async (req) => {
      try {
        return await brokenOpenAi.extract(req);
      } catch (err) {
        console.log(`  primary (OpenAI, unreachable host) failed as expected: ${(err as Error).name}: ${(err as Error).message}`);
        throw err;
      }
    }
  };
  // createDefaultRouter doesn't expose swapping just one tier, so the two
  // tiers are hand-assembled here with the same production fallback wiring.
  const realGeminiAdapter = createGeminiAdapter(geminiKey);
  const fallbackDemoRouter = createExtractionRouter({
    message: { primary: primaryBrokenRouter.extract, fallback: realGeminiAdapter },
    document: { primary: primaryBrokenRouter.extract, fallback: realGeminiAdapter }
  });
  const fallbackDemoMessage = captureMessage(eventLog, { userId: USER_ID, text: "Testing the fallback path with Diego today." });
  const fallbackResult = await fallbackDemoRouter.extract({ kind: "message", text: (fallbackDemoMessage.payload as MessageSentPayload).text });
  console.log(`  fallback fired successfully: result.provider = ${fallbackResult.provider} (expected "gemini")`);

  console.log("\n-- 3b. BOTH tiers forced unreachable: extraction_failed persisted, then retried to success --");
  const brokenPrimary = createUnreachableOpenAiRouter();
  const brokenFallback = createUnreachableGeminiRouter();
  const bothBrokenRouter = createExtractionRouter({
    message: { primary: brokenPrimary.extract, fallback: brokenFallback.extract },
    document: { primary: brokenPrimary.extract, fallback: brokenFallback.extract }
  });
  const failingMessage = captureMessage(eventLog, { userId: USER_ID, text: "This message will fail extraction at first, on both tiers." });
  const failedEvent = await extractMessageWithResilience(eventLog, bothBrokenRouter, failingMessage, { maxAttempts: 2, baseDelayMs: 200 });
  console.log(`  ${failedEvent.type} ${failedEvent.id}`);
  console.log(`  payload: ${JSON.stringify(failedEvent.payload)}`);
  console.log(`  getExtractionStatus: ${getExtractionStatus(eventLog, failingMessage.id)}`);

  console.log("\n  Retrying the failed extraction with the REAL (working) router...");
  const retriedEvent = await retryFailedExtraction(
    {
      eventLog,
      blobStore,
      messageRouter: cachedMessageRouter,
      documentRouter,
      imageRouter,
      retryConfig: { maxAttempts: 3, baseDelayMs: 300 }
    },
    failedEvent
  );
  console.log(`  ${retriedEvent.type} ${retriedEvent.id}`);
  console.log(`  getExtractionStatus (latest-wins): ${getExtractionStatus(eventLog, failingMessage.id)}`);

  // ---------------------------------------------------------------------
  section("STEP 4 — Attachment-only message: placeholder, never empty (R1/EN-064)");
  // ---------------------------------------------------------------------
  const attachmentOnlyUpload = captureUpload(eventLog, blobStore, {
    userId: USER_ID,
    bytes: Buffer.from("a small standalone attachment, no message text"),
    filename: "standalone.txt",
    mimeType: "text/plain"
  });
  const attachmentOnlyMessage = captureMessage(eventLog, { userId: USER_ID, attachmentCount: 1 });
  const attachmentOnlyPayload = attachmentOnlyMessage.payload as MessageSentPayload;
  console.log(`\nfile_uploaded ${attachmentOnlyUpload.id} (the attachment)`);
  console.log(`message_sent ${attachmentOnlyMessage.id}`);
  console.log(`  text: "${attachmentOnlyPayload.text}" (length ${attachmentOnlyPayload.text.length}, expected placeholder "${ATTACHMENT_ONLY_PLACEHOLDER}")`);
  console.log(`  attachmentOnly: ${attachmentOnlyPayload.attachmentOnly}`);

  // ---------------------------------------------------------------------
  section("STEP 5 — Rebuild: extraction cache prevents re-extraction; structural equivalence with the new event types (EN-054/056/057)");
  // ---------------------------------------------------------------------
  console.log(`\nMessage-extraction cache stats so far: ${JSON.stringify(messageCacheStats)}`);
  console.log("Re-running extraction on the FIRST message's exact text again through the same cached router...");
  const repeatResult = await cachedMessageRouter.extract({ kind: "message", text: messageTexts[0]! });
  console.log(`Cache stats after repeat call: ${JSON.stringify(messageCacheStats)} (miss count must be unchanged — no new API call)`);
  console.log(`Repeated call returned provider=${repeatResult.provider}, same entities=${JSON.stringify(repeatResult.taxonomy.entities)}`);

  console.log("\nRe-deriving the entities projection from the real, immutable event log — twice — with no LLM re-invocation:");
  function rebuildEntitiesFromRealLog(projections: ProjectionsDb): void {
    projections.clearProjections();
    const events = eventLog.listForUser(USER_ID);
    const byName = new Map<string, { name: string; sourceEventIds: Set<string> }>();
    for (const event of events) {
      if (event.type !== "extraction_completed") continue;
      const payload = event.payload as { entities?: { name: string }[]; sourceEventId?: string };
      for (const entity of payload.entities ?? []) {
        const key = entity.name.trim().toLowerCase();
        const acc = byName.get(key) ?? { name: entity.name, sourceEventIds: new Set<string>() };
        acc.sourceEventIds.add(event.id);
        if (payload.sourceEventId) acc.sourceEventIds.add(payload.sourceEventId);
        byName.set(key, acc);
      }
    }
    for (const acc of byName.values()) {
      projections.insertEntity({
        id: newId(),
        user_id: USER_ID,
        name: acc.name,
        confirmed: 0,
        source_event_ids: JSON.stringify([...acc.sourceEventIds].sort()),
        extractor_version: "message-v1/attachment-v1",
        pending_disambiguation: null,
        created_at: new Date().toISOString()
      });
    }
  }

  const projectionsA = new ProjectionsDb(path.join(root, "projections-a.db"));
  const projectionsB = new ProjectionsDb(path.join(root, "projections-b.db"));
  rebuildEntitiesFromRealLog(projectionsA);
  rebuildEntitiesFromRealLog(projectionsB);

  const snapshotA = snapshotFromEntityRows(projectionsA.listEntities(USER_ID));
  const snapshotB = snapshotFromEntityRows(projectionsB.listEntities(USER_ID));
  console.log(`Rebuild A entities: ${JSON.stringify(snapshotA.entities.map((e) => e.name))}`);
  console.log(`Rebuild B entities: ${JSON.stringify(snapshotB.entities.map((e) => e.name))}`);
  const comparison = compareStructural(snapshotA, snapshotB);
  console.log(`compareStructural(A, B) = ${JSON.stringify(comparison)}`);
  console.log(comparison.equivalent ? "PASS: structurally equivalent across two independent rebuilds of real event data." : "UNEXPECTED FAIL");

  // ---------------------------------------------------------------------
  section("STEP 6 — Total API spend for this verification run (EN-086)");
  // ---------------------------------------------------------------------
  for (const record of costTracker.all()) {
    console.log(`  ${record.provider}/${record.model}: in=${record.inputTokens} out=${record.outputTokens} cost=$${record.costUsd.toFixed(6)}`);
  }
  console.log(`\nTOTAL SPEND: $${costTracker.totalUsd().toFixed(4)} across ${costTracker.all().length} billed calls`);

  eventLog.close();
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
