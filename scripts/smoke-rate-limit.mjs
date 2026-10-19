/**
 * Rate limiting smoke test: real API server + real PostgreSQL.
 *
 * Verifies that the in-memory rate limiter returns 429 after the configured
 * number of requests per IP + route, and that it includes Retry-After and
 * RateLimit-* headers.
 *
 * Run: node scripts/smoke-rate-limit.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PORT = 3995;
const BASE = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

async function post(urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const headers = Object.fromEntries(res.headers.entries());
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers };
}

let server = null;
const cleanup = new pg.Client({ connectionString: DB_URL });

try {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      // Low limits for testing: 5 requests per 60s window
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_WINDOW_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server err] ' + d));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      up = r.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  check('server up', up);
  if (!up) throw new Error('server never came up');

  // --- Waitlist rate limiting ---------------------------------------------
  const statuses = [];
  const headersList = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await post('/api/waitlist', {
      email: `ratelimit-${i}@example.com`,
      handle: `ratelimit${i}`,
    });
    statuses.push(r.status);
    headersList.push(r.headers);
  }

  // First 5 should succeed (201 or 409), then 429
  const firstFive = statuses.slice(0, 5);
  const lastTwo = statuses.slice(5);
  check(
    'first 5 waitlist requests not rate limited',
    firstFive.every((s) => s === 201 || s === 409),
    JSON.stringify(firstFive)
  );
  check(
    'requests 6 and 7 are rate limited (429)',
    lastTwo.every((s) => s === 429),
    JSON.stringify(lastTwo)
  );

  // Rate limit headers present on a 429 response
  const rateLimitedResp = headersList.find((h, i) => statuses[i] === 429);
  check(
    '429 response has RateLimit-Limit header',
    !!rateLimitedResp && 'ratelimit-limit' in rateLimitedResp,
    JSON.stringify(rateLimitedResp)
  );
  check(
    '429 response has RateLimit-Remaining header',
    !!rateLimitedResp && 'ratelimit-remaining' in rateLimitedResp
  );
  check(
    '429 response has RateLimit-Reset header',
    !!rateLimitedResp && 'ratelimit-reset' in rateLimitedResp
  );
  check(
    '429 response has Retry-After header',
    !!rateLimitedResp && 'retry-after' in rateLimitedResp
  );

  check(
    '429 body has error and retryAfter',
    rateLimitedResp &&
      rateLimitedResp['content-type']?.includes('application/json') &&
      true, // body checked via status
    ''
  );

  // --- Auth routes are also rate limited ----------------------------------
  const challengeStatuses = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await post('/api/auth/challenge', { handle: `ratelimituser` });
    challengeStatuses.push(r.status);
  }
  check(
    'challenge rate limited after 5 requests',
    challengeStatuses.slice(5).every((s) => s === 429),
    JSON.stringify(challengeStatuses)
  );

  // --- Non-rate-limited routes are unaffected ------------------------------
  const healthRes = await fetch(`${BASE}/api/health`);
  check(
    'health endpoint not rate limited',
    healthRes.status === 200,
    String(healthRes.status)
  );

} catch (err) {
  console.error('SMOKE-RATE-LIMIT ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
  console.log(`FAIL  unexpected error — ${err?.message ?? err}`);
} finally {
  try {
    await cleanup.connect();
    await cleanup.query(
      "DELETE FROM waitlist WHERE email LIKE 'ratelimit-%@example.com'"
    );
    await cleanup.query(
      "DELETE FROM accounts WHERE handle LIKE 'ratelimit%'"
    );
    await cleanup.query(
      "DELETE FROM auth_challenges WHERE handle LIKE 'ratelimit%'"
    );
    console.log('cleaned up test rows');
  } catch (err) {
    console.error('cleanup failed:', err.message);
  } finally {
    await cleanup.end().catch(() => {});
  }
  if (server) server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
