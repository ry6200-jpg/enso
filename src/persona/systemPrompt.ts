import {
  ANTI_SYCOPHANCY_INSTRUCTION,
  BREADTH_BEFORE_DEPTH_INSTRUCTION,
  buildPersonaInstruction,
  CURRENT_DATE_INSTRUCTION,
  CURRENT_LOCATION_INSTRUCTION,
  FACT_RECEIPT_AND_REPETITION_INSTRUCTION,
  FIGURATIVE_LANGUAGE_INSTRUCTION,
  IDENTITY_LINE,
  MEMORY_HONESTY_INSTRUCTION,
  MEMORY_HYPERDRIVE_INSTRUCTION,
  NATURAL_VOICE_INSTRUCTION,
  REGISTER_CALIBRATION_INSTRUCTION,
  ZEN_MODE_INSTRUCTION
} from "./instructions.js";
import type { EntityDossier, SelfProfile } from "../projections/peopleView.js";

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
    BREADTH_BEFORE_DEPTH_INSTRUCTION,
    FIGURATIVE_LANGUAGE_INSTRUCTION,
    ANTI_SYCOPHANCY_INSTRUCTION,
    MEMORY_HONESTY_INSTRUCTION,
    CURRENT_DATE_INSTRUCTION,
    CURRENT_LOCATION_INSTRUCTION,
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

const LOCATION_TIER_LABEL: Record<"geolocation" | "ip", string> = {
  geolocation: "via device GPS",
  ip: "via approximate network location"
};

function formatLocalTime(timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());
  } catch {
    return null; // an unrecognized/invalid IANA timezone string — never crash the reply over it
  }
}

/**
 * Ambient current-location block — WHERE THE OWNER IS RIGHT NOW, never
 * their residence (see CURRENT_LOCATION_INSTRUCTION, instructions.ts, for
 * the behavioral rules governing how this may be used; this function is
 * pure data formatting, same discipline as buildSelfProfileBlock/
 * buildEntityDossierBlock — no directive language belongs here either,
 * that all lives in the instruction). Deliberately its own block, never
 * folded into the self-profile block: that block holds durable, resolved
 * facts (R37/R38); this is ephemeral and would read differently on every
 * single turn.
 *
 * Returns null (omitted entirely, never a placeholder line) when nothing
 * resolved at all — same honest-emptiness pattern as every other block —
 * and also when the whole block would exceed `maxChars`: this content is
 * inherently tiny and fixed-shape (at most two short lines), so unlike
 * the self-profile/entity-dossier blocks there's nothing sensible to trim
 * — a budget this tight means something is misconfigured, and the honest
 * response is omission, not a mangled partial render.
 */
export function buildLocationContextBlock(context: { placeName: string | null; tier: "geolocation" | "ip" | "timezone" | null; timezone: string | null }, maxChars: number): string | null {
  if (context.tier === null) return null;

  const lines: string[] = [];
  if (context.placeName && (context.tier === "geolocation" || context.tier === "ip")) {
    lines.push(`Location: ${context.placeName} (${LOCATION_TIER_LABEL[context.tier]})`);
  }
  if (context.timezone) {
    const localTime = formatLocalTime(context.timezone);
    if (localTime) lines.push(context.tier === "timezone" ? `Local time: ${localTime} (timezone only — location not available)` : `Local time: ${localTime}`);
  }
  if (lines.length === 0) return null;

  const block = `=== CURRENT CONTEXT (begin) ===\n${lines.join("\n")}\n=== CURRENT CONTEXT (end) ===`;
  return block.length <= maxChars ? block : null;
}

/**
 * Ambient current-date (breadth-before-depth batch, item 4). Live-caught:
 * asked her mother's age, Enso said 86, then "corrected" to 87, "turns 88
 * on May 20, 2026" — a date already months in the past relative to the
 * real conversation. Confirmed by inspection before this was built: the
 * current date reached the system prompt nowhere at all — the ONLY date/
 * time computation anywhere in this file was buildLocationContextBlock's
 * `formatLocalTime`, which only renders when a location reading exists
 * (permission-gated, can be entirely absent) and only produces a time-of-
 * day string, never a date the model could reliably do year arithmetic
 * against.
 *
 * Deliberately its own function, its own block, its own budget — never
 * folded into buildLocationContextBlock — because the two have completely
 * different availability models: location is permission-gated and can be
 * genuinely absent for an entire session; the server always knows what
 * day it is, so this block is present on every single turn regardless of
 * whether location ever resolves. Same discipline as every other context
 * block here: pure data formatting, no directive language for the model
 * to recite back if asked what it was told.
 */
export function buildCurrentDateContextBlock(referenceDate: Date, maxChars: number): string | null {
  const dateLine = new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(referenceDate);
  const block = `=== CURRENT DATE (begin) ===\nToday's date: ${dateLine}\n=== CURRENT DATE (end) ===`;
  return block.length <= maxChars ? block : null;
}

/**
 * Part D (R40): renders buildEntityDossier's data (src/projections/
 * peopleView.ts) into a block for every KNOWN entity named directly in
 * this turn — same discipline as buildSelfProfileBlock: plain labeled
 * data, no directive language for Enso to recite back if asked what it
 * was told (THE ANTI-ROBOT RULE). `dossiers` is already capped by the
 * caller (MAX_ENTITY_DOSSIERS_PER_TURN, MAX_RELATIONSHIPS_PER_ENTITY_
 * DOSSIER — peopleView.ts) before this function ever sees it; this is
 * pure formatting, same as buildRetrievedMemoryBlock/buildRecentWindowBlock.
 */
export function buildEntityDossierBlock(dossiers: EntityDossier[]): string | null {
  const nonEmpty = dossiers.filter((d) => d.attributes.length > 0 || d.relationshipsToOwner.length > 0);
  if (nonEmpty.length === 0) return null;

  const lines = nonEmpty.map((d) => {
    const parts: string[] = [];
    for (const a of d.attributes) {
      const label = SELF_PROFILE_ATTRIBUTE_LABEL[a.attribute];
      parts.push(a.conflictingValues.length === 0 ? `${label}: ${a.value}` : `${label}: ${a.value} (a later, unresolved record also states ${a.conflictingValues.map((v) => `"${v}"`).join(", ")})`);
    }
    if (d.relationshipsToOwner.length > 0) parts.push(`Relationship to owner: ${d.relationshipsToOwner.join(", ")}`);
    return `${d.name} — ${parts.join("; ")}`;
  });

  return `=== NAMED PEOPLE (begin) ===\n${lines.join("\n")}\n=== NAMED PEOPLE (end) ===`;
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
  /**
   * Part B-0: the source message_sent event ULID, when known — used
   * ONLY for retrieval dedup (contextAssembly.ts skips a candidate chunk
   * whose source_event_id is already sitting in this window verbatim, so
   * it never wastes one of the 8 retrieval slots on something already
   * shown). Never rendered into the prompt text itself. Optional because
   * hand-built turns (most FAST tests, any future caller not sourcing
   * from the real event log) legitimately have no event to point to —
   * dedup simply never fires for those, which is the safe default.
   */
  eventId?: string;
}

/**
 * The recent conversation window: verbatim turns, clearly delimited.
 * Separate from the retrieved-memory block on purpose — one is "what's
 * being said right now," the other is "what's been said historically and
 * happened to match this turn's query" (EN-035's retrieval, not a window).
 *
 * Part B-0: this is now the ENTIRE current session by default (governed by
 * a character budget, not a fixed turn count — contextAssembly.ts), so
 * `truncated` is genuinely rare (only a pathologically long single
 * session), but when it happens the memory-honesty principle applies to
 * the window itself, not just to retrieval: the block says so explicitly,
 * so Enso can tell the owner "that's beyond what I can see right now"
 * instead of silently implying earlier material never existed.
 */
export function buildRecentWindowBlock(turns: RecentTurnForPrompt[], truncated: boolean = false): string {
  if (turns.length === 0) {
    // Found while testing Part B-0's budget: a single most-recent turn that alone exceeds the budget
    // is dropped entirely (contextAssembly.ts's own documented precedent), leaving turns.length === 0
    // even though real prior turns exist — the "first message" line would have been an active lie in
    // that case, exactly the memory-honesty failure this whole disclosure mechanism exists to prevent.
    const emptyNote = truncated
      ? "(Earlier turns from this session exist but aren't shown above — they've been trimmed to fit. If asked about something from further back, say plainly that it's beyond what's visible right now rather than implying it never happened.)"
      : "(This is the first message of the conversation.)";
    return `=== RECENT CONVERSATION (begin) ===\n${emptyNote}\n=== RECENT CONVERSATION (end) ===`;
  }
  const lines = turns.map((t) => `${t.role === "user" ? "Owner" : "Enso"}: ${t.text}`);
  const truncationNote = truncated ? "\n(Earlier turns from this same session exist but aren't shown above — they've been trimmed to fit. If asked about something from further back, say plainly that it's beyond what's visible right now rather than implying it never happened.)" : "";
  return `=== RECENT CONVERSATION (begin) ===\n${lines.join("\n")}${truncationNote}\n=== RECENT CONVERSATION (end) ===`;
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
  selfProfileBlock: string | null = null,
  entityDossierBlock: string | null = null,
  locationContextBlock: string | null = null,
  dateContextBlock: string | null = null
): string {
  const parts = [buildPersonaBlock(voiceMode)];
  if (dateContextBlock) parts.push(dateContextBlock);
  if (selfProfileBlock) parts.push(selfProfileBlock);
  if (locationContextBlock) parts.push(locationContextBlock);
  if (entityDossierBlock) parts.push(entityDossierBlock);
  parts.push(retrievedBlock);
  if (attachmentBlock) parts.push(attachmentBlock);
  parts.push(recentWindowBlock);
  return parts.join("\n\n");
}
