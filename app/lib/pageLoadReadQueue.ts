/**
 * Serializes one uid's mount-time authenticated reads (GET /api/history,
 * GET /api/directory, GET /api/zodiac-sidebar today — any future one
 * tomorrow) so they never contend at the per-user storage READ lock at
 * the same moment.
 *
 * The bug this fixes: each of those reads used to fire from its own
 * independent useEffect, guarded only by "is a user signed in," with
 * nothing coordinating them — three requests for the same uid landing on
 * the server within the same tick. runReadOnlyUserSession already retries
 * a lock refusal against ANOTHER reader (src/storage/userSession.ts's
 * acquireReadOnlyLockWithRetry, 3 attempts / 150ms), but that budget was
 * tuned against exactly two concurrent readers (history + zodiac-sidebar,
 * the collision that motivated building it) and inherited a third
 * (GET /api/directory, EN-110) the very next day with nothing
 * re-verifying it still held — a real LockAcquisitionError 500 reached
 * production this way.
 *
 * Fixed at the source instead of re-tuning that budget: route every
 * mount-time authenticated read for a given uid through runSequenced, and
 * only one is ever in flight to the network at a time for that uid — the
 * lock is never contended by this app's OWN concurrent requests at all,
 * regardless of how many mount-time readers exist today or get added
 * later. A future reader joins automatically just by calling
 * runSequenced(uid, ...) instead of fetching directly; there is no
 * pairwise ordering between specific routes to get wrong, and no author
 * of a fourth reader needs to know this history to avoid reintroducing it.
 *
 * One read failing never blocks the next: the per-uid chain always
 * advances past a rejected task (task runs as both the onFulfilled and
 * onRejected handler of the previous entry), so one route's error can't
 * wedge every later read for that uid behind it for the rest of the page
 * load. The promise returned to the CALLER still resolves/rejects exactly
 * as task() itself does — this only serializes when each task STARTS,
 * never how its own result is reported.
 */
const queues = new Map<string, Promise<unknown>>();

export function runSequenced<T>(uid: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(uid) ?? Promise.resolve();
  const result = previous.then(task, task);
  // Tracked separately from `result`: this must never reject, or the NEXT
  // caller's `.then(task, task)` above would still run task correctly (both
  // handlers are the same function), but a rejected value sitting in the map
  // longer than necessary is worth avoiding on principle — collapse it to a
  // settled, side-effect-free marker immediately.
  queues.set(
    uid,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}
