/**
 * End-to-end smoke test (dev only, not wired into package.json scripts).
 *
 * Boots an embedded PostgreSQL, applies db/schema.sql, exercises server/db.js
 * directly, then spawns the real API server and hits it over HTTP.
 *
 * Run: node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PG_PORT = 55432;
const API_PORT = 3999;
const DB_URL = `postgres://postgres:password@localhost:${PG_PORT}/hackersdigest`;

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

// Dedicated data dir: .tmp-pgdata belongs to dev-db.mjs — sharing it would
// let this test wipe (or collide with) the local dev cluster.
const SMOKE_DIR = path.join(ROOT, '.tmp-pgdata-smoke');
fs.rmSync(SMOKE_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: SMOKE_DIR,
  user: 'postgres',
  password: 'password',
  port: PG_PORT,
  persistent: false,
});

let server = null;

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('hackersdigest');

  process.env.DATABASE_URL = DB_URL;
  process.env.PORT = String(API_PORT);
  const db = await import('../server/db.js');

  // --- db.js against a real database ---
  const connected = await db.initSchema();
  check('initSchema connects and applies schema', connected);

  let stats = await db.getStats();
  check('empty stats', stats.signups === 0 && stats.posts === 0, JSON.stringify(stats));

  const first = await db.addWaitlist('alice@example.com', 'alice');
  check('first signup → position 1', first.inserted === true && first.position === 1, JSON.stringify(first));

  const dupEmail = await db.addWaitlist('alice@example.com', 'bob');
  check('duplicate email → inserted:false', dupEmail.inserted === false, JSON.stringify(dupEmail));

  let handleErr = null;
  try {
    await db.addWaitlist('bob@example.com', 'alice');
  } catch (err) {
    handleErr = err;
  }
  check('duplicate handle → pg code 23505', handleErr?.code === '23505', handleErr?.code);

  stats = await db.getStats();
  check('stats after signup → 1', stats.signups === 1, JSON.stringify(stats));

  // --- full API over HTTP (server/index.js + built SPA) ---
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));

  const base = `http://localhost:${API_PORT}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  check('server starts', up);

  if (up) {
    const health = await (await fetch(`${base}/api/health`)).json();
    check('/api/health → db up', health.db === 'up', JSON.stringify(health));

    const apiStats = await (await fetch(`${base}/api/stats`)).json();
    check('/api/stats → 1 signup', apiStats.db === 'up' && apiStats.signups === 1, JSON.stringify(apiStats));

    const created = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'carol@example.com', handle: 'carol' }),
    });
    const createdBody = await created.json();
    check('POST /api/waitlist → 201 position 2', created.status === 201 && createdBody.position === 2, `${created.status} ${JSON.stringify(createdBody)}`);

    const dup = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'carol@example.com' }),
    });
    check('POST duplicate → 409', dup.status === 409, String(dup.status));

    const bad = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nope', handle: 'x y!' }),
    });
    check('POST invalid input → 400', bad.status === 400, String(bad.status));

    const taken = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dave@example.com', handle: 'alice' }),
    });
    check('POST taken handle → 409', taken.status === 409, String(taken.status));

    const spa = await fetch(`${base}/`);
    const spaText = await spa.text();
    check('SPA index.html served', spa.status === 200 && spaText.includes('id="root"'), String(spa.status));

    const missing = await fetch(`${base}/api/nope`);
    check('unknown API route → JSON 404', missing.status === 404 && (await missing.json()).error === 'not_found', String(missing.status));
  }
} catch (err) {
  console.error('SMOKE ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
} finally {
  if (server) server.kill();
  try {
    await pg.stop();
  } catch {
    /* already stopped */
  }
  fs.rmSync(path.join(ROOT, '.tmp-pgdata-smoke'), { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
