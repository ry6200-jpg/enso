import type { ChatRouter } from "../providers/chatRouter.js";
import { EN_ZEN_VOICE_INSTRUCTION } from "../persona/instructions.js";
import { DailyContentCache, todayIsoDate } from "./dailyContentCache.js";
import type { ChineseZodiacSign, WesternZodiacSign } from "./zodiac.js";

/**
 * All zodiac-flavored copy (EN-031 sidebar, EN-032 Horoscope tab) is
 * Enso-generated, original text — never scraped or paraphrased from an
 * external source (a real copyright concern for horoscope content
 * specifically) — via the SAME chat router the main persona uses (EN-080's
 * provider-agnostic core: no separate provider just for this), in the same
 * En/Zen voice (EN_ZEN_VOICE_INSTRUCTION, already ported for the main
 * persona — reused verbatim here, not re-derived).
 */
const VOICE_PREAMBLE = `You are Enso, generating a short piece of standalone written copy for the app's UI — not a conversational reply, so do not address the reader as if mid-conversation with an ongoing thread; write it as a small, self-contained piece of reflective writing.

${EN_ZEN_VOICE_INSTRUCTION}`;

function stripSurroundingQuotes(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("“") && trimmed.endsWith("”"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

async function generate(chatRouter: ChatRouter, system: string, latestMessage: string): Promise<string> {
  const result = await chatRouter.reply({ system, history: [], latestMessage });
  return stripSurroundingQuotes(result.text);
}

/**
 * EN-031 sidebar reflection. R21's exact defect this must avoid: near-
 * identical Dog/Taurus advice — each sign gets its own generation call
 * with the sign name and tradition named explicitly, cached per
 * (kind, sign, day), never shared or templated across signs.
 *
 * UI fixes batch (item 12): grounded in the owner's actual recent
 * conversation themes rather than a generic disconnected forecast — the
 * sign is an interpretive LENS on something real, not a fortune pulled
 * from nowhere. For the Chinese reading specifically, the current
 * calendar year's own animal (yearSign) is folded in as a dynamic angle:
 * the relationship between the owner's sign and the year's sign, which
 * changes what the reflection can honestly say from one year to the next
 * even for the same person.
 */
export function getZodiacSidebarReflection(
  cache: DailyContentCache,
  chatRouter: ChatRouter,
  kind: "chinese" | "western",
  sign: ChineseZodiacSign | WesternZodiacSign,
  recentContext: string[] = [],
  yearSign?: ChineseZodiacSign
): Promise<string> {
  const cacheKey = `sidebar:${kind}:${sign}:${todayIsoDate()}`;
  return cache.getOrGenerate(cacheKey, async () => {
    const traditionLabel = kind === "chinese" ? "Chinese zodiac sign" : "Western zodiac sign";
    const contextBlock =
      recentContext.length > 0
        ? `\nSomething real from the owner's own recent conversation, to interpret THROUGH the sign's lens rather than write a disconnected forecast (never invent a detail beyond what's here; if nothing here is usable, fall back to a general relational reflection for the sign instead of forcing a connection):\n${recentContext.map((c) => `- ${c}`).join("\n")}\n`
        : "";
    const yearAngle =
      kind === "chinese" && yearSign
        ? `\nThis calendar year's own animal is ${yearSign} — weave in ONE angle on how being ${sign} meeting a ${yearSign} year shades things right now (real, well-established lore about how these two animals relate is fine to draw on; never invent a specific prediction or event).`
        : "";
    const system = `${VOICE_PREAMBLE}

TASK: Write ONE short passage (2-3 sentences, under 55 words) of relationship-focused reflection tied to the ${traditionLabel} "${sign}" — draw on real, well-established traits traditionally associated with this specific sign, filtered through how a trait like that tends to show up in how someone connects with the people close to them. Not generic personality traits in isolation, not career/luck/health. The sign name is already shown as a heading next to this text — don't open with "As a ${sign}..." or restate the name; just write the reflection itself as prose. This must read as distinctly about ${sign} specifically, not copy that could be swapped onto a different sign unchanged.${contextBlock}${yearAngle}`;
    return generate(chatRouter, system, `Write today's ${kind} zodiac reflection for ${sign}.`);
  });
}

/** EN-032, part 2: Daily Zodiac Compatibility ("today's astrological relationship weather"). */
export function getDailyZodiacCompatibility(cache: DailyContentCache, chatRouter: ChatRouter, userChineseSign: ChineseZodiacSign, userWesternSign: WesternZodiacSign): Promise<string> {
  const cacheKey = `horoscope:daily:${userChineseSign}:${userWesternSign}:${todayIsoDate()}`;
  return cache.getOrGenerate(cacheKey, async () => {
    const system = `${VOICE_PREAMBLE}

TASK: Write today's general astrological relationship "weather" for someone who is a ${userWesternSign} (Western) and a ${userChineseSign} (Chinese zodiac) — 3-4 sentences, under 90 words. Focus specifically on relational themes for today: how they might show up with the people in their life, what to be mindful of in a connection, where warmth or friction is more likely. Draw on real, well-established astrological associations for both signs — this must be original writing, never a copy or close paraphrase of any specific published horoscope. Do not invent a specific event or name a specific person.`;
    return generate(chatRouter, system, `Write today's (${todayIsoDate()}) daily zodiac compatibility reading.`);
  });
}

export interface SynastryInput {
  userWesternSign: WesternZodiacSign;
  userChineseSign: ChineseZodiacSign;
  entityName: string;
  entityWesternSign: WesternZodiacSign;
  entityChineseSign: ChineseZodiacSign;
  /** The real, currently-established relationship type between the two, if known — grounds the reading in the actual relationship rather than a generic two-strangers comparison. Never fabricated when absent. */
  relationshipType: string | null;
}

/** EN-032, part 1: Synastry Chart. */
export function getSynastryReading(cache: DailyContentCache, chatRouter: ChatRouter, input: SynastryInput): Promise<string> {
  const cacheKey = `horoscope:synastry:${input.entityName}:${input.userWesternSign}:${input.entityWesternSign}:${todayIsoDate()}`;
  return cache.getOrGenerate(cacheKey, async () => {
    const relationshipContext = input.relationshipType ? `Their real, currently established relationship is: ${input.relationshipType.replace(/_/g, " ")}.` : "";
    const system = `${VOICE_PREAMBLE}

TASK: Write a synastry-style compatibility reading comparing two real people: the app's user (${input.userWesternSign} Western sign, ${input.userChineseSign} Chinese sign) and ${input.entityName} (${input.entityWesternSign} Western sign, ${input.entityChineseSign} Chinese sign). ${relationshipContext} 4-5 sentences, under 120 words. Draw on real, well-established astrological compatibility associations between these specific signs. Ground the reading in the real relationship context given above where it's provided, rather than writing as if they were strangers. This must be original writing, never a copy or close paraphrase of any specific published synastry article.`;
    return generate(chatRouter, system, `Write a synastry reading between the user and ${input.entityName}.`);
  });
}
