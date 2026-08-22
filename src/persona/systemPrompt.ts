import {
  ANTI_SYCOPHANCY_INSTRUCTION,
  FACT_RECEIPT_AND_REPETITION_INSTRUCTION,
  FIGURATIVE_LANGUAGE_INSTRUCTION,
  IDENTITY_LINE,
  MEMORY_HONESTY_INSTRUCTION,
  MEMORY_HYPERDRIVE_INSTRUCTION,
  PERSONA_INSTRUCTION,
  REGISTER_CALIBRATION_INSTRUCTION
} from "./instructions.js";

/**
 * Static persona block (EN-040 through EN-046, plus the register-
 * calibration addition from the UI-fixes-and-persona-corrections batch,
 * item 17): identical text, same order, every call — the same
 * prompt-prefix-caching property the old repo's buildStaticPreamble relied
 * on (see instructions.ts's header comment), carried forward for whichever
 * provider ends up serving the reply.
 */
export function buildPersonaBlock(): string {
  return [
    IDENTITY_LINE,
    PERSONA_INSTRUCTION,
    FACT_RECEIPT_AND_REPETITION_INSTRUCTION,
    MEMORY_HYPERDRIVE_INSTRUCTION,
    FIGURATIVE_LANGUAGE_INSTRUCTION,
    ANTI_SYCOPHANCY_INSTRUCTION,
    MEMORY_HONESTY_INSTRUCTION,
    REGISTER_CALIBRATION_INSTRUCTION
  ].join("\n\n");
}

export interface RetrievedChunkForPrompt {
  id: string;
  text: string;
  occurredAt: string | null;
  recordedAt: string;
}

/**
 * The retrieved-memory block: raw chunk text with provenance, clearly
 * delimited from everything else in the prompt (Part 1's explicit
 * requirement). Provenance ids are visible here, in the PROMPT, so the model
 * can be told never to repeat them in prose (MEMORY_HONESTY_INSTRUCTION) —
 * they are never persuasive content, just addressing, the same way a
 * footnote number isn't part of the sentence it annotates.
 */
export function buildRetrievedMemoryBlock(chunks: RetrievedChunkForPrompt[]): string {
  if (chunks.length === 0) {
    return "=== RETRIEVED MEMORY (begin) ===\n(No stored history matched this turn's query.)\n=== RETRIEVED MEMORY (end) ===";
  }
  const lines = chunks.map((c) => `[chunk ${c.id} | ${c.occurredAt ?? c.recordedAt}] ${c.text}`);
  return `=== RETRIEVED MEMORY (begin) ===\n${lines.join("\n")}\n=== RETRIEVED MEMORY (end) ===`;
}

export interface RecentTurnForPrompt {
  role: "user" | "enso";
  text: string;
}

/**
 * The recent conversation window: verbatim turns, clearly delimited.
 * Separate from the retrieved-memory block on purpose — one is "what's
 * being said right now," the other is "what's been said historically and
 * happened to match this turn's query" (EN-035's retrieval, not a window).
 */
export function buildRecentWindowBlock(turns: RecentTurnForPrompt[]): string {
  if (turns.length === 0) {
    return "=== RECENT CONVERSATION (begin) ===\n(This is the first message of the conversation.)\n=== RECENT CONVERSATION (end) ===";
  }
  const lines = turns.map((t) => `${t.role === "user" ? "Owner" : "Enso"}: ${t.text}`);
  return `=== RECENT CONVERSATION (begin) ===\n${lines.join("\n")}\n=== RECENT CONVERSATION (end) ===`;
}

/**
 * Item 8's fix: a file attached to THIS turn was previously stored and
 * extracted (EN-061/062) but never actually reached the model generating
 * the reply — the upload and the chat call were two disconnected actions.
 * This block is what makes the content genuinely present for the reply
 * that answers it, distinct from the retrieved-memory block (this is new,
 * not retrieved from history) and framed explicitly against the failure
 * mode the user reported live: a document-summary report instead of a
 * conversational reply.
 */
export function buildAttachmentContextBlock(filename: string, content: string): string {
  return `=== JUST SHARED (begin) ===\nThe owner just attached a file ("${filename}") to this message. Its content:\n${content}\n\nRespond to it conversationally, carrying the discussion forward using what's actually in it — the way a person would if a friend handed them something to read and started talking about it. This is NOT a request for a document summary or report; don't structure the reply as one, and don't recite the file back.\n=== JUST SHARED (end) ===`;
}

export function buildSystemPrompt(retrievedBlock: string, recentWindowBlock: string, attachmentBlock: string | null = null): string {
  const parts = [buildPersonaBlock(), retrievedBlock];
  if (attachmentBlock) parts.push(attachmentBlock);
  parts.push(recentWindowBlock);
  return parts.join("\n\n");
}
