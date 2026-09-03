# AGENTS.md - Enso Rebuild

Read `enso-rebuild-requirements.md` in the repo root before doing any work in this project. It is the authoritative specification. If anything in this file conflicts with the spec, the spec wins.

## What this project is

Enso is a private relationship journal with an AI companion, built to help its user remember people, incidents, relationships, and emotion, including as memory fades. This is a ground-up rebuild on an event-sourced foundation.

**The specification is `enso-rebuild-requirements.md` (v1.47) in the repo root. It is canonical.** Every requirement has an EN-number. Reference EN-numbers in all reports, commits, and discussions. If an instruction here conflicts with the spec, the spec wins; if a task conflicts with both, stop and ask. If this pin and the spec's own version line disagree, the spec's version line wins; update this file.

Do not re-litigate settled decisions. Section 12 questions marked RESOLVED are closed. The regression ledger (Section 11) is a list of bugs already paid for once; reintroducing any of them is a failed build.

## Architecture invariants (violations are never acceptable)

- The event log is append-only. Events are never edited or deleted. Ten event types only (Section 12); new types require the user's explicit decision.
- Authority principle: derived output may be recorded only as versioned, supersedable observation (`extraction_completed` payload). Authority belongs exclusively to direct user actions.
- ULIDs everywhere. No auto-incrementing integer primary keys, anywhere.
- Events never contain projection entity IDs. Corrections and annotations bind to event ULIDs (EN-055).
- Every user message is saved before any AI call (EN-010).
- Every upload is stored, always (EN-061). No code path may silently discard user content.
- The classifier governs entity extraction only, never whether content is stored (EN-060).
- Silence never closes a relationship interval (EN-013).
- File bytes never go into SQLite as blobs (EN-051).
- Round-trip survival: any input that influences a supersedable observation's output (e.g. `knownPeopleNames` injected into extraction) must be recorded in that observation's own payload; the record must be self-describing for future reprocess diffs, never dependent on reconstructing ambient state that only existed at call time.
- Any change to the extraction schema MUST bump `MESSAGE_EXTRACTOR_VERSION` (`src/extraction/resilientExtraction.ts`). `ExtractionCache` keys on `(content_hash, extractor_version, model_id)` and has no knowledge of the extraction shape, so a schema change without a version bump will silently serve stale cached output missing the new fields. Nothing enforces this automatically.
- Any schema change to a persisted, GCS-round-tripped table (`events.db`/`projections.db`/`retrieval.db`, anything under a user's `UserDataPaths`) needs an explicit migration, never just new `CREATE TABLE`/DDL text. These files are downloaded on checkout and re-uploaded on checkin; they are never rebuilt from scratch, so a database that already exists in GCS keeps its OLD on-disk schema until something actively migrates it; new DDL text in the source only affects a table that doesn't exist yet. A CHECK-constraint change additionally needs a real rebuild-in-place (rename, recreate, copy rows, drop original), since SQLite has no `ALTER TABLE` for altering a CHECK constraint; a new column can use a plain idempotent `ALTER TABLE ... ADD COLUMN`. Any such migration must be verified against a copy of real production data before deploying, not only a freshly seeded test database; a fresh table already has the new schema from creation and never exercises the migration path at all (see EN-114's `ProjectionsDb.migrate()` for the precedent this generalizes from).

## Testing policy

- Two suites: **FAST** (pure logic, no network, the default `npm test`, seconds) and **LIVE** (real API calls, separate command, run on demand).
- Live tests live in separate `*.live.test.ts` files, visible and greppable. Never `.skipIf` env-var wrappers: silently skipped tests drift invisibly.
- Per-file test databases; parallelism on. One shared seed helper for the primary user, no hand-rolled seeds per file.
- The suite must FAIL LOUDLY if the test DB path is unset or misresolved. It must never fall back to a real database path.
- Destructive SQL is prohibited in test files. All resets go through the harness.
- Stochastic LLM decisions (router flags, attestation classifier) are validated at N=20 runs per case, at least 19 to pass, scored as per-flag confusion matrices with asymmetric thresholds (EN-075). A single lucky pass certifies nothing.

## Verification policy

- After each part of a multi-part task: run FAST, and live-verify that the specific thing just built actually works, observed behavior, not code inspection. This is never deferred.
- Any change touching `app/`, `lib/`, or a module reachable from a Next.js route or page also requires `npm run build` before being reported done (EN-092, R36). `tsc --noEmit` and the FAST suite verify logic, never bundling; 430 green FAST tests once certified a build where every API route and the client page 500'd, because Turbopack (Next.js 16's default bundler) can't resolve this codebase's `.js`-suffixed-import-to-`.ts`-source convention. **This project builds with webpack, not Turbopack.** `npm run dev` / `npm run build` / `npm run start` are pinned to `--webpack` in package.json for exactly this reason (see next.config.ts). Plain `next dev` / `next build` are not valid verification and must not be used directly; do not drop `--webpack` from those scripts without first confirming Turbopack has grown a real fix.
- Full suite (including LIVE) once at the end of a batch.
- Commit each part separately so a red batch can be bisected.
- Never report a feature as done without observed-behavior evidence. Reports without evidence are unverified by definition.
- Persona properties are judged by reading actual replies from live conversations, never by inspecting prompt text.
- Reply-level testing cannot verify storage-level properties; any claim about what was stored requires reading the projection or the event payload.

## Reporting

- All reports are plain text printed in the terminal for copy-paste. Never write reports to files. Never direct the user to open a file for results.
- Plain formatting: no boxes, no heavy ASCII art, nothing that breaks when copied.
- Reference EN-numbers for every requirement touched.
- Honesty over completeness theater: if something doesn't work, is unverified, or was skipped, say so plainly at the top, not in a footnote. The most expensive failures in this project's history were unverified "done" claims.

## Working with the user's real data

- Live verification against the real account requires explicit care: any test data inserted must be tracked by explicit ID and fully removed afterward, and the removal reported with what was deleted.
- Cleanup queries scoped by anything broader than explicit test-entity IDs (time ranges, recency) are prohibited.
- If an operation could touch real user data destructively, stop and confirm before running it.

## Dev tooling

- `scripts/mintAdminIdToken.ts` (`npm run mint-token -- <uid>`) mints a real Firebase ID token for a given uid from the terminal, no browser needed, for testing authenticated/admin routes when DevTools-based token extraction isn't available (e.g. Chromebooks). It reads only `FIREBASE_SERVICE_ACCOUNT_JSON` and `NEXT_PUBLIC_FIREBASE_API_KEY` from the environment (no hardcoded credentials or emails); the resulting token is a real bearer credential for whatever uid you pass; handle it like a password, don't paste it anywhere public.

## Prompts and provider work

- Provider capabilities (PDF input, tool-calling shape, caching, limits) are verified at build time per EN-082, never assumed from memory.
- No blanket capability prohibitions in any prompt ("no maps access", see R3). Behaviors that must happen reliably get explicit gates, not prompt paragraphs (EN-070).
- Judgment gates run on a mid-tier model minimum; per-model certification is required, and uncertified failover tiers bypass gates to no-action (EN-074, EN-083).
- RESPECT THE EXTRACTION CACHE: Do not trigger a historical "reprocess" (sending data back through the LLM) to test projection logic or schema changes. Use Enso's deterministic "rebuild" function (dropping projections and replaying the event log using existing `extraction_completed` payloads). Never bump the `extractor_version` in the codebase unless actively redesigning the extraction prompt.

### Prompting Architecture & Token Constraints

When modifying prompt construction logic, context assembly, or token management, strictly adhere to the following architectural constraints established by the token audit:

1. **Strict Prefix Caching (DO NOT conditionally remove "dead" constants):**
   - The `chatRouter.reply` call utilizes a massive persona block (~15k+ tokens) generated via `buildPersonaBlock`.
   - **Crucial Rule:** Constants like `CURRENT_LOCATION_INSTRUCTION` and `AMBIENT_TRAVEL_INSTRUCTION` must ALWAYS be injected unconditionally, even when their corresponding data blocks (e.g., GPS or routing data) resolve to zero characters.
   - *Reasoning:* Conditionally dropping these instructions breaks the stable byte-prefix required for provider-level prompt caching (Group A/B design). The token cost of the "dead weight" instruction is significantly cheaper than breaking the cache and paying full compute for the entire persona block.

2. **Instruction Redundancy & Fact Budgeting:**
   - The system governs context recitation through a single, centralized `ONE-FACT BUDGET` located within `PERSONA_INSTRUCTION`.
   - **Crucial Rule:** Do not add redundant one-echo rules to isolated instructions. Rely on the global persona instruction to enforce the budget.

3. **Latent Attribute Vocabulary (Data Visibility):**
   - The extraction layer currently supports `birthdate`, `location`, `occupation`, `gender`, and `life_stage`.
   - **Crucial Rule:** `gender` and `life_stage` are intentionally structurally invisible to the reply, gates, and router. They are excluded from `SELF_PROFILE_ATTRIBUTE_ORDER` in `peopleView.ts` by design. 
   - *Action:* If a feature requires reasoning over gender or life stage, `peopleView.ts` must be explicitly updated to expose those fields; otherwise, assume the agent cannot see them despite successful extraction.

4. **Schema Tax (Gate Candidate Lists):**
   - The router prompt (`intentRouter.route`) dedicates significant token budget to candidate lists for rare axes. 
   - **Crucial Rule:** Never remove or truncate schema definitions or candidate lists to save tokens. Doing so silently disables the model's ability to trigger these gates, reverting known regressions (e.g., EN-101, EN-134).
