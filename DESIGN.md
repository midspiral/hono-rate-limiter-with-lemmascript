# DESIGN — verified rate-limit middleware for Hono

> **Never more than `limit` admissions in any window of length `W` — including across the
> window boundary.** Naive fixed-window limiters let a client fire `limit` requests at the end
> of one window and `limit` more at the start of the next: a 2× burst the docs swear can't
> happen. The load-bearing invariant here is a *sliding* window, so that burst is provably
> impossible.

**Status:** _built._ Stages 0–3 done — verified core (23 Dafny VCs), Hono
middleware, demo, and live HTTP server all working. Stage 4 (variants) deferred. Kept as a
case study, not distributed as a package. This document is kept as the
design of record; the staged plan below reflects what landed.
**Category:** greenfield verified feature, distributed through a brownfield host's **extension
seam** (Hono middleware, `app.use(...)`) — a **standalone package** that `import`s Hono, **not a
fork**. Verification flavor: an **invariant over a small stateful core** (the app-native flavor),
not a pure one-shot algorithm.

Ships as a standalone middleware package (`hono-rate-limiter-with-lemmascript`).

---

## 1. Motivation

Rate limiters are everywhere and almost always subtly wrong at the seam: the **fixed-window
boundary burst**. Count-per-fixed-window says "≤ N per minute," but a client can do N at
`:59.9` and N at `:00.1` — 2N in 200ms. Token buckets fix the *rate* but the per-window count
story is fuzzy. We verify the crisp guarantee people actually want — *≤ `limit` in any sliding
window* — and ship it where Hono already accepts behavior: middleware.

This is greenfield-in-brownfield in the cleanest sense: Hono's middleware contract *is* the
extension point, so the deliverable is a separate package, never a patch to Hono.

## 2. The one thing that must never break

> **Sliding-window bound.** For any key, over any monotonic sequence of requests, the number
> admitted whose timestamps fall in **any** half-open interval `(s, s + W]` is ≤ `limit`.

Not "≤ limit per fixed window" — *per sliding window*. That single strengthening is what kills
the boundary burst, and it's the whole point of verifying this rather than trusting it.

## 3. The verified core

**Integer milliseconds. No floats.** (Time is the new money — same lesson: pick the
representation that can't drift.)

State for a key is the log of admitted timestamps, pruned to the window:

```ts
//@ ensures \result.length <= limit                                  // BOUND
//@ ensures forall(k, 0 <= k && k < \result.length ==> now - W < \result[k] && \result[k] <= now)  // window-faithful
function admit(log: number[], now: number, W: number, limit: number): { log: number[], ok: boolean }
```

### The key insight
Keep only admissions within `(now - W, now]`; admit **iff** fewer than `limit` remain. The
pruned log then *is* exactly the set of admissions in the current window, so the simple
invariant `|log| <= limit` already delivers the window bound — at any moment, the trailing
`W`-window holds at most `limit` admissions.

```ts
function admit(log, now, W, limit) {
  //@ verify
  const active = log.filter((t) => t > now - W);   // prune
  if (active.length < limit) {
    return { log: [...active, now], ok: true };
  }
  return { log: active, ok: false };
}
```

(`now` is non-decreasing across calls — a `requires`/caller obligation, the clock's job.)

## 4. Theorems (proven)

1. **Bound** — after every `admit`, `|log| <= limit`.
2. **Window-faithful** — after every `admit`, `log` is exactly the admitted timestamps in
   `(now - W, now]` (monotone, in-window).
3. **Sliding bound (headline)** — composing 1+2 over a call sequence: admissions in any
   `(s, s+W]` ≤ `limit`. The guarantee.
4. **Not over-restrictive** — if `active.length < limit`, the request *is* admitted (the limiter
   never rejects below the limit).
5. **Naive-leak counterexample** — a fixed-window counter admits up to `2*limit` across a
   boundary; exhibited as a concrete trace (the eventab-style "the cheap version is
   plausible-but-wrong," now machine-checked).

## 5. Trust boundary — verified vs. trusted

- **Verified** (pure, integer time): `admit` — the sliding-window bound and non-restriction.
- **Trusted (the shell):**
  - **The clock** — `now` is monotone non-decreasing. A lying/rewinding clock is outside the proof.
  - **The per-key store** — Map / Redis; read-modify-write must be **atomic per key** (or
    serialized). Under a shared store across instances, the proof holds *per key* only if the
    store gives compare-and-set / a Lua script; concurrent un-serialized RMW can over-admit.
    Named, not hidden.
  - **Keying** — which client maps to which bucket (IP, API key, user) is shell policy.
  - The `429` response and headers are glue.

## 6. Host integration — the Hono seam

```ts
import { rateLimit } from 'hono-rate-limiter-with-lemmascript';
app.use('*', rateLimit({ limit: 100, windowMs: 60_000, key: (c) => c.req.header('x-api-key') ?? ip(c) }));
```

The middleware: derive the key, read the key's `log` from the store, call the **verified**
`admit(log, now, W, limit)`, write `log` back, then `429` or `await next()`. The store + clock +
keying are untrusted glue; the *decision* is the verified core. Standalone package depending on
`hono` (peer).

## 7. Demo (run it)

A tiny Hono app, `limit = 5`, `W = 10s`. Fire a burst with a timestamped client and show:
- the verified limiter holds **≤ 5 in every sliding 10s window**, even when requests straddle a
  boundary;
- side-by-side, a **fixed-window** variant lets **10** through across the boundary — the leak,
  on screen, the way the lint demo showed the one-hop miss.
Observed against a real running server, not asserted.

## 8. Architecture

```
  src/core.verified.ts   VERIFIED. admit() over integer-ms logs. Pure. No I/O.
  src/store.ts           glue: per-key log store (Map; Redis adapter). UNTRUSTED.
  src/middleware.ts      the Hono middleware: key → store → admit → 429/next.
  src/index.ts           package entry: { rateLimit }.
  examples/              demo app + the fixed-window-leaks comparison.
```

## 9. Staged proof plan

| Stage | Lands | Status |
|---|---|---|
| **0 — core invariant** | `admit`; **Bound** + **Window-faithful** | ✅ done (`core.verified.ts`/`.dfy`) |
| **1 — sliding bound + counterexample** | the headline window-bound theorem (`run`/`SlidingWindowBound`); the fixed-window-leaks witness (`FixedWindowLeaks`) | ✅ done (23 Dafny VCs) |
| **2 — Hono middleware** | store + keying + the `app.use` middleware wiring the verified core | ✅ done (`middleware.ts`, `store.ts`) |
| **3 — demo** | running server; sliding holds vs fixed-window leaks, observed | ✅ done (`examples/server.ts`, `examples/leak.ts`) |
| **4 — variants (optional)** | token-bucket core (burst allowance, `0 <= tokens <= cap`); Redis CAS store. A Redis adapter needs an **async** `LogStore` (the shipped interface is sync) plus compare-and-set for per-key atomicity. | _deferred_ |

**Spike (held):** Stage 0 + the counterexample. The bound + window-faithful invariants were
clean and the fixed-window leak fell out as a short trace, so the spine held and the rest followed.

## 10. What is *not* verified

- The clock's monotonicity; the store's atomicity; distributed coordination across instances.
- Keying policy (who counts as one client).
- The HTTP layer (Hono itself, the `429`). The trustworthy artifact is the **decision** — the
  count in any window can't exceed the limit.
