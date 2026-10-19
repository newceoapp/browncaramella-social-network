/**
 * Bootstrap an admin account you can log in to the admin dashboard with.
 *
 * Admin powers come from holding the handle ADMIN_HANDLE (default `evobugz`,
 * overridable via ADMIN_HANDLE in .env). This script:
 *
 *   1. Boots a local PostgreSQL (embedded on :5432, or the system one if
 *      port 5432 is already taken).
 *   2. Creates the `hackersdigest` database and applies db/schema.sql.
 *   3. Inserts a waitlist entry for the admin (auto-approved because its
 *      handle === ADMIN_HANDLE).
 *   4. Generates an Ed25519 keypair, seals the private key with a passphrase
 *      (PBKDF2-SHA256 250k -> AES-256-GCM — identical to src/crypto.js), and
 *      inserts the account row.
 *
 * Idempotent: re-running replaces the admin account.
 *
 * Prerequisite: none beyond `npm install` (pg + embedded-postgres are dev
 * extras already in node_modules).
 *
 * Run: node scripts/seed-admin.mjs
 *
 * Then: npm run dev   and open http://localhost:5173
 *       Log in at /login with handle @evobugz and the passphrase printed below.
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {
  createHash,
  generateKeyPairSync,
  createSecretKey,
  createCipheriv,
  pbkdf2Sync,
  randomFillSync,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ADMIN_HANDLE = process.env.ADMIN_HANDLE ?? 'evobugz';
const ADMIN_EMAIL = 'admin@hackersdigest.local';
const PASSPHRASE = 'admin-digest-2026';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hackersdigest';
const PG_PORT = 5432;
const DATA_DIR = path.join(ROOT, '.tmp-pgdata-admin');

const { Client } = pg;
const encoder = new TextEncoder();
const schemaSql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');

let fingerprint = '';

function bufToB64(buf) {
  return Buffer.from(buf).toString('base64');
}

/** Fingerprint, identical to server/auth.js fingerprintOf. */
function fingerprintOf(derBuf) {
  return createHash('sha256').update(derBuf)
    .toString('hex')
    .slice(0, 16)
    .toUpperCase()
    .match(/.{4}/g)
    .join(' ');
}

/** Seal a PKCS#8 private key with a passphrase, identical to src/crypto.js sealKeyBackup. */
function sealKeyBackup(privateKeyDer, passphrase) {
  const salt = randomFillSync(new Uint8Array(16));
  const iv = randomFillSync(new Uint8Array(12));
  const derived = pbkdf2Sync(encoder.encode(passphrase), salt, 250_000, 32, 'sha256');
  const secret = createSecretKey(derived);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const part1 = cipher.update(privateKeyDer);
  const part2 = cipher.final();
  const ct = Buffer.concat([part1, part2, cipher.getAuthTag()]);
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 250_000,
    alg: 'AES-GCM',
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ct: bufToB64(ct),
  };
}

// ---------------------------------------------------------------------------
// Boot PostgreSQL (embedded if port 5432 is free, otherwise system service).
// ---------------------------------------------------------------------------
const busy = await new Promise((resolve) => {
  const probe = net.connect(PG_PORT, '127.0.0.1');
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
  probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
});

let pgProcess = null;

if (busy) {
  console.log(`[seed-admin] port ${PG_PORT} in use — connecting to system PostgreSQL`);
} else {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  pgProcess = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
  });
  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    await pgProcess.initialise();
  }
  await pgProcess.start();
  try {
    await pgProcess.createDatabase('hackersdigest');
    console.log('[seed-admin] created database "hackersdigest"');
  } catch {
    console.log('[seed-admin] database "hackersdigest" already exists');
  }
}

// ---------------------------------------------------------------------------
// Apply schema and seed the admin account.
// ---------------------------------------------------------------------------
const target = new URL(DATABASE_URL);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'hackersdigest';

const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });
await client.connect();

try {
  await client.query(schemaSql);
  console.log('[seed-admin] schema applied');

  // Idempotent: remove any prior admin rows (accounts first due to FK RESTRICT).
  await client.query('DELETE FROM accounts WHERE handle = $1', [ADMIN_HANDLE]);
  await client.query('DELETE FROM waitlist WHERE email = $1', [ADMIN_EMAIL]);

  // Admin waitlist entry: auto-approved (handle === ADMIN_HANDLE).
  await client.query(
    `INSERT INTO waitlist (email, handle, status) VALUES ($1, $2, 'approved')`,
    [ADMIN_EMAIL, ADMIN_HANDLE]
  );
  console.log('[seed-admin] waitlist entry created (approved)');

  // Generate Ed25519 identity keypair.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  const privateDer = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }));
  fingerprint = fingerprintOf(publicDer);

  // Generate X25519 encryption keypair.
  const { publicKey: encPublic, privateKey: encPrivate } = generateKeyPairSync('x25519');
  const encPublicDer = Buffer.from(encPublic.export({ type: 'spki', format: 'der' }));
  const encPrivateDer = Buffer.from(encPrivate.export({ type: 'pkcs8', format: 'der' }));

  // v2 sealed backup: both private keys, length-prefixed PKCS#8.
  const combined = Buffer.alloc(4 + privateDer.length + 4 + encPrivateDer.length);
  let offset = 0;
  combined.writeUInt32LE(privateDer.length, offset); offset += 4;
  privateDer.copy(combined, offset); offset += privateDer.length;
  combined.writeUInt32LE(encPrivateDer.length, offset); offset += 4;
  encPrivateDer.copy(combined, offset);
  const salt = randomFillSync(new Uint8Array(16));
  const iv = randomFillSync(new Uint8Array(12));
  const derived = pbkdf2Sync(encoder.encode(PASSPHRASE), salt, 250_000, 32, 'sha256');
  const secret = createSecretKey(derived);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const part1 = cipher.update(combined);
  const part2 = cipher.final();
  const ct = Buffer.concat([part1, part2, cipher.getAuthTag()]);
  const keyBackup = {
    v: 2,
    kdf: 'PBKDF2-SHA256',
    iterations: 250_000,
    alg: 'AES-GCM',
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ct: bufToB64(ct),
  };

  await client.query(
    `INSERT INTO accounts (handle, email, public_key, encryption_key, fingerprint, key_backup)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ADMIN_HANDLE, ADMIN_EMAIL, publicDer, encPublicDer, fingerprint, JSON.stringify(keyBackup)]
  );
  console.log('[seed-admin] account created');

  const me = await client.query(
    'SELECT handle, email, fingerprint FROM accounts WHERE handle = $1',
    [ADMIN_HANDLE]
  );
  console.log('[seed-admin] admin account row:', me.rows[0]);
} finally {
  await client.end();
}

if (pgProcess) {
  console.log(`[seed-admin] embedded PostgreSQL still running at localhost:${PG_PORT}`);
  console.log('[seed-admin] press Ctrl+C to stop it and exit');
  await new Promise(() => {}); // keep process alive; EmbeddedPostgres holds the cluster open
} else {
  console.log('[seed-admin] done — seeded system PostgreSQL');
}

// ---------------------------------------------------------------------------
console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║  ADMIN ACCOUNT READY                                                ║
║                                                                     ║
║  Handle : @${ADMIN_HANDLE}${' '.repeat(Math.max(0, 30 - ADMIN_HANDLE.length))}║
║  Email  : ${ADMIN_EMAIL}${' '.repeat(Math.max(0, 30 - ADMIN_EMAIL.length))}║
║  Passphrase: ${PASSPHRASE}${' '.repeat(Math.max(0, 20 - PASSPHRASE.length))}║
║  Fingerprint: ${fingerprint}                                         ║
║                                                                     ║
║  1. npm run dev          (API :3001 + Vite :5173)                   ║
║  2. Open http://localhost:5173                                      ║
║  3. Click "Log in", enter handle @${ADMIN_HANDLE} and the passphrase above. ║
║  4. The "Admin" link appears in the nav — open /admin.              ║
║                                                                     ║
║  Unrecoverable by design: lose this passphrase and the account      ║
║  cannot be recovered (the sealed backup is useless without it).     ║
╚═══════════════════════════════════════════════════════════════════════╝
`);
