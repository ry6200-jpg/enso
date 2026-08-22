import { NextResponse } from "next/server";
import { deleteUpload } from "../../../../src/attachments/uploadDeletion.js";
import { getBlobStore, getDevUserId, getEmbedder, getStores } from "../../../../lib/serverPipeline.js";

/**
 * EN-065's actual deletion: one click, no multi-step wizard. Takes effect
 * immediately (rebuilds projections + retrieval index as part of the same
 * call — see deleteUpload) rather than waiting for the next chat turn.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const userId = getDevUserId();
  const { eventLog, projectionsDb, retrievalDb } = getStores();
  const blobStore = getBlobStore();
  const embedder = await getEmbedder();

  try {
    const { impact } = await deleteUpload({ eventLog, blobStore, projectionsDb, retrievalDb, embedder }, userId, id);
    return NextResponse.json(impact);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
