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
  // The round black "N" button bottom-left is Next.js's own dev-mode tools
  // indicator, not anything in this app's code (confirmed: it's injected
  // by the framework, not app/ or public/) — turned off per live feedback.
  devIndicators: false,
  // src/ is written for Node's native ESM loader (scripts/chat.ts, vitest,
  // both of which resolve a relative "./foo.js" import to "./foo.ts" the
  // way tsx/vite do) — every relative import in src/ therefore uses an
  // explicit .js extension pointing at the .ts source, which is correct
  // NodeNext ESM and must not be rewritten to work around one bundler's
  // limitation. webpack's `resolve.extensionAlias` below is the standard,
  // documented fix that actually remaps an already-".js" specifier onto
  // the real ".ts" file, and it is confirmed live to make every src/
  // import resolve correctly (see `npm run build`/`npm run dev`, both
  // pinned to `--webpack` in package.json for exactly this reason).
  //
  // Turbopack has NO equivalent of extensionAlias — its `resolveExtensions`
  // below only appends candidate extensions to an EXTENSIONLESS specifier;
  // it does not remap a specifier that already ends in ".js" onto a ".ts"
  // file. A wildcard `resolveAlias` ("*.js" -> "*.ts") was also tried live
  // and does not fix it either. Concretely: under plain `next dev` / `next
  // build` (Turbopack, the framework default), every src/-importing API
  // route 500s and the client bundle fails to compile — confirmed live
  // across the whole app, not just one file. Do not drop `--webpack` from
  // the dev/build/start scripts without first confirming Turbopack has
  // grown a real extensionAlias equivalent; until then this project is not
  // Turbopack-compatible, despite `next dev`/`next build` appearing to run
  // (they just serve 500s). The block below is kept only for anyone who
  // explicitly passes `--turbopack`; it is NOT sufficient on its own.
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
