import { NextResponse } from "next/server";
import { resetUserData } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";

const WIPE_CONFIRMATION_PHRASE = "wipe dev data";

/**
 * The web app's own wipe path — running IN this process so it closes its
 * own cached SQLite connections first (see resetUserData's comment for
 * the orphaned-connection bug this exists to close).
 *
 * Cloud migration prerequisite batch: this route was NOT previously one
 * of the identity-bearing routes at all — it wiped the entire shared
 * dev-data directory unconditionally, which is exactly wrong once data is
 * per-user. It is now a 10th authenticated route, scoped strictly to the
 * calling user's own directory (resetUserData(uid)) — it can never touch
 * another user's data, by construction, not by convention.
 */
export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== WIPE_CONFIRMATION_PHRASE) {
    return NextResponse.json({ error: `confirm must be exactly "${WIPE_CONFIRMATION_PHRASE}"` }, { status: 400 });
  }

  await resetUserData(userId);
  return NextResponse.json({ wiped: true });
}
