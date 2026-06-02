//@ backend dafny

// ════════════════════════════════════════════════════════════════
// hono-rate-limiter-with-lemmascript — verified sliding-window core
//
// The state for one key is the LOG of admitted request timestamps, in
// integer milliseconds. admit() prunes the log to the current window
// (now - W, now], then admits a new request IFF fewer than `limit`
// admissions remain in that window.
//
//   pruneWindow  keep only admissions inside (now - W, now] — this IS
//                the set of in-window admissions
//   activeCount  how many of them there are (for rate-limit headers)
//   admit        prune + decide; returns the new log and ok / !ok
//
// Two load-bearing guarantees over the new log, for ANY input log
// satisfying the carried invariant, ANY now, window W, limit:
//
//   BOUND            |result.log| <= limit
//   WINDOW-FAITHFUL  every entry t of result.log has now - W < t <= now
//
// Because the pruned log *is* exactly the admissions in the current
// window, the simple invariant |log| <= limit already delivers the
// window bound: at any moment, the trailing W-window holds at most
// `limit` admissions. The cross-boundary 2× burst a fixed-window
// counter allows is provably impossible here (see core.verified.dfy:
// the SlidingBound meta-theorem and the FixedWindowLeaks witness).
//
// `now` is integer ms, NON-DECREASING across calls — the clock's job, a
// caller obligation (a requires), not proved here. Time is the new
// money: integer milliseconds is the representation that can't drift.
// ════════════════════════════════════════════════════════════════

interface AdmitResult {
  log: number[];
  ok: boolean;
}

// Prune the log to the current window: keep admissions strictly newer
// than now - W. Given a log whose timestamps are all <= now (the
// clock-monotone invariant), the result is exactly the admissions that
// fall in the half-open window (now - W, now]. Written as an explicit
// fold (rather than .filter) so the verifier inducts on it directly.
export function pruneWindow(log: number[], now: number, W: number): number[] {
  //@ requires forall(k, 0 <= k && k < log.length ==> log[k] <= now)
  //@ decreases log.length
  //@ ensures \result.length <= log.length
  //@ ensures forall(k, 0 <= k && k < \result.length ==> now - W < \result[k] && \result[k] <= now)
  if (log.length === 0) {
    return [];
  }
  const rest = pruneWindow(log.slice(1), now, W);
  if (log[0] > now - W) {
    return [log[0], ...rest];
  }
  return rest;
}

// How many admissions still fall inside the window (now - W, now].
// The middleware reads this to emit X-RateLimit-Remaining = limit - activeCount.
export function activeCount(log: number[], now: number, W: number): number {
  //@ requires forall(k, 0 <= k && k < log.length ==> log[k] <= now)
  //@ ensures \result <= log.length
  return pruneWindow(log, now, W).length;
}

// Prune, then admit a request at `now` iff fewer than `limit` admissions
// remain in the window. Returns the new log (to write back to the store)
// and whether the request was admitted.
export function admit(log: number[], now: number, W: number, limit: number): AdmitResult {
  //@ requires W >= 1
  //@ requires limit >= 0
  //@ requires log.length <= limit
  //@ requires forall(k, 0 <= k && k < log.length ==> log[k] <= now)
  // BOUND:
  //@ ensures \result.log.length <= limit
  // WINDOW-FAITHFUL:
  //@ ensures forall(k, 0 <= k && k < \result.log.length ==> now - W < \result.log[k] && \result.log[k] <= now)
  // exact decision + non-restrictive:
  //@ ensures \result.ok === (activeCount(log, now, W) < limit)
  const active = pruneWindow(log, now, W);
  if (active.length < limit) {
    return { log: [...active, now], ok: true };
  }
  return { log: active, ok: false };
}
