// ── The Hono seam: rate-limit middleware wrapping the VERIFIED decision ───────
// Hono's middleware contract is the extension point; this is a standalone
// package, never a patch to Hono. The middleware does the untrusted glue —
// derive the key, read the log, write it back, emit headers, return 429 — and
// delegates the one decision that must be correct to the verified core:
//
//     admit(log, now, W, limit)  →  { log, ok }
//
// proved in core.verified.ts (Dafny) to keep |log| <= limit and the log
// window-faithful, so that no sliding window of width W ever admits more than
// `limit` requests (core.verified.dfy: SlidingWindowBound, run).
import type { Context, MiddlewareHandler } from 'hono';
import { admit, activeCount } from './core.verified.js';
import { MemoryStore, type LogStore } from './store.js';

export interface RateLimitOptions {
  /** Max admissions allowed in any sliding window of `windowMs`. */
  limit: number;
  /** Window length in milliseconds (the W of the sliding-window bound). */
  windowMs: number;
  /** Maps a request to its bucket key (IP, API key, user, …). Shell policy. */
  key: (c: Context) => string;
  /** Where per-key logs live. Defaults to an in-process Map. */
  store?: LogStore;
  /** Clock; defaults to Date.now. Must be non-decreasing (the proof's premise). */
  now?: () => number;
  /** Response when rejected. Defaults to 429 with a JSON body + Retry-After. */
  onLimit?: (c: Context, retryAfterMs: number) => Response | Promise<Response>;
}

// Largest timestamp in a (small, pruned) log — used to keep the verified
// precondition `every logged time <= now` satisfied even if the wall clock
// steps backwards. A rewinding clock is named as untrusted in the design; this
// guard keeps every call to `admit` strictly inside its proven contract.
function maxTs(log: number[]): number {
  let m = log[0] ?? 0;
  for (const t of log) if (t > m) m = t;
  return m;
}

export const rateLimit = (options: RateLimitOptions): MiddlewareHandler => {
  const { limit, windowMs: W } = options;
  const store = options.store ?? new MemoryStore();
  const clock = options.now ?? Date.now;

  return async (c, next) => {
    const key = options.key(c);
    const log = store.get(key);

    // Clamp the clock forward so `now >= every logged time` — the monotone-clock
    // precondition the verified `admit` requires. (Trusted glue; see README.)
    const now = Math.max(clock(), maxTs(log));

    // ── the one verified line: prune to (now - W, now], admit iff < limit ──
    const result = admit(log, now, W, limit);
    store.set(key, result.log);

    // Standard rate-limit headers. `activeCount` (verified) is the in-window count.
    const used = activeCount(result.log, now, W);
    const remaining = limit - used;
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining < 0 ? 0 : remaining));

    if (!result.ok) {
      // Oldest in-window admission expires first; that is when a slot frees up.
      const oldest = result.log.length > 0 ? Math.min(...result.log) : now;
      const retryAfterMs = oldest + W - now;
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      if (options.onLimit) return options.onLimit(c, retryAfterMs);
      return c.json({ error: 'rate_limited', retryAfterMs }, 429);
    }

    await next();
  };
};
