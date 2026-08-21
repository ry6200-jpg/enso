/**
 * Shared seed helper for the primary user (EN-091: no hand-rolled seeds per
 * file). Phase 1 has no separate users table — events are simply keyed by
 * user_id — so "seeding" is just handing out this one stable id for every
 * test to use consistently.
 */
export const PRIMARY_USER_ID = "01JPRIMARYUSER0000000000";
