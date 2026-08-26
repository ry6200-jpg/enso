import { NextResponse } from "next/server";
import { runReadOnlyUserSession } from "../../../lib/serverPipeline.js";
import { requireAdminUserId } from "../../../lib/requireUser.js";
import { UnauthenticatedError } from "../../../src/auth/verifyRequest.js";
import { LockAcquisitionError } from "../../../src/storage/userStorageBackend.js";
import { computeEntityDirectory, computeFillRates } from "../../../src/admin/entityDirectory.js";

/**
 * Admin-only entity view (part 2). Deliberately named something
 * unremarkable — not /api/admin/... — since hiding the menu item is
 * secondary, not the control: the real gate is requireAdminUserId
 * below, checked server-side against the verified token's own email
 * (never anything the client sends). A REJECTED admin check (a valid
 * token belonging to a non-admin, ForbiddenError) still returns a bare
 * 404 before any session/DB work runs at all, revealing nothing about
 * whether this route even exists to a non-admin caller — the property
 * this route exists to guarantee, unchanged from part 2's original
 * design.
 *
 * R71: a genuinely UNAUTHENTICATED caller (no/invalid token,
 * UnauthenticatedError) now gets 401 instead of being folded into the
 * same 404 — this does not weaken that guarantee. 401 reveals only "this
 * URL requires sign-in," the same generic fact every other route in this
 * app already reveals for a missing token (see historyFetch.ts's own
 * 401/403 split); it says nothing admin-specific, since an authenticated
 * non-admin still gets the indistinguishable-from-nonexistent 404 either
 * way. The client-side probe needs this distinction to avoid reading "not
 * authenticated YET" (transient, e.g. a cold navigation) as "confirmed
 * not an admin" (permanent) — see app/lib/directoryFetch.ts.
 *
 * R71: a storage-lock refusal (LockAcquisitionError — real contention,
 * never this route's own decision) is now caught explicitly and returns
 * a real 500 with a JSON body, rather than propagating as an uncaught
 * exception for Next.js's default handler to turn into an opaque 500.
 * Same discipline as the 401/404 split: infrastructure failure must
 * never look like an admin decision either way.
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
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    // ForbiddenError (valid token, not an admin) and anything else from
    // requireAdminUserId collapse into the same bare 404 as before —
    // still revealing nothing to an authenticated non-admin.
    return new NextResponse(null, { status: 404 });
  }

  try {
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
  } catch (err) {
    if (err instanceof LockAcquisitionError) return NextResponse.json({ error: err.message }, { status: 500 });
    throw err;
  }
}
