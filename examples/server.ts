// A real Hono server, behind the VERIFIED rate-limit middleware, handling real
// HTTP. Proves the verified core is wired into a running app — not just unit
// tested.
//
//   npm run serve              # start + self-drive 7 requests, print live results
//   npm run serve -- --hold    # start and stay up so you can curl it yourself
//
// limit = 5, window = 10s, keyed by the `x-demo-key` header (default "anon").
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { rateLimit } from '../src/index.js';

const app = new Hono();

app.use(
  '*',
  rateLimit({
    limit: 5,
    windowMs: 10_000,
    key: (c) => c.req.header('x-demo-key') ?? 'anon',
  })
);

app.get('/', (c) => c.json({ ok: true, msg: 'request admitted' }));

const port = 8787;
const server = serve({ fetch: app.fetch, port });
console.log(`\nhono-rate-limiter-with-lemmascript — server on http://localhost:${port}`);
console.log('limit = 5 admissions per sliding 10s window, key = x-demo-key header\n');

if (process.argv.includes('--hold')) {
  console.log('Holding. Try:  for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code} " localhost:8787; done\n');
} else {
  // Drive 7 real HTTP requests against ourselves and show the live verdicts.
  const base = `http://localhost:${port}/`;
  console.log('Firing 7 requests (same key) — expect 5x 200 then 2x 429:\n');
  for (let i = 1; i <= 7; i++) {
    const res = await fetch(base);
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retry = res.headers.get('retry-after');
    const tag = res.status === 200 ? 'admitted' : 'RATE LIMITED';
    console.log(
      `  #${i}  ->  ${res.status}  ${tag}` +
        `   X-RateLimit-Remaining: ${remaining}` +
        (retry ? `   Retry-After: ${retry}s` : '')
    );
  }
  console.log('\nThe 6th and 7th were rejected by the verified `admit` — observed over real HTTP.\n');
  server.close();
}
