import { NextResponse } from "next/server";
import { runReadOnlyUserSession } from "../../../lib/serverPipeline.js";
import { requireAdminUserId } from "../../../lib/requireUser.js";
import { computeEntityDirectory, computeFillRates } from "../../../src/admin/entityDirectory.js";

/**
 * Admin-only entity view (part 2). Deliberately named something
 * unremarkable — not /api/admin/... — since hiding the menu item is
 * secondary, not the control: the real gate is requireAdminUserId
 * below, checked server-side against the verified token's own email
 * (never anything the client sends), and a failed check returns a bare
 * 404 before any session/DB work runs at all, revealing nothing about
 * whether this route even exists to a non-admin caller.
 *
 * Reads only the signed-in admin's OWN database — runReadOnlyUserSession
 * is called with the admin's own verified uid, the same as every other
 * route in this app; there is no field anywhere in this file a caller
 * could set to read a DIFFERENT user's data. A cross-user view would
 * need a genuinely new, separate mechanism — not built here, per
 * explicit instruction.
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireAdminUserId(request);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  const result = await runReadOnlyUserSession(userId, async ({ eventLog, projectionsDb }) => {
    const recordedAtByMessageId = new Map(
      eventLog
        .listForUser(userId)
        .filter((e) => e.type === "message_sent")
        .map((e) => [e.id, e.recordedAt])
    );
    const entities = computeEntityDirectory(projectionsDb, userId, recordedAtByMessageId, new Date().toISOString());
    const fillRates = computeFillRates(projectionsDb, userId);
    return { entities, fillRates };
  });

  return NextResponse.json(result);
}
