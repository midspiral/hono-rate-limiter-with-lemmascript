# hono-rate-limiter-with-lemmascript

[![LemmaScript verified](https://img.shields.io/github/actions/workflow/status/midspiral/hono-rate-limiter-with-lemmascript/lemmascript.yml?branch=main&label=LemmaScript%20verified)](https://github.com/midspiral/hono-rate-limiter-with-lemmascript/actions/workflows/lemmascript.yml)

**A formally-verified rate limiter for [Hono](https://hono.dev).** Most limiters are
correct-on-faith, and the common *fixed-window* counter is subtly wrong at one specific seam —
the window boundary.
This one's admission decision is a *machine-checked theorem*, proved in
[LemmaScript](https://lemmascript.com) (TypeScript verified through Dafny) and shipped as the
limiter's actual runtime code:

> **Never more than `limit` admissions in any window of length `W`** — including across the
> boundary.

## The problem: the fixed-window boundary burst

The textbook "N requests per minute" limiter counts admissions per *fixed* clock window and
resets the counter at each boundary. So a client can do this:

```
   :59.900   [#####]   5 requests  (this minute's bucket: 0 -> 5)
   :00.100   [#####]   5 requests  (next minute's bucket resets: 0 -> 5)
```

That's **10 requests in 200 ms** — twice the limit the docs promised — and the counter stays
green the whole time, because the burst straddles a reset. Token buckets fix the *rate* but
leave the per-window count fuzzy. This package verifies the crisp guarantee people actually
want: **≤ `limit` in any _sliding_ window**, which makes that burst provably impossible.

```
$ npm run demo

  fixed-window counter (the naive cousin):
    t=9.999s  ✓✓✓✓✓   (bucket 0)
    t=10.000s ✓✓✓✓✓   (bucket 1 — counter resets)
    => 10 admitted; worst 10s window holds 10  ✗ LEAK

  verified sliding limiter (admit, proved):
    t=9.999s  ✓✓✓✓✓   (window fills to 5)
    t=10.000s ✗✗✗✗✗   (5 still in window => rejected)
    => 5 admitted; worst 10s window holds 5  ✓ HOLDS
```

## What's proven

The verified core is [`src/core.verified.ts`](src/core.verified.ts) — integer-millisecond
admission logs, no floats. Dafny machine-checks (23 verification tasks, run in CI):

- **Bound** — after every `admit`, the stored log has `|log| <= limit`.
- **Window-faithful** — the stored log holds exactly the admissions in the current window
  `(now - W, now]` (every entry is in-window; nothing in the future).
- **Sliding bound (the headline)** — folding `admit` over *any* monotone request stream yields
  an admission history in which **no half-open window `(s, s + W]` ever holds more than `limit`
  admissions** (`run` maintains the `Spread` invariant; `SlidingWindowBound` is its window
  reading). The boundary burst is not mitigated — it is *impossible*.
- **Non-restrictive** — the limiter admits whenever fewer than `limit` admissions are in the
  window; it never rejects below the limit.
- **The fixed-window counter provably leaks** — `FixedWindowLeaks` exhibits a concrete trace
  where the naive per-bucket counter admits `2 × limit` inside one sliding window, while the
  verified `admit`, on the same trace, rejects the overflow. The cheap version is
  plausible-but-wrong, machine-checked.

The proof and a walkthrough are in [`DESIGN.md`](DESIGN.md) and
[`src/core.verified.dfy`](src/core.verified.dfy).

## Get it

This is a [LemmaScript](https://lemmascript.com) case study, not a published package — clone and
build it locally:

```sh
git clone https://github.com/midspiral/hono-rate-limiter-with-lemmascript
cd hono-rate-limiter-with-lemmascript && npm install   # hono comes along as a dependency
```

## Use

```ts
import { Hono } from 'hono';
import { rateLimit } from 'hono-rate-limiter-with-lemmascript';

const app = new Hono();

app.use(
  '*',
  rateLimit({
    limit: 100,
    windowMs: 60_000,
    key: (c) => c.req.header('x-api-key') ?? 'anon', // who counts as one client — your policy
  })
);

app.get('/', (c) => c.json({ ok: true }));
```

Each request derives its key, the verified `admit` decides, and the middleware returns `429`
(with `Retry-After`) or calls `next()`. Standard `X-RateLimit-Limit` / `X-RateLimit-Remaining`
headers are set from the verified in-window count.

**Options**
- `limit` — max admissions in any sliding window.
- `windowMs` — the window length `W`, in milliseconds.
- `key(c)` — maps a request to its bucket (IP, API key, user). Shell policy.
- `store?` — where per-key logs live; defaults to an in-process `Map` (`MemoryStore`). Implement
  `LogStore` for Redis etc.
- `now?` — clock, defaults to `Date.now`. Must be non-decreasing (see below).
- `onLimit?` — custom rejection response.

## Try it on a real server

```sh
npm run serve              # starts a Hono server, fires 7 requests, shows the live verdicts
```

```
  #1  ->  200  admitted   X-RateLimit-Remaining: 4
  ...
  #5  ->  200  admitted   X-RateLimit-Remaining: 0
  #6  ->  429  RATE LIMITED   X-RateLimit-Remaining: 0   Retry-After: 10s
  #7  ->  429  RATE LIMITED   X-RateLimit-Remaining: 0   Retry-After: 10s
```

Or `npm run serve -- --hold` and `curl` it yourself.

## What's verified, what's trusted

The proof governs the **decision**, not the I/O. Stated plainly:

- **Verified** (pure functions over integer-ms logs, proved in LemmaScript → Dafny): `admit` —
  the bound, window-faithfulness, the sliding-window guarantee, and non-restriction.
- **Trusted** (the untrusted shell), each named, not hidden:
  - **The clock.** `now` must be non-decreasing. The middleware clamps `now` up to the newest
    logged timestamp so every call stays inside the verified precondition, but a grossly
    rewinding wall clock is outside the proof.
  - **The store.** The per-key read-modify-write must be **atomic per key**. A single process +
    `Map` gives that for free; a shared Redis store needs a compare-and-set / Lua script, or
    concurrent un-serialized writes can over-admit. The bound is **per key**.
  - **Keying.** Which client maps to which bucket is your policy.
  - The `429`, the headers, and Hono itself are glue.

There is no "verified end-to-end" claim. What's proven is the part where the bug always hides —
the count in any window can't exceed the limit — so the trust surface shrinks to one auditable
question (*is the store atomic per key?*) instead of *that **and** is the window math right*.

## Verify it yourself

```sh
npm run typecheck    # the whole middleware typechecks against the verified core
npm run verify       # regenerate + Dafny-check core.verified.ts (needs Dafny + the LemmaScript toolchain)
```

## Status

A [LemmaScript](https://lemmascript.com) case study, working end-to-end. The verified core is
the sliding-window admission decision; the Hono middleware, store, and keying are the trusted
shell.

The timestamp-log design verified here is correct *by construction*, so the proof buys the
machine-checked guarantee and the fixed-window counterexample — not the catch of a subtle bug in
this design. The boundary math that *is* error-prone lives elsewhere: in the efficient ring-buffer
"sliding-window counter" approximations people actually ship, and in the fractional arithmetic of
token-bucket / GCRA limiters — natural next targets for a verified core, where the algorithm
itself is the hard part. A Redis-backed CAS store is the other obvious extension.
