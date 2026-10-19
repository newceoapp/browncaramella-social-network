/**
 * Boots a local embedded PostgreSQL for development on the default
 * DATABASE_URL (localhost:5432/hackersdigest), applies the schema, and keeps
 * running until interrupted. Data persists in .tmp-pgdata between runs.
 *
 * Prerequisite: npm install --no-save embedded-postgres
 * Run: node scripts/dev-db.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.tmp-pgdata');

// If something already occupies 5432 (e.g. the system-wide
// postgresql-x64-18 service), there is nothing to do here.
const busy = await new Promise((resolve) => {
  const probe = net.connect(5432, '127.0.0.1');
  probe.once('connect', () => {
    probe.destroy();
    resolve(true);
  });
  probe.once('error', () => resolve(false));
});
if (busy) {
  console.log('[dev-db] port 5432 already in use — a PostgreSQL is running (system service?). Nothing to do.');
  process.exit(0);
}

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: 5432,
  persistent: true,
});

// initialise() runs initdb — only valid on a fresh data directory.
if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
  await pg.initialise();
}
await pg.start();

try {
  await pg.createDatabase('hackersdigest');
  console.log('[dev-db] created database "hackersdigest"');
} catch {
  console.log('[dev-db] database "hackersdigest" already exists');
}

const { initSchema } = await import('../server/db.js');
await initSchema();

console.log('[dev-db] PostgreSQL ready at localhost:5432 (user postgres)');
console.log('[dev-db] press Ctrl+C to stop');

const shutdown = async () => {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await new Promise(() => {});
