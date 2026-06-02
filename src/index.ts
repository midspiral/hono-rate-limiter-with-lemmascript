// hono-rate-limiter-with-lemmascript — a sliding-window rate limiter for Hono
// whose admission decision is a machine-checked theorem (LemmaScript → Dafny):
// no window of width W ever admits more than `limit` requests, so the
// fixed-window boundary burst is provably impossible. See README.md / DESIGN.md.
export { rateLimit, type RateLimitOptions } from './middleware.js';
export { MemoryStore, type LogStore } from './store.js';

// The verified core is exported too, for callers who want the proven decision
// without the Hono shell (e.g. a different framework, or a unit test).
export { admit, activeCount, pruneWindow } from './core.verified.js';
