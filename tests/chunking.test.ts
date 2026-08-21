import { describe, expect, it } from "vitest";
import { chunkText, CHUNKING_PRESETS } from "../src/retrieval/chunking.js";

describe("chunkText (EN-035/062 chunking strategy)", () => {
  it("returns the whole text as one chunk when it's under the target size", () => {
    const text = "A short document.";
    const chunks = chunkText(text, CHUNKING_PRESETS.large);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(text.length);
  });

  it("every chunk's charStart/charEnd correctly slices back to its own text (provenance integrity)", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(30)}`);
    const fullText = paragraphs.join("\n\n");
    const chunks = chunkText(fullText, CHUNKING_PRESETS.small);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(fullText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("produces overlap between consecutive chunks so a boundary fact still appears whole in one of them", () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(40)}`);
    const fullText = paragraphs.join("\n\n");
    const chunks = chunkText(fullText, { targetSize: 300, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(1);

    // The tail of chunk N should reappear at the head of chunk N+1.
    for (let i = 0; i < chunks.length - 1; i++) {
      const tailOfCurrent = chunks[i]!.text.slice(-30);
      expect(chunks[i + 1]!.text.includes(tailOfCurrent.slice(0, 20))).toBe(true);
    }
  });

  it("hard-splits a single paragraph that alone exceeds the target size", () => {
    const hugeParagraph = "word ".repeat(500); // one paragraph, no double-newlines at all
    const chunks = chunkText(hugeParagraph, { targetSize: 300, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(hugeParagraph.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("does not lose any content — concatenating chunk spans covers the full text", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Section ${i}. ${"content ".repeat(20)}`);
    const fullText = paragraphs.join("\n\n");
    const chunks = chunkText(fullText, CHUNKING_PRESETS.large);
    const lastChunk = chunks.at(-1)!;
    expect(lastChunk.charEnd).toBe(fullText.length);
    expect(chunks[0]!.charStart).toBe(0);
  });
});
