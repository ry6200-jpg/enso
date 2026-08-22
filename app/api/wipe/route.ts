import { NextResponse } from "next/server";
import { resetDevData } from "../../../lib/serverPipeline.js";

const WIPE_CONFIRMATION_PHRASE = "wipe dev data";

/**
 * The web app's own wipe path — same confirmation phrase and same
 * underlying delete-and-recreate operation as the REPL's /wipe
 * (scripts/chat.ts), but running IN this process so it closes its own
 * cached SQLite connections first. A wipe triggered externally (the REPL)
 * while this server keeps running cannot reach this process's open file
 * descriptors — that's exactly the gap this route exists to close for the
 * surface where it actually matters (see resetDevData's comment).
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== WIPE_CONFIRMATION_PHRASE) {
    return NextResponse.json({ error: `confirm must be exactly "${WIPE_CONFIRMATION_PHRASE}"` }, { status: 400 });
  }

  resetDevData();
  return NextResponse.json({ wiped: true });
}
