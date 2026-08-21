import type { ExtractedEntity, TokenUsage } from "./types.js";

export interface DocumentContentRequest {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface DocumentContentResult {
  provider: "openai" | "gemini";
  model: string;
  fullText: string;
  entities: ExtractedEntity[];
  usage: TokenUsage;
}

export type DocumentContentAdapter = (request: DocumentContentRequest) => Promise<DocumentContentResult>;

export interface ImageContentRequest {
  bytes: Buffer;
  mimeType: string;
}

export interface ImageContentResult {
  provider: "openai" | "gemini";
  model: string;
  description: string;
  usage: TokenUsage;
}

export type ImageContentAdapter = (request: ImageContentRequest) => Promise<ImageContentResult>;
