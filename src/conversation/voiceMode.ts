import type { VoiceMode } from "../persona/systemPrompt.js";

/**
 * EN-048's conditional zen injection: two layers, mirroring EN-071's
 * cheap-heuristic-then-real-judgment gate structure.
 *
 * Cheap layer (this file, hasZenTriggerPhrase): a literal trigger phrase
 * in the CURRENT message. Deliberately insufficient on its own — someone
 * genuinely overwhelmed rarely types the literal word "overwhelmed," the
 * exact literal-phrase failure class already in the regression ledger
 * (R9: literal user phrasing used as search query). This layer exists to
 * unconditionally catch the explicit, unambiguous cases ("let's zoom out,"
 * "can we step back a second") cheaply, without waiting on a router call.
 *
 * Real layer (the router's own `register` axis, routerTypes.ts/
 * routerSchema.ts): the router already runs one JSON call per turn with
 * per-axis validation and a fail-safe default (EN-075) — this is what
 * catches genuine overwhelm that never says the word, by reading the
 * actual content and tone rather than matching a phrase.
 *
 * A literal trigger always wins outright (it's the more certain signal);
 * otherwise the router's judgment is used; with no router configured at
 * all (or on any router failure — SAFE_DEFAULT_DECISION.register.mode is
 * "natural", never zen), natural is the default. Fail-safe default is
 * natural, never zen, per EN-048.
 */
const ZEN_TRIGGER_PHRASES = ["zoom out", "step back", "overwhelmed", "overwhelming"];

export function hasZenTriggerPhrase(message: string): boolean {
  const lower = message.toLowerCase();
  return ZEN_TRIGGER_PHRASES.some((phrase) => lower.includes(phrase));
}

export function decideVoiceMode(message: string, routerRegisterMode: VoiceMode | null): VoiceMode {
  if (hasZenTriggerPhrase(message)) return "zen";
  return routerRegisterMode ?? "natural";
}
