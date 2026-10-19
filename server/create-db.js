/**
 * One-shot database bootstrap: creates the target database if missing,
 * then applies db/schema.sql. Usage: npm run db:init
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const target =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const targetUrl = new URL(target);
const dbName = decodeURIComponent(targetUrl.pathname.replace(/^\//, '')) || 'hackersdigest';

// Connect to the maintenance database to CREATE DATABASE if needed.
const adminUrl = new URL(targetUrl);
adminUrl.pathname = '/postgres';

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
try {
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    // Identifier can't be a parameter; we validated it as a plain name below.
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`[db:init] created database "${dbName}"`);
  } else {
    console.log(`[db:init] database "${dbName}" already exists`);
  }
} finally {
  await admin.end().catch(() => {});
}

const db = new pg.Client({ connectionString: target, connectionTimeoutMillis: 5000 });
try {
  await db.connect();
  await db.query(schemaSql);
  console.log('[db:init] schema applied');
} finally {
  await db.end().catch(() => {});
}
