# CLAUDE.md — Enso Rebuild

## What this project is

Enso is a private relationship journal with an AI companion, built to help its user remember people, incidents, relationships, and emotion — including as memory fades. This is a ground-up rebuild on an event-sourced foundation.

**The specification is `enso-rebuild-requirements.md` (v1.11) in the repo root. It is canonical.** Every requirement has an EN-number. Reference EN-numbers in all reports, commits, and discussions. If an instruction here conflicts with the spec, the spec wins; if a task conflicts with both, stop and ask. If this pin and the spec's own version line disagree, the spec's version line wins — update this file.

Do not re-litigate settled decisions. Section 12 questions marked RESOLVED are closed. The regression ledger (Section 11) is a list of bugs already paid for once — reintroducing any of them is a failed build.

## Architecture invariants (violations are never acceptable)

- The event log is append-only. Events are never edited or deleted. Ten event types only (Section 12); new types require the user's explicit decision.
- Authority principle: derived output may be recorded only as versioned, supersedable observation (`extraction_completed` payload). Authority belongs exclusively to direct user actions.
- ULIDs everywhere. No auto-incrementing integer primary keys, anywhere.
- Events never contain projection entity IDs. Corrections and annotations bind to event ULIDs (EN-055).
- Every user message is saved before any AI call (EN-010).
- Every upload is stored, always (EN-061). No code path may silently discard user content.
- The classifier governs entity extraction only — never whether content is stored (EN-060).
- Silence never closes a relationship interval (EN-013).
- File bytes never go into SQLite as blobs (EN-051).
- Round-trip survival: any input that influences a supersedable observation's output (e.g. `knownPeopleNames` injected into extraction) must be recorded in that observation's own payload — the record must be self-describing for future reprocess diffs, never dependent on reconstructing ambient state that only existed at call time.

## Testing policy

- Two suites: **FAST** (pure logic, no network — the default `npm test`, seconds) and **LIVE** (real API calls, separate command, run on demand).
- Live tests live in separate `*.live.test.ts` files — visible and greppable. Never `.skipIf` env-var wrappers: silently skipped tests drift invisibly.
- Per-file test databases; parallelism on. One shared seed helper for the primary user — no hand-rolled seeds per file.
- The suite must FAIL LOUDLY if the test DB path is unset or misresolved. It must never fall back to a real database path.
- Destructive SQL is prohibited in test files. All resets go through the harness.
- Stochastic LLM decisions (router flags, attestation classifier) are validated at N=20 runs per case, ≥19 to pass, scored as per-flag confusion matrices with asymmetric thresholds (EN-075). A single lucky pass certifies nothing.

## Verification policy

- After each part of a multi-part task: run FAST, and live-verify that the specific thing just built actually works — observed behavior, not code inspection. This is never deferred.
- Any change touching `app/`, `lib/`, or a module reachable from a Next.js route or page also requires `npm run build` before being reported done (EN-092, R36). `tsc --noEmit` and the FAST suite verify logic, never bundling — 430 green FAST tests once certified a build where every API route and the client page 500'd, because Turbopack (Next.js 16's default bundler) can't resolve this codebase's `.js`-suffixed-import-to-`.ts`-source convention. **This project builds with webpack, not Turbopack** — `npm run dev` / `npm run build` / `npm run start` are pinned to `--webpack` in package.json for exactly this reason (see next.config.ts). Plain `next dev` / `next build` are not valid verification and must not be used directly; do not drop `--webpack` from those scripts without first confirming Turbopack has grown a real fix.
- Full suite (including LIVE) once at the end of a batch.
- Commit each part separately so a red batch can be bisected.
- Never report a feature as done without observed-behavior evidence. Reports without evidence are unverified by definition.
- Persona properties are judged by reading actual replies from live conversations, never by inspecting prompt text.
- Reply-level testing cannot verify storage-level properties — any claim about what was stored requires reading the projection or the event payload.

## Reporting

- All reports are plain text printed in the terminal for copy-paste. Never write reports to files. Never direct the user to open a file for results.
- Plain formatting: no boxes, no heavy ASCII art, nothing that breaks when copied.
- Reference EN-numbers for every requirement touched.
- Honesty over completeness theater: if something doesn't work, is unverified, or was skipped, say so plainly at the top, not in a footnote. The most expensive failures in this project's history were unverified "done" claims.

## Working with the user's real data

- Live verification against the real account requires explicit care: any test data inserted must be tracked by explicit ID and fully removed afterward, and the removal reported with what was deleted.
- Cleanup queries scoped by anything broader than explicit test-entity IDs (time ranges, recency) are prohibited.
- If an operation could touch real user data destructively, stop and confirm before running it.

## Prompts and provider work

- Provider capabilities (PDF input, tool-calling shape, caching, limits) are verified at build time per EN-082 — never assumed from memory.
- No blanket capability prohibitions in any prompt ("no maps access" — see R3). Behaviors that must happen reliably get explicit gates, not prompt paragraphs (EN-070).
- Judgment gates run on a mid-tier model minimum; per-model certification is required, and uncertified failover tiers bypass gates to no-action (EN-074, EN-083).
