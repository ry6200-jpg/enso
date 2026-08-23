import { NextResponse } from "next/server";
import { deleteUpload } from "../../../../src/attachments/uploadDeletion.js";
import { getBlobStore, getEmbedder, getStores } from "../../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../../lib/requireUser.js";

/**
 * EN-065's actual deletion: one click, no multi-step wizard. Takes effect
 * immediately (rebuilds projections + retrieval index as part of the same
 * call — see deleteUpload) rather than waiting for the next chat turn.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const { eventLog, projectionsDb, retrievalDb } = getStores(userId);
  const blobStore = getBlobStore(userId);
  const embedder = await getEmbedder();

  try {
    const { impact } = await deleteUpload({ eventLog, blobStore, projectionsDb, retrievalDb, embedder }, userId, id);
    return NextResponse.json(impact);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
