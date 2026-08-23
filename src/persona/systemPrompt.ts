import {
  ANTI_SYCOPHANCY_INSTRUCTION,
  buildPersonaInstruction,
  FACT_RECEIPT_AND_REPETITION_INSTRUCTION,
  FIGURATIVE_LANGUAGE_INSTRUCTION,
  IDENTITY_LINE,
  MEMORY_HONESTY_INSTRUCTION,
  MEMORY_HYPERDRIVE_INSTRUCTION,
  NATURAL_VOICE_INSTRUCTION,
  REGISTER_CALIBRATION_INSTRUCTION,
  ZEN_MODE_INSTRUCTION
} from "./instructions.js";
import type { SelfProfile } from "../projections/peopleView.js";

export type VoiceMode = "natural" | "zen";

/**
 * Static persona block (EN-040 through EN-046, the register-calibration
 * addition from the UI-fixes-and-persona-corrections batch (item 17), and
 * the EN-047/048 voice split): identical text and order every call EXCEPT
 * the one interpolated voice instruction, which is now the ONE thing that
 * varies per turn — natural by default, zen only when
 * src/conversation/voiceMode.ts decided this specific turn calls for it.
 * The prompt-prefix-caching property the old repo's buildStaticPreamble
 * relied on (see instructions.ts's header comment) still holds for every
 * other line; only this one interpolation point breaks cache-identity
 * between a natural-voice turn and a zen-mode turn, which is the correct
 * tradeoff — the two are meant to read differently.
 */
export function buildPersonaBlock(voiceMode: VoiceMode = "natural"): string {
  const voiceInstruction = voiceMode === "zen" ? ZEN_MODE_INSTRUCTION : NATURAL_VOICE_INSTRUCTION;
  return [
    IDENTITY_LINE,
    buildPersonaInstruction(voiceInstruction),
    FACT_RECEIPT_AND_REPETITION_INSTRUCTION,
    MEMORY_HYPERDRIVE_INSTRUCTION,
    FIGURATIVE_LANGUAGE_INSTRUCTION,
    ANTI_SYCOPHANCY_INSTRUCTION,
    MEMORY_HONESTY_INSTRUCTION,
    REGISTER_CALIBRATION_INSTRUCTION
  ].join("\n\n");
}

const SELF_PROFILE_ATTRIBUTE_LABEL: Record<SelfProfile["attributes"][number]["attribute"], string> = {
  birthdate: "Birthdate",
  location: "Location",
  occupation: "Occupation"
};

export interface SelfProfileBlockResult {
  /** Null when there is nothing known yet — omitted from the prompt entirely rather than a "nothing known" placeholder line, which would fight MEMORY_HONESTY_INSTRUCTION's existing honest-emptiness handling for the retrieved-memory block. */
  block: string | null;
  attributeCount: number;
  /** How many bonds actually made it in, after any budget truncation below. */
  bondCount: number;
  truncated: boolean;
}

/**
 * Part B (R38): renders buildSelfProfile's data (src/projections/
 * peopleView.ts) into the always-on prompt block — pure string formatting,
 * no DB access, same discipline as buildRetrievedMemoryBlock/
 * buildRecentWindowBlock below.
 *
 * DATA, NOT INSTRUCTIONS: every line is a plain labeled fact, never a
 * directive verb ("ask about this", "consider clarifying") — THE ANTI-
 * ROBOT RULE's never-recite-your-own-instructions clause (instructions.ts)
 * means this block must have nothing instruction-shaped in it for Enso to
 * recite back if asked what it was told. A conflicting immutable attribute
 * (R37) is presented as two disagreeing facts, not as an instruction to
 * resolve them — the model doing something useful with an unresolved
 * conflict already sitting in its own data is ordinary conversational
 * judgment, not something this block needs to tell it to do.
 *
 * Budget: attributes are small, fixed (at most 3), and never dropped once
 * resolved — the whole point of R37/R38 is that a resolved fact is
 * reliable. Only the bonds list (unbounded in principle, though direct
 * bonds are small in practice — see the scope limit on buildSelfProfile)
 * is trimmed under a tight budget, count truncated from the end of the
 * list until it fits, never the attribute lines.
 */
export function buildSelfProfileBlock(profile: SelfProfile, maxChars: number): SelfProfileBlockResult {
  if (profile.attributes.length === 0 && profile.bonds.length === 0) {
    return { block: null, attributeCount: 0, bondCount: 0, truncated: false };
  }

  const attributeLines = profile.attributes.map((a) => {
    const label = SELF_PROFILE_ATTRIBUTE_LABEL[a.attribute];
    if (a.conflictingValues.length === 0) return `${label}: ${a.value}`;
    const conflicts = a.conflictingValues.map((v) => `"${v}"`).join(", ");
    return `${label}: ${a.value} (a later, unresolved record also states ${conflicts})`;
  });

  const render = (bondCount: number): string => {
    const lines = [...attributeLines];
    if (bondCount > 0) lines.push(`Relationships: ${profile.bonds.slice(0, bondCount).map((b) => `${b.name} (${b.relationship})`).join(", ")}`);
    return `=== OWNER PROFILE (begin) ===\n${lines.join("\n")}\n=== OWNER PROFILE (end) ===`;
  };

  let bondCount = profile.bonds.length;
  let block = render(bondCount);
  let truncated = false;
  while (block.length > maxChars && bondCount > 0) {
    bondCount--;
    truncated = true;
    block = render(bondCount);
  }
  if (block.length > maxChars) truncated = true; // attributes alone still over budget — kept anyway, a resolved fact is never dropped, only flagged

  return { block, attributeCount: attributeLines.length, bondCount, truncated };
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

export function buildSystemPrompt(
  retrievedBlock: string,
  recentWindowBlock: string,
  attachmentBlock: string | null = null,
  voiceMode: VoiceMode = "natural",
  selfProfileBlock: string | null = null
): string {
  const parts = [buildPersonaBlock(voiceMode)];
  if (selfProfileBlock) parts.push(selfProfileBlock);
  parts.push(retrievedBlock);
  if (attachmentBlock) parts.push(attachmentBlock);
  parts.push(recentWindowBlock);
  return parts.join("\n\n");
}
