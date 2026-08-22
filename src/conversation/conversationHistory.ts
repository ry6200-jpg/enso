import type { EventLog } from "../events/eventLog.js";

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
