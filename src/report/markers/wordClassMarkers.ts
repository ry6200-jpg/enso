import { ALL_WORD_CLASSES, WORD_CLASSES, type WordClass } from "../wordClasses.js";
import type { ReportWindow } from "../reportWindows.js";

/**
 * Report page, Stage A (methodology Section 2.1). Displayed LAST on the
 * page and deliberately so: this corpus runs ~10 words per message, well
 * below the ~100-200 word stability floor the methodology names for
 * function-word rates — network and temporal markers (exact at any
 * message length) are the substance of the page; these are a direction
 * to look, not a conclusion, and the UI must show the word count each
 * rate was computed from so the thinness of the basis is never hidden.
 */

const TOKEN_PATTERN = /[a-z']+/g;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_PATTERN) ?? []).filter((t) => t.length > 0);
}

export interface WordClassRate {
  wordClass: WordClass;
  /** Count of matches — multi-word entries ("sort of") count once per occurrence, found via substring scan, not token match. */
  count: number;
  /** count / totalWords for this window — 0 when totalWords is 0. */
  rate: number;
}

export interface WordClassWindowResult {
  windowIndex: number;
  totalWords: number;
  rates: WordClassRate[];
}

function countClassMatches(lowerText: string, tokens: string[], entries: readonly string[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.includes(" ")) {
      // Multi-word entry: substring scan over the whole lowercased text, not a token match.
      let from = 0;
      while (true) {
        const at = lowerText.indexOf(entry, from);
        if (at === -1) break;
        count++;
        from = at + entry.length;
      }
    } else {
      for (const token of tokens) if (token === entry) count++;
    }
  }
  return count;
}

/** One result per window, one rate per word class within it — a fixed, pre-registered set every time (methodology Section 4.5), never a subset chosen after seeing what moved. */
export function computeWordClassMarkers(window: ReportWindow): WordClassWindowResult {
  const lowerText = window.messages.map((m) => m.text).join(" \n ").toLowerCase();
  const tokens = window.messages.flatMap((m) => tokenize(m.text));
  const totalWords = tokens.length;

  const rates: WordClassRate[] = ALL_WORD_CLASSES.map((wordClass) => {
    const count = countClassMatches(lowerText, tokens, WORD_CLASSES[wordClass]);
    return { wordClass, count, rate: totalWords > 0 ? count / totalWords : 0 };
  });

  return { windowIndex: window.index, totalWords, rates };
}
