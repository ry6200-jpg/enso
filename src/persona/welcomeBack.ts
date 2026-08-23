import type { EventLog } from "../events/eventLog.js";
import type { ChatRouter } from "../providers/chatRouter.js";
import { IDENTITY_LINE, NATURAL_VOICE_INSTRUCTION } from "./instructions.js";

/**
 * Font-size/refresh/welcome-back batch, item 3: a warm greeting for
 * returning after a real gap, reconciled with proactiveOpener.ts rather
 * than built as a second parallel mechanism. Exactly one of three things
 * can ever happen on a GET /api/history load, and app/api/history/
 * route.ts is the single place that decides between them:
 *
 *   - Fresh session (the event log holds zero messages for this user):
 *     PROACTIVE_OPENER_MESSAGE fires, unchanged, zero API calls. This
 *     module is never consulted — getWelcomeBackEligibility is only ever
 *     called once the caller already knows history is non-empty.
 *   - Return with the gap since the last message under WELCOME_BACK_GAP_MS
 *     (the common case: a quick refresh mid-conversation, or picking the
 *     app back up minutes later): plain history, no greeting, zero API
 *     calls — getWelcomeBackEligibility is a local Date-diff over an
 *     already-open event log, not a network call.
 *   - Return with the gap at or above WELCOME_BACK_GAP_MS: history plus
 *     exactly one generated greeting, appended as the final message.
 *
 * WELCOME_BACK_GAP_MS = 4 hours. Reasoning: the constraint named "on the
 * order of several hours" as a starting point. Four hours is long enough
 * that normal same-sitting behavior — reloading a tab, a flaky connection
 * retry, checking the app twice in a row a few minutes apart — never
 * crosses it, but short enough that a genuine return later the same day
 * (after work, after an errand) still gets a warm greeting rather than
 * waiting until the next calendar day. A single named constant, easy to
 * retune after real use.
 *
 * KNOWN, ACCEPTED EDGE CASE (no persisted state exists to avoid it, and
 * the "not persisted as a fake event" constraint rules out adding one):
 * if the owner sees a long-gap greeting and then refreshes again WITHOUT
 * sending a message, the gap since the last real message hasn't moved, so
 * the greeting fires again. This is a real repeat, but not the failure
 * mode the gap-based requirement exists to prevent (a greeting stacking
 * on every ordinary quick refresh mid-conversation) — it only recurs
 * during the narrow window between seeing a long-gap greeting and
 * actually replying to it, and stops the moment the owner sends anything,
 * since that message becomes the new "last message" and collapses the
 * gap to near zero.
 *
 * HONESTY: mirrors the same anti-fabrication discipline already trusted
 * elsewhere in this codebase (src/zodiac/zodiacContent.ts's
 * getZodiacSidebarReflection, which grounds a reflection in the owner's
 * own recent words under an identical instruction) — the owner's actual
 * last message is handed to the model verbatim as the only thing it may
 * reference, with an explicit instruction to invent nothing beyond it and
 * to fall back to a simple, generic greeting when nothing here is usable.
 *
 * VOICE: NATURAL_VOICE_INSTRUCTION, not EN_ZEN_VOICE_INSTRUCTION — the
 * constraint was explicit that this should read as natural conversation,
 * not the quieter zen register the zodiac sidebar deliberately uses.
 */
export const WELCOME_BACK_GAP_MS = 4 * 60 * 60 * 1000;

export interface WelcomeBackEligibility {
  eligible: boolean;
  /** The owner's own last message, verbatim, or null if there isn't one to ground a specific reference in (e.g. the only prior turn was the proactive opener's own unprompted first line). */
  lastUserMessageText: string | null;
}

/**
 * Only ever called once the caller already knows the event log is
 * non-empty for this user (the fresh-session / proactive-opener case is
 * decided first, entirely separately). `now` is injectable for tests —
 * production call sites omit it and get the real current time.
 */
export function getWelcomeBackEligibility(eventLog: EventLog, userId: string, now: number = Date.now()): WelcomeBackEligibility {
  const events = eventLog.listForUser(userId).filter((e) => e.type === "message_sent" || e.type === "reply_sent");
  if (events.length === 0) return { eligible: false, lastUserMessageText: null };

  const lastEvent = events[events.length - 1];
  if (!lastEvent) return { eligible: false, lastUserMessageText: null };
  const gap = now - new Date(lastEvent.recordedAt).getTime();
  if (gap < WELCOME_BACK_GAP_MS) return { eligible: false, lastUserMessageText: null };

  const lastUserEvent = [...events].reverse().find((e) => e.type === "message_sent");
  const lastUserMessageText = lastUserEvent ? (lastUserEvent.payload as { text: string }).text : null;
  return { eligible: true, lastUserMessageText };
}

function stripSurroundingQuotes(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("“") && trimmed.endsWith("”"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** The one LLM call this feature ever makes — only reached when getWelcomeBackEligibility already said `eligible`. */
export async function generateWelcomeBackMessage(chatRouter: ChatRouter, lastUserMessageText: string | null): Promise<string> {
  const referenceBlock = lastUserMessageText
    ? `\nThe owner's own last message before they left, verbatim — you may reference it directly (echo or closely quote their own words) ONLY if it naturally fits a warm greeting; never invent or infer anything beyond what's literally here. If it doesn't fit naturally (too short, too mundane, mid-thought), skip it entirely and keep the greeting simple and warm instead:\n"${lastUserMessageText}"\n`
    : "\nThere's nothing specific from last time worth referencing — keep the greeting simple and warm.\n";

  const system = `${IDENTITY_LINE}

${NATURAL_VOICE_INSTRUCTION}

TASK: The owner is opening the app again after being away for a while. Write ONE short, warm greeting for the moment they see when it opens — 1-2 sentences, like someone genuinely glad to see them again, not a status report and not a summary of what was discussed. Never open with a restating/paraphrase of anything they said. No aphoristic closing line.${referenceBlock}`;

  const result = await chatRouter.reply({ system, history: [], latestMessage: "Write the welcome-back greeting." });
  return stripSurroundingQuotes(result.text);
}
