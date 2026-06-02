// Side-by-side, OBSERVED: the verified sliding limiter holds <= limit in every
// window, while the naive fixed-window counter leaks 2x across a boundary.
//
//   npm run demo
//
// The decision for the sliding column is the VERIFIED `admit` from the package
// core. The fixed-window column is a textbook per-bucket counter (untrusted,
// here only as the foil). We drive a deterministic trace so the boundary
// straddle is reproducible, then MEASURE the worst sliding window of each — the
// leak is counted from the actual admissions, not asserted.
import { admit } from '../src/core.verified.js';

const limit = 5;
const W = 10_000; // 10s

// The naive cousin: count per fixed bucket floor(t / W), reset at each boundary.
class FixedWindow {
  private bucket = -1;
  private count = 0;
  admit(now: number): boolean {
    const b = Math.floor(now / W);
    if (b !== this.bucket) {
      this.bucket = b;
      this.count = 0;
    }
    if (this.count < limit) {
      this.count += 1;
      return true;
    }
    return false;
  }
}

// Worst case over ALL sliding windows: the most admissions any (s, s+W] holds.
function maxInAnyWindow(times: number[]): number {
  let worst = 0;
  for (const s of times) {
    // window (s - 1, s - 1 + W] — anchored just below each admitted time
    const lo = s - 1;
    const count = times.filter((t) => lo < t && t <= lo + W).length;
    if (count > worst) worst = count;
  }
  return worst;
}

// The trace: 5 requests just before the boundary at 10.000s, 5 just after.
const trace = [
  9_999, 9_999, 9_999, 9_999, 9_999,
  10_000, 10_000, 10_000, 10_000, 10_000,
];

const fw = new FixedWindow();
const fixedAdmitted: number[] = [];
let slidingLog: number[] = [];
const slidingAdmitted: number[] = [];

for (const now of trace) {
  if (fw.admit(now)) fixedAdmitted.push(now);
  const r = admit(slidingLog, now, W, limit);
  slidingLog = r.log;
  if (r.ok) slidingAdmitted.push(now);
}

const fmt = (t: number) => (t / 1000).toFixed(3) + 's';
const tick = (n: number) => '✓'.repeat(n) + '✗'.repeat(5 - n);
const before = (a: number[]) => a.filter((t) => t === 9_999).length;
const after = (a: number[]) => a.filter((t) => t === 10_000).length;

console.log('\nhono-rate-limiter-with-lemmascript — sliding vs fixed-window, observed');
console.log(`limit = ${limit}, window W = ${W / 1000}s`);
console.log(`\nTrace: 5 requests at t=${fmt(9_999)}, then 5 at t=${fmt(10_000)} (straddling the W boundary)\n`);

console.log('  fixed-window counter (the naive cousin):');
console.log(`    t=${fmt(9_999)}  ${tick(before(fixedAdmitted))}   (bucket 0)`);
console.log(`    t=${fmt(10_000)} ${tick(after(fixedAdmitted))}   (bucket 1 — counter resets)`);
console.log(`    => ${fixedAdmitted.length} admitted; worst 10s window holds ${maxInAnyWindow(fixedAdmitted)}  ${maxInAnyWindow(fixedAdmitted) > limit ? '✗ LEAK' : 'ok'}\n`);

console.log('  verified sliding limiter (admit, proved):');
console.log(`    t=${fmt(9_999)}  ${tick(before(slidingAdmitted))}   (window fills to ${before(slidingAdmitted)})`);
console.log(`    t=${fmt(10_000)} ${tick(after(slidingAdmitted))}   (${limit} still in window => rejected)`);
console.log(`    => ${slidingAdmitted.length} admitted; worst 10s window holds ${maxInAnyWindow(slidingAdmitted)}  ${maxInAnyWindow(slidingAdmitted) <= limit ? '✓ HOLDS' : '✗'}\n`);

console.log('  The 2x burst the fixed-window counter just leaked is the exact trace');
console.log('  core.verified.dfy:FixedWindowLeaks proves impossible for `admit`.\n');

process.exit(maxInAnyWindow(slidingAdmitted) <= limit && maxInAnyWindow(fixedAdmitted) > limit ? 0 : 1);
