import { NextResponse } from "next/server";
import { getPeopleView } from "../../../src/projections/peopleView.js";
import { getDevUserId, getStores } from "../../../lib/serverPipeline.js";

/**
 * Backs the People view (Phase 7 Part 2): every entity Enso holds, with
 * every attribute/relationship value traceable to its source ("you told
 * me this on ..."). Read-only — deletion for these surfaces is stubbed
 * visibly in the UI, not silently omitted (see app/people/page.tsx): the
 * spec's one detailed one-click deletion flow, EN-065, is specifically
 * for ATTACHMENT deletion (Section 7); there is no separately-spec'd
 * entity/fact-level deletion UX to build against here.
 */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { eventLog, projectionsDb } = getStores();
  return NextResponse.json({ people: getPeopleView(eventLog, projectionsDb, userId) });
}
