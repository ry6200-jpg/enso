import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run batch: produces .next/standalone — a self-contained
  // server.js plus a file-traced node_modules subset — so the runtime
  // Docker stage doesn't need the full dev node_modules tree (typescript,
  // tailwind, vitest, etc. never ship). serverExternalPackages below are
  // real `require`s Next.js's tracer follows, not bundled — the Dockerfile
  // still defensively copies their native binaries on top of the traced
  // output, since file tracing has known gaps with prebuilt .node files
  // (see Dockerfile's comment on this).
  output: "standalone",
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
  webpack(config, { nextRuntime, webpack }) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"]
    };
    // instrumentation.ts build fix, confirmed live (`next dev --webpack`,
    // fresh boot): Next.js compiles instrumentation.ts for BOTH the node
    // and edge server compilers unconditionally in dev mode — there's no
    // per-file "runtime" export it reads to skip the edge pass the way it
    // does for ordinary route/page files (checked directly against
    // next's own build/entries.js: getInstrumentationEntry and
    // finalizeEntrypoint never inspect the file's own exports; the ONLY
    // pruning of an edge-only instrumentation entry — "no other edge
    // entry exists, delete it" — lives in build/entries.js's
    // createEntrypoints, which next dev's on-demand entry handler doesn't
    // go through). instrumentation.ts's register() only ever reaches
    // src/storage/userSession.js (-> eventLog.ts -> better-sqlite3) under
    // `NEXT_RUNTIME === "nodejs"` (see instrumentation.ts's own runtime
    // guard) — genuinely unreachable under edge — but webpack still has
    // to RESOLVE that whole dependency graph to build the edge bundle,
    // and better-sqlite3's native bindings.js does a bare `require('fs')`
    // edge has no polyfill for, which previously crashed the entire dev
    // server on boot. Aliasing the package to `false` for the edge
    // compiler pass only (nextRuntime === "edge") makes webpack treat any
    // edge-side import of it as an empty stub instead of resolving into
    // it — safe specifically because that code path never executes under
    // edge; the real, working import stays completely untouched for the
    // node compiler pass, which is the only one that ever runs it.
    if (nextRuntime === "edge") {
      config.resolve.alias = {
        ...config.resolve.alias,
        "better-sqlite3": false
      };
      // userSession.ts (imported transitively from instrumentation.ts's
      // register(), same unreachable-under-edge code path as above)
      // imports real Node core modules directly (`import fs from
      // "node:fs"`) — it's a first-party file that must stay fully
      // compiled for the node pass, so unlike better-sqlite3 it can't be
      // aliased away wholesale; only the specific Node builtins its
      // import graph touches need stubbing for edge. resolve.fallback
      // alone doesn't cover this: it only matches BARE specifiers
      // ("fs"), and confirmed live that a "node:fs"-style specifier hits
      // webpack's UnhandledSchemeError before fallback is ever consulted
      // (webpack has no built-in handler for the node: URI scheme at
      // all) — NormalModuleReplacementPlugin strips the node: prefix
      // first, onto the bare specifier resolve.fallback below already
      // maps to an empty stub.
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "");
      }));
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        util: false,
        events: false,
        buffer: false
      };
    }
    return config;
  }
};

export default nextConfig;
