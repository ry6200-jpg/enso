/**
 * UI-fixes-and-persona-corrections batch, item 13 (confirmed regression):
 * the old repo (/home/yer/gemini_project) sent a fixed first message
 * immediately on load for a genuinely new user, rather than waiting for
 * them to speak into an empty page. This is that behavior; the mechanism
 * (server-owned, GET /api/history substitutes this text when the log
 * genuinely holds zero messages for the user, never rebuilt) is unchanged
 * in effect — only the text changed, and only once since, for EN-097's
 * first-session-introduction batch below. Originally the client (app/
 * page.tsx) imported this constant directly and applied the same
 * empty-history fallback itself; that duplicated the string in two places
 * and broke under Turbopack (which can't resolve this file's .js-suffixed
 * sibling imports from client-bundled code — see next.config.ts), so
 * app/api/history/route.ts now owns the substitution and page.tsx just
 * renders whatever GET /api/history returns.
 *
 * EN-097 revision: the previous text ("Hi, I'm Enso. I'd love to get to
 * know you a little before we start — what should I call you?") was a
 * clean, warm question, but said nothing about what a first-time user
 * would actually GET from using Enso — it read as a friendly generic
 * greeting, not an introduction to what this specific thing is for. The
 * explicit brief: convey plainly, in one or two short sentences, that (1)
 * this is a place to talk about their life and the people in it, (2) it
 * remembers, so it's still here later, and (3) the more they share, the
 * more it can hold for them — then a short, warm opening, never a feature
 * pitch (no naming memory/zodiac/provenance/attachments as capabilities;
 * a capability list makes a companion read as software) and never a tour
 * or a bullet list.
 *
 * EN-030/097 ordering, resolved explicitly (both selfBirthdateGate and
 * elicitation's Layer 1 want the first real move once the user answers
 * this opener — they must not both fire the same turn): selfBirthdateGate
 * fires FIRST and is left completely untouched, unconditional, exactly as
 * it already was. Reasoning: it's a single, quick, one-shot fact that
 * unlocks other features (the zodiac sidebar and Horoscope tab, EN-031/
 * 032) and costs almost nothing to ask — real housekeeping, not relationship-
 * building, so getting it out of the way first doesn't cost anything
 * elicitation would otherwise use. This exact sequence (name, then
 * birthdate, then open into real conversation) already read naturally in
 * live use — see the real transcript this session's curiosity-redesign
 * work was calibrated against. chatPipeline.ts's existing priority chain
 * (`selfBirthdateEligible ? [] : ...`) already enforces this without any
 * code change: elicitation candidates are never even computed while
 * self-birthdate is eligible, exactly like third-party circle-back before
 * it. Elicitation's Layer 1 (name generators) naturally begins from the
 * turn after that, once the quick housekeeping is done.
 *
 * Deliberately NOT an LLM call and NOT a persisted event: it's a literal,
 * unvarying string that GET /api/history substitutes for an empty result
 * (see app/api/history/route.ts) — the user's explicit requirement was
 * FIXED, not varied, and no chat pipeline run actually produced it, so
 * recording it as a reply_sent event would
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
export const PROACTIVE_OPENER_MESSAGE =
  "Hi, I'm Enso. This is a place to talk about your life and the people in it. I remember, so it's still here later — the more you share, the more I can hold onto. What should I call you?";
