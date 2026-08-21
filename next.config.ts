import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app calls into src/ (better-sqlite3, @huggingface/transformers,
  // local embeddings) directly from API routes — same pipeline the REPL
  // uses (scripts/chat.ts), never re-implemented. Those packages are
  // Node-native; API routes run on the Node runtime by default, which is
  // what this needs (never the edge runtime).
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@huggingface/transformers", "onnxruntime-node", "sharp"],
  // CLAUDE.md is this project's own maintained conventions doc — never let
  // `next dev` auto-append its agent-rules block to it.
  agentRules: false,
  // src/ is written for Node's native ESM loader (scripts/chat.ts, vitest,
  // both of which resolve a relative "./foo.js" import to "./foo.ts" the
  // way tsx/vite do) — every relative import in src/ therefore uses an
  // explicit .js extension pointing at the .ts source. Neither Turbopack
  // nor webpack do that "js specifier -> ts source" mapping by default;
  // it's a TypeScript-compiler-level (moduleResolution:"bundler")
  // convenience, not something bundlers replicate automatically — this is
  // the standard, documented fix for exactly this combination (confirmed
  // live: without it, `next dev` fails to resolve the very first relative
  // import inside any src/ file reached from an API route, under BOTH
  // Turbopack and webpack).
  turbopack: {
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"]
    };
    return config;
  }
};

export default nextConfig;
