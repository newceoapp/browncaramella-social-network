/**
 * Restore a sealed kill-switch export into a fresh database.
 *
 * Reads a sealed export JSON (produced by /api/admin/export and sealed
 * client-side with the operator's passphrase), opens it locally with the
 * passphrase, and writes every table back into the target database.
 *
 * Intended for disaster recovery: the operator can rebuild the site from
 * their sealed offline export.
 *
 * Usage:
 *   node scripts/restore.mjs <sealed-export.json> <passphrase>
 *
 * Requires DATABASE_URL in the environment (or .env).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { openJSON } from '../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const [sealedPath, passphrase] = process.argv.slice(2);

if (!sealedPath || !passphrase) {
  console.error('Usage: node scripts/restore.mjs <sealed-export.json> <passphrase>');
  process.exit(1);
}

if (!fs.existsSync(sealedPath)) {
  console.error(`File not found: ${sealedPath}`);
  process.exit(1);
}

async function main() {
  // 1. Read and open the sealed export locally.
  const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8'));
  let data;
  try {
    data = await openJSON(sealed, passphrase);
  } catch (err) {
    console.error(`Failed to open sealed export: ${err.message}`);
    console.error('Wrong passphrase or corrupt file.');
    process.exit(1);
  }

  const { exportedAt, siteState, waitlist, accounts, sessions, posts } = data;
  console.log(`[restore] Export from ${exportedAt}`);
  console.log(`[restore] Tables: waitlist=${waitlist?.length ?? 0} accounts=${accounts?.length ?? 0} sessions=${sessions?.length ?? 0} posts=${posts?.length ?? 0}`);

  // 2. Connect and restore.
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 10000 });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Disable FK checks temporarily by ordering deletes/inserts carefully.
    // accounts references waitlist(email) with ON DELETE RESTRICT, and
    // sessions references accounts(id) with ON DELETE CASCADE.

    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM posts');
    await client.query('DELETE FROM accounts');
    await client.query('DELETE FROM waitlist');

    // Restore site state (kill-switch flag).
    if (siteState) {
      await client.query(
        `UPDATE site_state
         SET locked = $1, locked_at = $2, locked_by = $3
         WHERE id = 1`,
        [siteState.locked, siteState.locked_at, siteState.locked_by]
      );
    }

    // Restore waitlist first (accounts reference it via FK).
    for (const row of waitlist ?? []) {
      await client.query(
        `INSERT INTO waitlist (id, email, handle, status, decided_at, decided_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           handle = EXCLUDED.handle,
           status = EXCLUDED.status,
           decided_at = EXCLUDED.decided_at,
           decided_by = EXCLUDED.decided_by,
           created_at = EXCLUDED.created_at`,
        [row.id, row.email, row.handle, row.status, row.decided_at, row.decided_by, row.created_at]
      );
    }

    // Restore accounts.
    for (const row of accounts ?? []) {
      await client.query(
        `INSERT INTO accounts (id, handle, email, public_key, encryption_key, fingerprint, key_backup, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           handle = EXCLUDED.handle,
           email = EXCLUDED.email,
           public_key = EXCLUDED.public_key,
           encryption_key = EXCLUDED.encryption_key,
           fingerprint = EXCLUDED.fingerprint,
           key_backup = EXCLUDED.key_backup,
           created_at = EXCLUDED.created_at`,
        [
          row.id, row.handle, row.email, row.public_key,
          row.encryption_key, row.fingerprint, row.key_backup, row.created_at
        ]
      );
    }

    // Restore sessions.
    for (const row of sessions ?? []) {
      await client.query(
        `INSERT INTO sessions (token_hash, account_id, user_agent, ip_address, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (token_hash) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           user_agent = EXCLUDED.user_agent,
           ip_address = EXCLUDED.ip_address,
           created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at`,
        [
          row.token_hash, row.account_id, row.user_agent, row.ip_address,
          row.created_at, row.expires_at
        ]
      );
    }

    // Restore posts.
    for (const row of posts ?? []) {
      await client.query(
        `INSERT INTO posts (id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           author_key = EXCLUDED.author_key,
           recipient = EXCLUDED.recipient,
           ciphertext = EXCLUDED.ciphertext,
           nonce = EXCLUDED.nonce,
           ephemeral_key = EXCLUDED.ephemeral_key,
           wrapped_key = EXCLUDED.wrapped_key,
           wrap_iv = EXCLUDED.wrap_iv,
           created_at = EXCLUDED.created_at`,
        [
          row.id, row.author_key, row.recipient, row.ciphertext, row.nonce,
          row.ephemeral_key, row.wrapped_key, row.wrap_iv, row.created_at
        ]
      );
    }

    await client.query('COMMIT');
    console.log('[restore] Restore complete.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[restore] Failed: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[restore] Unexpected error: ${err.message}`);
  process.exit(1);
});
