import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

export const pool = new Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 10_000,
});

// Idle clients must never crash the process (e.g. server restarts).
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const RETRY_MS = 15_000;
let retryTimer = null;

function startRetrying() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    try {
      await pool.query(schemaSql);
      console.log('[db] connected — schema applied (retry succeeded)');
      stopRetrying();
    } catch {
      /* still down; keep quiet after the first warning */
    }
  }, RETRY_MS);
  retryTimer.unref?.();
}

function stopRetrying() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

/** Apply the schema if the database is reachable. Never throws. */
export async function initSchema() {
  try {
    await pool.query(schemaSql);
    console.log('[db] connected — schema applied');
    stopRetrying();
    return true;
  } catch (err) {
    console.warn(
      `[db] unreachable (${err.message}) — running in degraded mode, retrying every ${RETRY_MS / 1000}s`
    );
    startRetrying();
    return false;
  }
}

/** Cheap liveness probe for /api/health. */
export async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Aggregate counters for the landing page. Throws when the DB is down. */
export async function getStats() {
  const [signups, posts] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM waitlist'),
    pool.query('SELECT count(*)::int AS n FROM posts'),
  ]);
  return {
    signups: signups.rows[0].n,
    posts: posts.rows[0].n,
  };
}

/**
 * Insert a waitlist signup. New entries are 'pending' until the operator
 * approves them — except the admin handle's own signup, which is approved
 * immediately (somebody has to bootstrap the approval queue).
 * Returns { inserted, status, position } or { inserted: false, status } on
 * a duplicate email. Throws a Postgres error with code '23505' on a taken
 * handle, and any other error (typically "database is down") for the
 * caller to map.
 */
export async function addWaitlist(email, handle, adminHandle) {
  const status = handle && handle === adminHandle ? 'approved' : 'pending';
  const insert = await pool.query(
    `INSERT INTO waitlist (email, handle, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, handle, status]
  );
  if (insert.rowCount === 0) {
    const existing = await pool.query('SELECT status FROM waitlist WHERE email = $1', [email]);
    return { inserted: false, status: existing.rows[0]?.status ?? 'pending' };
  }

  const count = await pool.query('SELECT count(*)::int AS n FROM waitlist');
  return { inserted: true, status, position: count.rows[0].n };
}

// --- Site state (kill-switch) ------------------------------------------------

export async function getSiteState() {
  const r = await pool.query('SELECT locked, locked_at, locked_by FROM site_state WHERE id = 1');
  return r.rows[0] ?? { locked: false, locked_at: null, locked_by: null };
}

export async function setSiteLocked(locked, byHandle) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `UPDATE site_state
       SET locked = $1,
           locked_at = CASE WHEN $1 THEN now() ELSE NULL END,
           locked_by = CASE WHEN $1 THEN $2 ELSE NULL END
       WHERE id = 1`,
      [locked, byHandle]
    );
    await pool.query(
      `INSERT INTO admin_actions (actor_handle, action, target_handle, target_email)
       VALUES ($1, $2, NULL, NULL)`,
      [byHandle, locked ? 'lockdown' : 'unlock']
    );
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return getSiteState();
}

// --- Admin queries -----------------------------------------------------------

/** Waitlist rows for the approval queue, newest first. */
export async function listWaitlist(status, limit = 100) {
  const r = status
    ? await pool.query(
        `SELECT id, email, handle, status, decided_at, decided_by, created_at
         FROM waitlist WHERE status = $1
         ORDER BY created_at DESC LIMIT $2`,
        [status, limit]
      )
    : await pool.query(
        `SELECT id, email, handle, status, decided_at, decided_by, created_at
         FROM waitlist ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
  return r.rows;
}

/** Approve or reject one waitlist entry. Returns the row, or null if unknown. */
export async function decideWaitlistEntry(id, status, byHandle) {
  const r = await pool.query(
    `UPDATE waitlist SET status = $1, decided_at = now(), decided_by = $2
     WHERE id = $3
     RETURNING id, email, handle, status, decided_at, decided_by, created_at`,
    [status, byHandle, id]
  );
  return r.rows[0] ?? null;
}

/** Bulk approve or reject multiple waitlist entries. Returns count updated. */
export async function bulkDecideWaitlist(ids, status, byHandle) {
  if (!ids.length) return 0;
  const r = await pool.query(
    `UPDATE waitlist SET status = $1, decided_at = now(), decided_by = $2
     WHERE id = ANY($3)
     RETURNING id`,
    [status, byHandle, ids]
  );
  return r.rowCount;
}

/** Add or update notes on a waitlist entry. Returns the row, or null if unknown. */
export async function updateWaitlistNotes(id, notes, byHandle) {
  const r = await pool.query(
    `UPDATE waitlist SET notes = $2
     WHERE id = $1
     RETURNING id, email, handle, status, notes, decided_at, decided_by, created_at`,
    [id, notes]
  );
  return r.rows[0] ?? null;
}

/** Record an admin action in the audit log. */
export async function recordAdminAction(actorHandle, action, targetHandle, targetEmail) {
  await pool.query(
    `INSERT INTO admin_actions (actor_handle, action, target_handle, target_email)
     VALUES ($1, $2, $3, $4)`,
    [actorHandle, action, targetHandle, targetEmail]
  );
}

/** List admin actions, newest first, with optional limit. */
export async function getAdminActions(limit = 50) {
  const r = await pool.query(
    `SELECT id, actor_handle, action, target_handle, target_email, created_at
     FROM admin_actions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/** Dashboard counters: queue by status, accounts, live sessions, posts. */
export async function getAdminStats() {
  const [queue, accounts, sessions, posts] = await Promise.all([
    pool.query(
      `SELECT status, count(*)::int AS n FROM waitlist GROUP BY status`
    ),
    pool.query('SELECT count(*)::int AS n FROM accounts'),
    pool.query('SELECT count(*)::int AS n FROM sessions WHERE expires_at > now()'),
    pool.query('SELECT count(*)::int AS n FROM posts'),
  ]);
  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  for (const row of queue.rows) byStatus[row.status] = row.n;
  return {
    waitlist: byStatus,
    accounts: accounts.rows[0].n,
    sessions: sessions.rows[0].n,
    posts: posts.rows[0].n,
  };
}

/**
 * Full data export for the kill-switch. The server hands out plaintext
 * here because it must — but it only ever reaches the admin session, and
 * the client seals it with the admin's passphrase before it lands anywhere
 * (the server never sees that passphrase).
 */
export async function exportAll() {
  const [waitlist, accounts, sessions, posts, state] = await Promise.all([
    pool.query('SELECT * FROM waitlist ORDER BY id'),
    pool.query('SELECT * FROM accounts ORDER BY id'),
    pool.query('SELECT * FROM sessions ORDER BY created_at'),
    pool.query('SELECT * FROM posts ORDER BY id'),
    getSiteState(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    siteState: state,
    waitlist: waitlist.rows,
    accounts: accounts.rows,
    sessions: sessions.rows,
    posts: posts.rows,
  };
}

// --- Accounts, challenges, sessions -----------------------------------------

/** Invite gate: only *approved* waitlisted emails may register. */
export async function getWaitlistEntry(email) {
  const r = await pool.query(
    'SELECT id, status FROM waitlist WHERE email = $1',
    [email]
  );
  return r.rows[0] ?? null;
}

export async function createAccount({ handle, email, publicKey, encryptionKey, fingerprint, keyBackup }) {
  const r = await pool.query(
    `INSERT INTO accounts (handle, email, public_key, encryption_key, fingerprint, key_backup)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, handle, email, fingerprint, public_key, encryption_key, created_at`,
    [handle, email, publicKey, encryptionKey, fingerprint, keyBackup]
  );
  return r.rows[0];
}

export async function getAccountByHandle(handle) {
  const r = await pool.query(
    `SELECT id, handle, email, fingerprint, public_key, encryption_key, key_backup, created_at
     FROM accounts WHERE handle = $1`,
    [handle]
  );
  return r.rows[0] ?? null;
}

/** Insert a single-use challenge nonce. TTL in milliseconds. */
export async function createChallenge(handle, nonce, ttlMs) {
  await pool.query('DELETE FROM auth_challenges WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO auth_challenges (handle, nonce, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))`,
    [handle, nonce, ttlMs]
  );
}

/**
 * Atomically consume a challenge: succeeds only if it exists for this handle,
 * is unused, and has not expired. Returns true exactly once per challenge.
 */
export async function consumeChallenge(handle, nonce) {
  const r = await pool.query(
    `UPDATE auth_challenges SET used_at = now()
     WHERE handle = $1 AND nonce = $2 AND used_at IS NULL AND expires_at > now()`,
    [handle, nonce]
  );
  return r.rowCount > 0;
}

export async function createSession(tokenHash, accountId, ttlMs, userAgent, ipAddress) {
  await pool.query(
    `INSERT INTO sessions (token_hash, account_id, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'))`,
    [tokenHash, accountId, userAgent, ipAddress, ttlMs]
  );
}

/** Look up a session by token hash; prunes expired rows as a side effect. */
export async function getSessionAccount(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  const r = await pool.query(
    `SELECT a.id, a.handle, a.email, a.fingerprint, a.public_key, a.created_at
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  return r.rows[0] ?? null;
}

export async function deleteSession(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

// --- Account management ------------------------------------------------------

/** List active sessions for an account. */
export async function getAccountSessions(accountId) {
  const r = await pool.query(
    `SELECT token_hash, created_at, expires_at, user_agent, ip_address
     FROM sessions
     WHERE account_id = $1 AND expires_at > now()
     ORDER BY created_at DESC`,
    [accountId]
  );
  return r.rows;
}

/** Revoke a session belonging to an account. Returns true if removed. */
export async function revokeSession(tokenHashHex, accountId) {
  const tokenHashBytes = Buffer.from(tokenHashHex, 'hex');
  const r = await pool.query(
    `DELETE FROM sessions WHERE token_hash = $1 AND account_id = $2`,
    [tokenHashBytes, accountId]
  );
  return r.rowCount > 0;
}

/** Update an account's sealed key backup (passphrase change). */
export async function updateAccountKeyBackup(handle, keyBackup) {
  const r = await pool.query(
    `UPDATE accounts SET key_backup = $2 WHERE handle = $1
     RETURNING id, handle, key_backup`,
    [handle, keyBackup]
  );
  return r.rows[0] ?? null;
}

/** Rotate an account's signing + encryption keys and re-seal the backup. */
export async function rotateAccountKeys({ handle, publicKey, encryptionKey, fingerprint, keyBackup }) {
  const r = await pool.query(
    `UPDATE accounts
     SET public_key = $2,
         encryption_key = $3,
         fingerprint = $4,
         key_backup = $5
     WHERE handle = $1
     RETURNING id, handle, email, fingerprint, public_key, encryption_key, key_backup, created_at`,
    [handle, publicKey, encryptionKey, fingerprint, keyBackup]
  );
  return r.rows[0] ?? null;
}

/** Gather a single account's data for self-export. */
export async function getAccountExportData(handle) {
  const [account, sessions, posts, waitlist] = await Promise.all([
    pool.query(
      `SELECT id, handle, email, fingerprint, public_key, encryption_key, created_at
       FROM accounts WHERE handle = $1`,
      [handle]
    ),
    pool.query(
      `SELECT token_hash, created_at, expires_at, user_agent, ip_address
       FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE handle = $1) AND expires_at > now()`,
      [handle]
    ),
    pool.query(
      `SELECT id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv, created_at
       FROM posts WHERE author_key = (SELECT fingerprint FROM accounts WHERE handle = $1)
          OR recipient = (SELECT fingerprint FROM accounts WHERE handle = $1)
       ORDER BY created_at DESC`,
      [handle]
    ),
    pool.query(
      `SELECT id, email, handle, status, created_at FROM waitlist WHERE email = (SELECT email FROM accounts WHERE handle = $1)`,
      [handle]
    ),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: account.rows[0],
    sessions: sessions.rows,
    posts: posts.rows,
    waitlist: waitlist.rows,
  };
}

/** Delete an account and all its sessions/challenges. Returns true if removed. */
export async function deleteAccount(accountId) {
  const r = await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
  return r.rowCount > 0;
}

// --- Posts (encrypted feed) --------------------------------------------------

/** Resolve an account by its public-key fingerprint. */
export async function getAccountByFingerprint(fingerprint) {
  const r = await pool.query(
    `SELECT id, handle, email, fingerprint, public_key, encryption_key, created_at
     FROM accounts WHERE fingerprint = $1`,
    [fingerprint]
  );
  return r.rows[0] ?? null;
}

/** Store a sealed post. Returns the inserted row. */
export async function createPost({ authorKey, recipient, ciphertext, nonce, ephemeralKey, wrappedKey, wrapIv }) {
  const r = await pool.query(
    `INSERT INTO posts (author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv, created_at`,
    [authorKey, recipient, ciphertext, nonce, ephemeralKey, wrappedKey, wrapIv]
  );
  return r.rows[0];
}

/** Feed for an account: posts addressed to it or authored by it, newest first.
 *  `before` is a UUID cursor for pagination (exclusive).
 *  When `contactsOnly` is true, only posts exchanged with accepted contacts
 *  are included (plus none of the account's own posts to non-contacts).
 */
export async function getFeed(accountFingerprint, { before, limit = 50, contactsOnly = false }) {
  let query;
  const params = [accountFingerprint];

  if (contactsOnly) {
    query = `
      SELECT id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv, created_at
      FROM posts
      WHERE (
        (author_key = $1 AND recipient IN (
          SELECT a.fingerprint FROM contacts c
          JOIN accounts a ON a.id = c.target_id
          WHERE c.requester_id = (SELECT id FROM accounts WHERE fingerprint = $1) AND c.status = 'accepted'
        ))
        OR (recipient = $1 AND author_key IN (
          SELECT a.fingerprint FROM contacts c
          JOIN accounts a ON a.id = c.requester_id
          WHERE c.target_id = (SELECT id FROM accounts WHERE fingerprint = $1) AND c.status = 'accepted'
        ))
      )
    `;
  } else {
    query = `
      SELECT id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, wrap_iv, created_at
      FROM posts
      WHERE recipient = $1 OR author_key = $1
    `;
  }

  if (before) {
    query += ` AND created_at < (SELECT created_at FROM posts WHERE id = $${params.length + 1})`;
    params.push(before);
  }
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const r = await pool.query(query, params);
  return r.rows;
}

/** Fetch a single post by id. */
export async function getPost(id) {
  const r = await pool.query(
    `SELECT id, author_key, recipient, ciphertext, nonce, ephemeral_key, wrapped_key, created_at
     FROM posts WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

/** Delete a post — only its author may do so. Returns true if a row was removed. */
export async function deletePost(id, authorKey) {
  const r = await pool.query(
    `DELETE FROM posts WHERE id = $1 AND author_key = $2`,
    [id, authorKey]
  );
  return r.rowCount > 0;
}

/** Attach an X25519 encryption key to an account (key rotation / first setup). */
export async function setAccountEncryptionKey(handle, encryptionKey) {
  const r = await pool.query(
    `UPDATE accounts SET encryption_key = $2 WHERE handle = $1
     RETURNING id, handle, encryption_key`,
    [handle, encryptionKey]
  );
  return r.rows[0] ?? null;
}

// --- Contacts (social graph) -------------------------------------------------

/** Send a contact request. Returns the inserted row, or null if it already exists. */
export async function createContact(requesterId, targetId) {
  const r = await pool.query(
    `INSERT INTO contacts (requester_id, target_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (requester_id, target_id) DO NOTHING
     RETURNING requester_id, target_id, status, created_at`,
    [requesterId, targetId]
  );
  return r.rows[0] ?? null;
}

/** List contacts for an account, optionally filtered by status.
 *  Returns contacts in both directions (outgoing and incoming). */
export async function getContacts(accountId, status) {
  let query = `
    SELECT c.requester_id || ':' || c.target_id AS id, c.status, c.created_at,
           CASE WHEN c.requester_id = $1 THEN c.target_id ELSE c.requester_id END AS other_id,
           CASE WHEN c.requester_id = $1 THEN a2.handle ELSE a1.handle END AS other_handle,
           CASE WHEN c.requester_id = $1 THEN a2.fingerprint ELSE a1.fingerprint END AS other_fingerprint,
           CASE WHEN c.requester_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
    FROM contacts c
    JOIN accounts a1 ON a1.id = c.requester_id
    JOIN accounts a2 ON a2.id = c.target_id
    WHERE (c.requester_id = $1 OR c.target_id = $1)
  `;
  const params = [accountId];
  if (status) {
    query += ` AND c.status = $2`;
    params.push(status);
  }
  query += ` ORDER BY c.created_at DESC`;
  const r = await pool.query(query, params);
  return r.rows;
}

/** List pending contact requests received by an account. */
export async function getPendingContactRequests(accountId) {
  const r = await pool.query(
    `SELECT c.requester_id || ':' || c.target_id AS id, c.requester_id, c.target_id, c.status, c.created_at,
           a.handle AS requester_handle, a.fingerprint AS requester_fingerprint
     FROM contacts c
     JOIN accounts a ON a.id = c.requester_id
     WHERE c.target_id = $1 AND c.status = 'pending'
     ORDER BY c.created_at DESC`,
    [accountId]
  );
  return r.rows;
}

/** Accept a pending contact request. Returns true if updated. */
export async function acceptContact(requesterId, targetId) {
  const r = await pool.query(
    `UPDATE contacts SET status = 'accepted'
     WHERE requester_id = $1 AND target_id = $2 AND status = 'pending'
     RETURNING requester_id`,
    [requesterId, targetId]
  );
  return r.rowCount > 0;
}

/** Block a contact (accepted or pending). Returns true if updated. */
export async function blockContact(requesterId, targetId) {
  const r = await pool.query(
    `UPDATE contacts SET status = 'blocked'
     WHERE requester_id = $1 AND target_id = $2
     RETURNING requester_id`,
    [requesterId, targetId]
  );
  return r.rowCount > 0;
}

/** Get accepted contact fingerprints for an account. */
export async function getAcceptedContactFingerprints(accountId) {
  const r = await pool.query(
    `SELECT a.fingerprint
     FROM contacts c
     JOIN accounts a ON a.id = c.target_id
     WHERE c.requester_id = $1 AND c.status = 'accepted'
     UNION
     SELECT a.fingerprint
     FROM contacts c
     JOIN accounts a ON a.id = c.requester_id
     WHERE c.target_id = $1 AND c.status = 'accepted'`,
    [accountId]
  );
  return r.rows.map((row) => row.fingerprint);
}

/** Check if a contact relationship exists between two accounts. */
export async function getContactStatus(requesterId, targetId) {
  const r = await pool.query(
    `SELECT status FROM contacts WHERE requester_id = $1 AND target_id = $2`,
    [requesterId, targetId]
  );
  return r.rows[0] ?? null;
}
