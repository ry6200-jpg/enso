/**
 * UI-fixes-and-persona-corrections batch, item 13 (confirmed regression):
 * the old repo (/home/yer/gemini_project) sent a fixed first message
 * immediately on load for a genuinely new user, rather than waiting for
 * them to speak into an empty page — "Welcome to Mirror. I'd love to get
 * to know you a little before we start journaling together — what should
 * I call you?" This is that behavior restored, adapted to Enso's identity.
 *
 * EN-047/048 voice-architecture refactor note: this string is a hardcoded
 * literal the client renders directly (see below) — it never actually ran
 * through buildPersonaBlock() or EN_ZEN_VOICE_INSTRUCTION mechanically, an
 * earlier version of this comment just described its authored STYLE as
 * "the shorter En/Zen voice," which was accurate to how it read at the
 * time but always a stylistic label, never a functional dependency. Now
 * that zen is a conditional mode rather than the conversational baseline,
 * that framing is stale: read plainly, this text — direct, plain words, no
 * aphorism, ends when the thought does — actually already matches
 * NATURAL_VOICE_INSTRUCTION's register more closely than zen's. No change
 * to the actual string; a genuinely fresh session's first line is a short,
 * warm, self-identifying, plain question, and that's what this already is.
 *
 * Deliberately NOT an LLM call and NOT a persisted event: it's a literal,
 * unvarying string the client renders directly (see app/page.tsx) — the
 * user's explicit requirement was FIXED, not varied, and no chat pipeline
 * run actually produced it, so recording it as a reply_sent event would
 * fabricate provenance (contextProvenance/router/gateActions) for a turn
 * that never happened. It only ever appears once, gated on GET
 * /api/history genuinely holding zero messages for the user — once they
 * reply, that reply is captured through the normal pipeline like any
 * other message, and the gate never opens again. Also used server-side
 * (turnMemoryRefresh.ts, item 10) as the known-fixed text to fall back on
 * when extraction needs to know what the very first message of a session
 * was answering, since this string is never itself in the event log for
 * that lookup to find.
 */
export const PROACTIVE_OPENER_MESSAGE = "Hi, I'm Enso. I'd love to get to know you a little before we start — what should I call you?";
