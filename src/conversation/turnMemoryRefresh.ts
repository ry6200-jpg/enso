import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "../projections/db.js";
import type { RetrievalDb } from "../retrieval/retrievalDb.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { ExtractionRouter } from "../providers/router.js";
import { extractMessageWithResilience } from "../extraction/resilientExtraction.js";
import { rebuildProjections } from "../projections/rebuild.js";
import { rebuildRetrievalIndex } from "../retrieval/rebuildRetrievalIndex.js";
import { PROACTIVE_OPENER_MESSAGE } from "../persona/proactiveOpener.js";

export interface TurnMemoryRefreshDeps {
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
  embedder: Embedder;
  extractionRouter: ExtractionRouter;
}

/**
 * The post-reply half of a real turn (extraction + full projection/
 * retrieval-index rebuild) — factored out of scripts/chat.ts (Phase 5
 * Part 3) so the web app (Phase 7 Part 1) calls the exact same function
 * rather than re-implementing it in an API route. This is what "zero
 * pipeline logic duplicated into the web layer" means in practice: both
 * surfaces import this, neither reimplements it.
 */
export async function refreshMemoryAfterTurn(deps: TurnMemoryRefreshDeps, userId: string, messageEventId: string): Promise<void> {
  const messageEvent = deps.eventLog.getById(messageEventId)!;
  // Role-word placeholders (name_kind === "role_word", e.g. "father")
  // excluded — real corpus, confirmed live: the taxonomy prompt's own
  // knownPeopleNames instruction tells the model to reuse an entry from
  // this list VERBATIM rather than a "kinship term or role," with no way
  // to distinguish a placeholder from a genuine name once both are just
  // strings in the same array. Once a role word is established as an
  // entity, it stays in this list on every future turn (never a one-shot
  // consumption), so the mechanism meant to make "mom" resolve to Elena
  // instead makes "father" self-reinforce as the permanent "name" for
  // that person — confirmed directly against real production data (an
  // extraction event asserting parent_of with fromName "mother" and
  // fromNameIsRoleWord FALSE, on a message where "mother" was already in
  // this list from an earlier turn's placeholder) and reproduced live,
  // twice, on a synthetic "Vanessa's dad is An Song" test. De-duplicated
  // too — the same unfiltered map let a role word accumulate multiple
  // identical entries (the real corpus shows "mother" and "husband" each
  // listed twice) for no reason; a Set collapses that regardless of which
  // entities remain after the role-word filter.
  const knownPeopleNames = [...new Set(deps.projectionsDb.listEntities(userId).filter((e) => e.name_kind !== "role_word").map((e) => e.name))];

  // Item 7's root cause: the message being extracted may be a short,
  // elliptical answer to whatever Enso itself just asked (a bare date
  // answering "when is your birthday?") — find the reply_sent that came
  // immediately before this message (ULIDs sort chronologically) so
  // extraction can resolve it, rather than seeing the bare text alone.
  //
  // Item 10's shared root cause: this same gap is why a user's own stated
  // name ("Richard", answering "what should I call you?") got extracted as
  // a third-party entity — the extractor's own rule already excludes "the
  // author/narrator" from entities, but it had no way to know a bare name
  // WAS the author naming themselves without seeing the question it
  // answered. The one case the reply_sent lookup above can never cover is
  // the very first message of a session: the proactive opener that asks
  // for a name (src/persona/proactiveOpener.ts) is deliberately never
  // persisted as an event (see that file for why), so it can't be found by
  // scanning the log. Since its text is fixed and known, not guessed, the
  // very first message of a user's entire history falls back to it
  // directly rather than losing this context on turn one specifically.
  const allPriorEvents = deps.eventLog.listForUser(userId).filter((e) => e.id < messageEvent.id);
  const priorReplies = allPriorEvents.filter((e) => e.type === "reply_sent");
  const isVeryFirstMessage = !allPriorEvents.some((e) => e.type === "message_sent" && e.actor === "user");
  const precedingReplyText =
    priorReplies.length > 0
      ? (priorReplies[priorReplies.length - 1]!.payload as { text: string }).text
      : isVeryFirstMessage
        ? PROACTIVE_OPENER_MESSAGE
        : undefined;

  await extractMessageWithResilience(deps.eventLog, deps.extractionRouter, messageEvent, undefined, knownPeopleNames, precedingReplyText);

  const allEvents = deps.eventLog.listForUser(userId);
  // Explicit reference date (EN-057) — see rebuildProjections' own doc
  // comment. This runs after every real turn, so "now" is the only
  // sensible value; passed explicitly rather than relied on as a default
  // so the intent reads plainly at the call site.
  rebuildProjections(allEvents, deps.projectionsDb, userId, undefined, new Date());
  await rebuildRetrievalIndex(allEvents, deps.retrievalDb, userId, deps.embedder);
}
