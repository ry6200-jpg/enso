# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps: full install (incl. devDependencies — needed for `next build`'s
# TypeScript/Tailwind toolchain). Debian (glibc), not Alpine: better-sqlite3,
# sqlite-vec, and onnxruntime-node (a transitive dep of @huggingface/
# transformers) all ship prebuilt native binaries keyed on glibc; Alpine's
# musl libc is a common source of "works locally, breaks in the container"
# for exactly these packages. build-essential/python3 are a safety net in
# case npm ever has to compile one of them from source instead of fetching a
# prebuild for the target platform — cheap here since this stage is never
# copied into the final image.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# builder: compiles the Next.js app (output: "standalone", next.config.ts)
# and — separately — warms the local embedding model cache. The two are
# independent (one is `next build`, the other is a plain script), but both
# need network access and both only exist in this throwaway stage.
#
# src/embeddings/embedder.ts's configureLocalOnlyEmbeddings() sets
# `allowRemoteModels: false` at runtime (EN-094) — the running app is
# STRUCTURALLY INCAPABLE of downloading the model on demand, by design, not
# by omission. Baking the model into the image here isn't an optimization,
# it's the only way the deployed app's embedding calls can ever succeed.
# ---------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /app
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build time by
# Next.js — passing them only at `docker run`/Cloud Run deploy time is too
# late. They are not secrets (Stage 2 covers why); ARGs with empty defaults
# so this stage still builds if a caller doesn't override them.
ARG NEXT_PUBLIC_FIREBASE_API_KEY=""
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=""
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID=""
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID

RUN npm run build
RUN npx tsx scripts/warmEmbeddingModelCache.ts

# ---------------------------------------------------------------------------
# runner: the actual deployed image. No dev toolchain, no source — just the
# standalone server, its traced node_modules, static assets, and the
# pre-warmed model cache.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.cache/embedding-model ./.cache/embedding-model

# Defensive copy, verified necessary (not precautionary): Next.js's build
# tracer (@vercel/nft) missed sqlite-vec's platform-specific optional
# dependency (sqlite-vec-linux-x64 etc. — resolved dynamically by
# sqlite-vec/index.mjs at runtime based on process.platform/arch, which a
# static tracer can't follow), confirmed by actually running the built
# image and watching it fail with ERR_MODULE_NOT_FOUND before this line was
# added. better-sqlite3, onnxruntime-node, and sharp/@img were all traced
# correctly and need no equivalent copy — checked each directly, not assumed
# clean by association.
#
# Plain `COPY --from=deps .../sqlite-vec-* ./node_modules/` was tried first
# and silently does the WRONG thing: Docker's glob COPY merges the matched
# directory's CONTENTS into the destination rather than preserving it as a
# subdirectory (confirmed by inspecting the resulting image — the package
# ended up flattened, still broken, just differently). Shelling out to a
# real `cp -r` (which preserves directory names the way anyone would expect)
# avoids that entirely.
RUN --mount=type=bind,from=deps,source=/app/node_modules,target=/deps-node-modules \
    cp -r /deps-node-modules/sqlite-vec-linux-* ./node_modules/

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
