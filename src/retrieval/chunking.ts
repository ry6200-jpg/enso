/**
 * Chunking strategy for long documents (Section 12 Q4, EN-035/062). Splits
 * on paragraph boundaries where possible so a chunk doesn't cut a sentence
 * in half, falling back to a hard character split only when a single
 * paragraph exceeds the target size. Overlap is applied in CHARACTERS,
 * taken from the tail of the previous chunk, so a fact split across a
 * chunk boundary in one chunking still appears whole in the adjacent one.
 *
 * Messages and image descriptions are short enough to never need this —
 * they're indexed as one chunk each, unconditionally, regardless of
 * length (the "chunk" is the whole text; char_start=0).
 */
export interface Chunk {
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkingConfig {
  targetSize: number;
  overlap: number;
}

export const CHUNKING_PRESETS = {
  small: { targetSize: 300, overlap: 50 },
  large: { targetSize: 800, overlap: 100 }
} as const satisfies Record<string, ChunkingConfig>;

/** The recommended default — see the Phase 4 report for the measured comparison behind this choice. */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = CHUNKING_PRESETS.large;

export function chunkText(fullText: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): Chunk[] {
  if (fullText.length <= config.targetSize) {
    return [{ text: fullText, charStart: 0, charEnd: fullText.length }];
  }

  const paragraphs = splitKeepingOffsets(fullText, /\n\s*\n/);
  const chunks: Chunk[] = [];
  let current = "";
  let currentStart = 0;

  function flush(endOffset: number): void {
    if (current.trim().length === 0) return;
    chunks.push({ text: current, charStart: currentStart, charEnd: endOffset });
  }

  for (const para of paragraphs) {
    if (current.length === 0) currentStart = para.start;

    if (para.text.length > config.targetSize) {
      // A single paragraph is itself too long — hard-split it by
      // characters, since there's no smaller natural boundary to use.
      flush(para.start);
      current = "";
      for (let i = 0; i < para.text.length; i += config.targetSize - config.overlap) {
        const sliceStart = para.start + i;
        const sliceEnd = Math.min(para.start + i + config.targetSize, para.start + para.text.length);
        chunks.push({ text: fullText.slice(sliceStart, sliceEnd), charStart: sliceStart, charEnd: sliceEnd });
      }
      currentStart = para.start + para.text.length;
      continue;
    }

    if (current.length + para.text.length > config.targetSize && current.length > 0) {
      const endOffset = currentStart + current.length;
      flush(endOffset);
      // Overlap: carry the tail of the just-flushed chunk into the next one.
      const overlapText = current.slice(Math.max(0, current.length - config.overlap));
      currentStart = endOffset - overlapText.length;
      current = overlapText + para.text;
    } else {
      current += (current.length > 0 ? "" : "") + para.text;
    }
  }
  flush(currentStart + current.length);

  return chunks;
}

function splitKeepingOffsets(text: string, separator: RegExp): { text: string; start: number }[] {
  const result: { text: string; start: number }[] = [];
  let lastIndex = 0;
  const re = new RegExp(separator, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    result.push({ text: text.slice(lastIndex, match.index + match[0].length), start: lastIndex });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), start: lastIndex });
  }
  return result;
}
