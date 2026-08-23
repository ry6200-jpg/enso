import type { EventLog } from "../events/eventLog.js";
import type { RecentTurnForPrompt } from "../persona/systemPrompt.js";

export interface ConversationMessage {
  id: string;
  role: "user" | "enso";
  text: string;
}

/**
 * Item 9 (confirmed live: conversation appeared to vanish on page
 * refresh). Direct dev-data inspection showed the event log had every
 * message intact the whole time — this was never data loss, just a
 * display bug: the chat page's message list started as an empty React
 * array on every mount and nothing ever populated it from the event log.
 * This is the plain read that does that — chronological (EventLog.
 * listForUser already returns ULID-ascending order), user/enso turns only,
 * no attachment or system events mixed in.
 */
export function getConversationHistory(eventLog: EventLog, userId: string): ConversationMessage[] {
  return eventLog
    .listForUser(userId)
    .filter((e) => e.type === "message_sent" || e.type === "reply_sent")
    .map((e) => ({
      id: e.id,
      role: e.type === "message_sent" ? "user" : "enso",
      text: (e.payload as { text: string }).text
    }));
}

/**
 * Part B-0: the server-computed default for chatPipeline.ts's `sendMessage`
 * — the ENTIRE current session's turns, WITH each turn's source event id
 * attached (contextAssembly.ts's retrieval-dedup needs it; the prompt text
 * itself never shows it). This is what makes the event log — not whatever
 * a browser tab happens to have in React state — the actual source of
 * truth for what Enso can see of the current session: the client no longer
 * decides this by slicing its own message array (see app/page.tsx before
 * this fix, which sent `messages.slice(-6)` regardless of what the server
 * actually held).
 *
 * `excludeEventId` is the message_sent event just captured for THIS turn —
 * it's the live input to the reply being generated, not history, so it's
 * left out of the window the same way it always was (the caller passes it
 * separately as the chat call's latestMessage).
 */
export function getSessionTurnsForPrompt(eventLog: EventLog, userId: string, excludeEventId?: string): RecentTurnForPrompt[] {
  return getConversationHistory(eventLog, userId)
    .filter((m) => m.id !== excludeEventId)
    .map((m) => ({ role: m.role, text: m.text, eventId: m.id }));
}
