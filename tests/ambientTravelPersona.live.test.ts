/**
 * Live verification for ambient travel context (part 4). Real API calls;
 * run with `node --env-file=.env node_modules/.bin/vitest run tests/ambientTravelPersona.live.test.ts`
 * (needs OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_MAPS_API_KEY — see .env).
 * Per EN-091: never `.skipIf` on a missing key.
 *
 * A small number of real turns, not a suite re-run, per the batch's own
 * cost discipline. Case A: a real commute-timing message with real
 * coordinates and a real stated residence — confirms the router axis can
 * actually fire in practice and that the reply never announces the
 * ETA/traffic as a readout even when real data resolved. Case B: the
 * confabulation guard — a driving-adjacent message with NO origin
 * coordinates available at all (so no travel data can possibly resolve,
 * regardless of router judgment) — confirms Enso never gestures at drive/
 * traffic conditions ("hope the drive is easy") with nothing behind it.
 */
import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { sendMessage, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { configureLocalOnlyEmbeddings, createEmbedder, EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { createDefaultChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultIntentRouter } from "../src/conversation/router/intentRouter.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { primaryEntityId } from "../src/projections/rebuild.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

const unusedEmbedder: Embedder = {
  async embed(): Promise<Float32Array> {
    throw new Error("embedder should not be called — this file's cases avoid retrieval mode explicitly");
  },
  modelId: "unused-in-this-file",
  dimensions: EMBEDDING_DIMENSIONS
};

/**
 * Same shape as currentLocationPersona.live.test.ts's own
 * freshDepsWithAmbient — the router flag (travelContext, same as
 * ambientContext before it) needs a real local embedder and no
 * retrievalOverride to actually run, since retrievalOverride and
 * deps.intentRouter are mutually exclusive branches in chatPipeline.ts.
 */
async function freshDepsWithRouter(): Promise<SendMessageDeps> {
  configureLocalOnlyEmbeddings();
  return {
    eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
    retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
    projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
    embedder: await createEmbedder(),
    chatRouter: createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }),
    intentRouter: createDefaultIntentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }),
    googleMapsApiKey: requireEnv("GOOGLE_MAPS_API_KEY")
  };
}

describe("Ambient travel context (part 4, live, real API)", () => {
  it("case A — a real commute-timing message with real coordinates and a stated residence: never announces the ETA or reports traffic, even when real travel data resolves", async () => {
    const deps = await freshDepsWithRouter();
    // A real, geocodable residence for the primary user — the fallback destination.
    deps.projectionsDb.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "location",
      value: "Pasadena, California",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "I need to wrap up soon and start heading home before rush hour really kicks in.",
      recentTurns: [],
      locationContext: { placeName: "Hollywood, California", tier: "geolocation", timezone: "America/Los_Angeles" },
      ownCoordinates: { latitude: 34.1016, longitude: -118.326 }
    });

    console.log("\n=== Case A (real commute-timing message) ===\nUser: I need to wrap up soon and start heading home before rush hour really kicks in.\nEnso:", result.replyText, "\n");
    const ambientMatch = result.debug.systemPrompt.match(/=== AMBIENT CONTEXT \(begin\) ===[\s\S]*?=== AMBIENT CONTEXT \(end\) ===/);
    console.log("=== Case A ambient block actually seen by the model ===\n", ambientMatch ? ambientMatch[0] : "(none — block absent)", "\n");
    console.log("=== Case A router provenance ===\n", JSON.stringify((result.replyEvent.payload as { router?: unknown }).router), "\n");
    console.log("=== Case A travelContext provenance ===\n", JSON.stringify((result.replyEvent.payload as { contextProvenance?: { travelContext?: unknown } }).contextProvenance?.travelContext), "\n");

    // The confabulation/announce guard holds regardless of whether the router actually fired
    // this specific run (stochastic — see the file-level comment, no N=20 bar needed here).
    const announcesEta = /\b\d+[\s-]?(minute|min|hour|hr)s?\b.*\b(drive|away|traffic)\b/i.test(result.replyText);
    const reportsTraffic = /\btraffic (is|looks|seems)\b/i.test(result.replyText);
    expect(announcesEta).toBe(false);
    expect(reportsTraffic).toBe(false);
  }, 30000);

  it("case B — confabulation guard: a driving-adjacent message with NO origin coordinates available never gestures at drive/traffic conditions with no basis", async () => {
    const deps = await freshDepsWithRouter();

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Heading out now, driving back home. Long day.",
      recentTurns: [],
      ownCoordinates: null
    });

    console.log("=== Case B (no origin available, confabulation guard) ===\nUser: Heading out now, driving back home. Long day.\nEnso:", result.replyText, "\n");

    const gesturesAtConditions = /\b(hope|hoping) (the |your )?drive\b/i.test(result.replyText) || /\btraffic (is|looks|should be|will be)\b/i.test(result.replyText) || /\beasy drive\b/i.test(result.replyText);
    expect(gesturesAtConditions).toBe(false);
  }, 30000);
});
