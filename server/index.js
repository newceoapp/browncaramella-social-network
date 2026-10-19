import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  initSchema,
  getStats,
  addWaitlist,
  ping,
  getWaitlistEntry,
  createAccount,
  getAccountByHandle,
  createChallenge,
  consumeChallenge,
  createSession,
  getSessionAccount,
  deleteSession,
  getSiteState,
  setSiteLocked,
  listWaitlist,
  decideWaitlistEntry,
  getAdminStats,
  exportAll,
  getAccountByFingerprint,
  createPost,
  getFeed,
  getPost,
  deletePost,
  setAccountEncryptionKey,
  getAccountSessions,
  revokeSession,
  updateAccountKeyBackup,
  rotateAccountKeys,
  getAccountExportData,
  deleteAccount,
  createContact,
  getContacts,
  getPendingContactRequests,
  acceptContact,
  blockContact,
  getAcceptedContactFingerprints,
  getContactStatus,
  bulkDecideWaitlist,
  updateWaitlistNotes,
  recordAdminAction,
  getAdminActions,
  pool,
} from './db.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  CHALLENGE_TTL_MS,
  ADMIN_HANDLE,
  AUTH_PREFIX,
  isAdminHandle,
  registerMessage,
  loginMessage,
  sha256,
  fingerprintOf,
  verifyEd25519,
  newSessionToken,
  parseCookies,
  sessionCookie,
  CLEAR_COOKIE,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// --- Structured request logging -------------------------------------------
// One JSON line per request. Never logs secrets (passphrases, private keys,
// sealed backups, signatures).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const entry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    };
    console.log(JSON.stringify(entry));
  });
  next();
});

// --- In-memory rate limiter ------------------------------------------------
// Fixed window per IP + route. Protects auth and signup endpoints from brute
// force and spam. Windows reset on restart (acceptable for the free tier).
// Configure with RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const rateLimitMap = new Map();

function rateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return {
      allowed: true,
      remaining: Math.max(0, RATE_LIMIT_MAX - 1),
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS };
  }
  entry.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS,
  };
}

// Purge expired windows.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of rateLimitMap.entries()) {
    if (now - e.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

function rateLimitMiddleware(keyFn) {
  return (req, res, next) => {
    const key = keyFn(req);
    const result = rateLimit(key);
    res.setHeader('RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', Math.ceil(result.resetAt / 1000));
    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
      return res.status(429).json({
        error: 'rate_limited',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }
    next();
  };
}

const rateLimitByIp = (req) => `ip:${req.ip}`;

// --- API -------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    db: (await ping()) ? 'up' : 'down',
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/stats', async (_req, res) => {
  try {
    const [stats, site] = await Promise.all([getStats(), getSiteState()]);
    res.json({ db: 'up', locked: site.locked, ...stats });
  } catch {
    res.json({ db: 'down', locked: null, signups: null, posts: null });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_RE = /^[a-z0-9_]{3,24}$/i;

app.post('/api/waitlist', rateLimitMiddleware(rateLimitByIp), async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const handle = String(req.body?.handle ?? '')
    .trim()
    .replace(/^@/, '');

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (handle && !HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }

  try {
    const site = await getSiteState();
    if (site.locked) {
      return res.status(503).json({ error: 'site_locked' });
    }

    const result = await addWaitlist(email, handle || null, ADMIN_HANDLE);
    if (!result.inserted) {
      return res.status(409).json({
        error: 'already_registered',
        status: result.status,
      });
    }
    return res.status(201).json({ position: result.position, status: result.status });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'handle_taken' });
    }
    console.error('[api] waitlist insert failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

// --- Auth: keypair challenge-response (no passwords on the server) ----------

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function accountShape(row) {
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    fingerprint: row.fingerprint,
    publicKey: Buffer.from(row.public_key).toString('base64'),
    encryptionKey: row.encryption_key ? Buffer.from(row.encryption_key).toString('base64') : null,
    createdAt: row.created_at,
    isAdmin: isAdminHandle(row.handle),
  };
}

async function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  if (!token) return null;
  return getSessionAccount(sha256(Buffer.from(token, 'utf8')));
}

/** DB rows are snake_case; every API response speaks camelCase. */
function siteShape(site) {
  return {
    locked: site.locked,
    lockedAt: site.locked_at,
    lockedBy: site.locked_by,
  };
}

app.post('/api/auth/register', rateLimitMiddleware(rateLimitByIp), async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const handle = String(req.body?.handle ?? '')
    .trim()
    .replace(/^@/, '');
  const publicKey = String(req.body?.publicKey ?? '');
  const encryptionPublicKey = String(req.body?.encryptionPublicKey ?? '');
  const proof = String(req.body?.proof ?? '');
  const keyBackup = req.body?.keyBackup;

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }
  if (!publicKey || publicKey.length > 128 || !BASE64_RE.test(publicKey)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  if (!encryptionPublicKey || encryptionPublicKey.length > 128 || !BASE64_RE.test(encryptionPublicKey)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  if (!proof || proof.length > 128 || !BASE64_RE.test(proof)) {
    return res.status(400).json({ error: 'invalid_proof' });
  }
  if (
    !keyBackup ||
    typeof keyBackup !== 'object' ||
    typeof keyBackup.salt !== 'string' ||
    typeof keyBackup.iv !== 'string' ||
    typeof keyBackup.ct !== 'string'
  ) {
    return res.status(400).json({ error: 'invalid_backup' });
  }

  try {
    // Lockdown: no new identities while the kill-switch is engaged.
    const site = await getSiteState();
    if (site.locked) {
      return res.status(503).json({ error: 'site_locked' });
    }

    // Invite gate: the email must be on the waitlist AND approved by the
    // operator. Pending entries are told to sit tight; unknown ones are
    // told to join the queue.
    const entry = await getWaitlistEntry(email);
    if (!entry) {
      return res.status(403).json({ error: 'not_invited' });
    }
    if (entry.status !== 'approved') {
      return res.status(403).json({ error: 'not_approved' });
    }

    // Proof of possession: the client must have signed the registration
    // statement with the private half of the key it is registering.
    const der = Buffer.from(publicKey, 'base64');
    const proofOk = verifyEd25519(
      der,
      registerMessage(email, handle),
      Buffer.from(proof, 'base64')
    );
    if (!proofOk) {
      return res.status(400).json({ error: 'invalid_proof' });
    }

    const account = await createAccount({
      handle,
      email,
      publicKey: der,
      encryptionKey: Buffer.from(encryptionPublicKey, 'base64'),
      fingerprint: fingerprintOf(der),
      keyBackup,
    });

    const { token, tokenHash } = newSessionToken();
    await createSession(tokenHash, account.id, SESSION_TTL_MS, req.headers['user-agent'] ?? null, req.ip ?? null);

    return res
      .status(201)
      .set('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000, req.secure))
      .json({ account: accountShape(account) });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({
        error: err.constraint === 'accounts_handle_key' ? 'handle_taken' : 'account_exists',
      });
    }
    console.error('[api] register failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/auth/challenge', rateLimitMiddleware(rateLimitByIp), async (req, res) => {
  const handle = String(req.body?.handle ?? '')
    .trim()
    .replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }

  try {
    // Lockdown: only the admin may still authenticate (to release the lock).
    const site = await getSiteState();
    if (site.locked && !isAdminHandle(handle)) {
      return res.status(503).json({ error: 'site_locked' });
    }

    const account = await getAccountByHandle(handle);
    if (!account) {
      return res.status(404).json({ error: 'unknown_handle' });
    }
    const nonce = randomBytes(32);
    await createChallenge(handle, nonce, CHALLENGE_TTL_MS);
    // key_backup travels back encrypted — it is ciphertext the server cannot open.
    return res.json({ nonce: nonce.toString('base64'), keyBackup: account.key_backup });
  } catch (err) {
    console.error('[api] challenge failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/auth/login', rateLimitMiddleware(rateLimitByIp), async (req, res) => {
  const handle = String(req.body?.handle ?? '')
    .trim()
    .replace(/^@/, '');
  const nonceB64 = String(req.body?.nonce ?? '');
  const signatureB64 = String(req.body?.signature ?? '');

  if (!HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }
  const nonce = Buffer.from(nonceB64, 'base64');
  if (nonce.length !== 32) {
    return res.status(400).json({ error: 'invalid_challenge' });
  }
  if (!signatureB64 || signatureB64.length > 128 || !BASE64_RE.test(signatureB64)) {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    // Mirrors the challenge gate: during lockdown nobody logs in but the
    // operator. (Checked again after the signature verifies.)
    const site = await getSiteState();
    if (site.locked && !isAdminHandle(handle)) {
      return res.status(503).json({ error: 'site_locked' });
    }

    const account = await getAccountByHandle(handle);
    if (!account) {
      return res.status(404).json({ error: 'unknown_handle' });
    }

    const signature = Buffer.from(signatureB64, 'base64');
    const signatureOk =
      signature.length === 64 &&
      verifyEd25519(account.public_key, loginMessage(nonce), signature);
    if (!signatureOk) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    // Single use, short TTL — replaying a captured exchange does not work.
    if (!(await consumeChallenge(handle, nonce))) {
      return res.status(401).json({ error: 'challenge_expired' });
    }

    const { token, tokenHash } = newSessionToken();
    await createSession(tokenHash, account.id, SESSION_TTL_MS, req.headers['user-agent'] ?? null, req.ip ?? null);

    return res
      .set('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000, req.secure))
      .json({ account: accountShape(account) });
  } catch (err) {
    console.error('[api] login failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const account = await sessionFromRequest(req);
    // Anonymous is a normal state, not an error: 200 with a null account,
    // so logged-out page loads don't spam browser consoles with 401s.
    return res.json({ account: account ? accountShape(account) : null });
  } catch (err) {
    console.error('[api] me failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  try {
    if (token) await deleteSession(sha256(Buffer.from(token, 'utf8')));
  } catch (err) {
    console.error('[api] logout failed:', err.message);
  }
  return res.set('Set-Cookie', CLEAR_COOKIE).json({ ok: true });
});

// --- Posts: encrypted feed ---------------------------------------------------
//
// Every post is sealed client-side. The server stores ciphertext, an AES-GCM
// nonce, the sender's ephemeral X25519 public key, and the content key wrapped
// to the recipient — never plaintext content, never any passphrase.

const FINGERPRINT_RE = /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/;

async function requireSession(req, res, next) {
  const account = await sessionFromRequest(req);
  if (!account) return res.status(401).json({ error: 'session_required' });
  req.account = account;
  return next();
}

function postShape(row, accountFingerprint) {
  return {
    id: row.id,
    author: row.author_key,
    recipient: row.recipient,
    ciphertext: Buffer.from(row.ciphertext).toString('base64'),
    nonce: Buffer.from(row.nonce).toString('base64'),
    ephemeralKey: row.ephemeral_key ? Buffer.from(row.ephemeral_key).toString('base64') : null,
    wrappedKey: row.wrapped_key ? Buffer.from(row.wrapped_key).toString('base64') : null,
    wrapIv: row.wrap_iv ? Buffer.from(row.wrap_iv).toString('base64') : null,
    createdAt: row.created_at,
    mine: row.author_key === accountFingerprint,
    forMe: row.recipient === accountFingerprint,
  };
}

app.post('/api/posts', requireSession, async (req, res) => {
  const { recipient, ciphertext, nonce, ephemeral, wrapped_key, wrap_iv } = req.body ?? {};

  if (!recipient || !FINGERPRINT_RE.test(recipient)) {
    return res.status(400).json({ error: 'invalid_recipient' });
  }
  if (!ciphertext || !BASE64_RE.test(ciphertext)) {
    return res.status(400).json({ error: 'invalid_ciphertext' });
  }
  if (!nonce || !BASE64_RE.test(nonce)) {
    return res.status(400).json({ error: 'invalid_nonce' });
  }
  const nonceBytes = Buffer.from(nonce, 'base64');
  if (nonceBytes.length !== 12) {
    return res.status(400).json({ error: 'invalid_nonce' });
  }
  if (!ephemeral || !BASE64_RE.test(ephemeral)) {
    return res.status(400).json({ error: 'invalid_ephemeral' });
  }
  if (!wrapped_key || !BASE64_RE.test(wrapped_key)) {
    return res.status(400).json({ error: 'invalid_wrapped_key' });
  }
  if (!wrap_iv || !BASE64_RE.test(wrap_iv)) {
    return res.status(400).json({ error: 'invalid_wrap_iv' });
  }

  try {
    const site = await getSiteState();
    if (site.locked && !isAdminHandle(req.account.handle)) {
      return res.status(503).json({ error: 'site_locked' });
    }

    // Recipient must exist (so posts aren't addressed to the void).
    const target = await getAccountByFingerprint(recipient);
    if (!target) {
      return res.status(400).json({ error: 'unknown_recipient' });
    }

    // Blocked contacts cannot send posts to each other.
    const blockStatus =
      (await getContactStatus(req.account.id, target.id)) ??
      (await getContactStatus(target.id, req.account.id));
    if (blockStatus && blockStatus.status === 'blocked') {
      return res.status(403).json({ error: 'contact_blocked' });
    }

    const post = await createPost({
      authorKey: req.account.fingerprint,
      recipient,
      ciphertext: Buffer.from(ciphertext, 'base64'),
      nonce: nonceBytes,
      ephemeralKey: Buffer.from(ephemeral, 'base64'),
      wrappedKey: Buffer.from(wrapped_key, 'base64'),
      wrapIv: wrap_iv ? Buffer.from(wrap_iv, 'base64') : null,
    });

    return res.status(201).json({ id: post.id });
  } catch (err) {
    console.error('[api] create post failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/feed', requireSession, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const before = String(req.query.before ?? '');
  const contactsOnly = req.query.contacts_only === 'true';
  try {
    const posts = await getFeed(req.account.fingerprint, {
      before: before || undefined,
      limit,
      contactsOnly,
    });
    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;
    res.json({
      posts: posts.map((p) => postShape(p, req.account.fingerprint)),
      nextCursor,
    });
  } catch (err) {
    console.error('[api] feed failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/posts/:id', requireSession, async (req, res) => {
  const id = String(req.params.id);
  try {
    const post = await getPost(id);
    if (!post) return res.status(404).json({ error: 'post_not_found' });
    if (post.author_key !== req.account.fingerprint && post.recipient !== req.account.fingerprint) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json(postShape(post, req.account.fingerprint));
  } catch (err) {
    console.error('[api] get post failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.delete('/api/posts/:id', requireSession, async (req, res) => {
  const id = String(req.params.id);
  try {
    const removed = await deletePost(id, req.account.fingerprint);
    if (!removed) return res.status(404).json({ error: 'post_not_found' });
    return res.status(204).end();
  } catch (err) {
    console.error('[api] delete post failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

/** Resolve a handle to its public-key fingerprint for addressing. Public. */
app.get('/api/accounts/:handle/fingerprint', async (req, res) => {
  const handle = String(req.params.handle ?? '').trim().replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }
  try {
    const account = await getAccountByHandle(handle);
    if (!account) return res.status(404).json({ error: 'unknown_handle' });
    return res.json({
      handle: account.handle,
      fingerprint: account.fingerprint,
      encryptionKey: account.encryption_key ? Buffer.from(account.encryption_key).toString('base64') : null,
    });
  } catch (err) {
    console.error('[api] account fingerprint failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

// --- Account management ------------------------------------------------------
//
// Every route here requires a valid session. The server never sees a
// passphrase — key backups are re-sealed client-side.

const ROTATE_MESSAGE_PREFIX = `${AUTH_PREFIX}rotate:`;

app.post('/api/account/passphrase', requireSession, async (req, res) => {
  const { keyBackup } = req.body ?? {};

  if (
    !keyBackup ||
    typeof keyBackup !== 'object' ||
    typeof keyBackup.salt !== 'string' ||
    typeof keyBackup.iv !== 'string' ||
    typeof keyBackup.ct !== 'string'
  ) {
    return res.status(400).json({ error: 'invalid_backup' });
  }

  try {
    await updateAccountKeyBackup(req.account.handle, keyBackup);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api] passphrase change failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/account/rotate-key', requireSession, async (req, res) => {
  const { publicKey, encryptionPublicKey, keyBackup, proof } = req.body ?? {};

  if (!publicKey || publicKey.length > 128 || !BASE64_RE.test(publicKey)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  if (!encryptionPublicKey || encryptionPublicKey.length > 128 || !BASE64_RE.test(encryptionPublicKey)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  if (
    !keyBackup ||
    typeof keyBackup !== 'object' ||
    typeof keyBackup.salt !== 'string' ||
    typeof keyBackup.iv !== 'string' ||
    typeof keyBackup.ct !== 'string'
  ) {
    return res.status(400).json({ error: 'invalid_backup' });
  }
  if (!proof || proof.length > 128 || !BASE64_RE.test(proof)) {
    return res.status(400).json({ error: 'invalid_proof' });
  }

  try {
    // Proof of possession: sign the rotation statement with the new key.
    const der = Buffer.from(publicKey, 'base64');
    const proofOk = verifyEd25519(
      der,
      Buffer.from(`${ROTATE_MESSAGE_PREFIX}${req.account.handle}`, 'utf8'),
      Buffer.from(proof, 'base64')
    );
    if (!proofOk) {
      return res.status(400).json({ error: 'invalid_proof' });
    }

    const account = await rotateAccountKeys({
      handle: req.account.handle,
      publicKey: der,
      encryptionKey: Buffer.from(encryptionPublicKey, 'base64'),
      fingerprint: fingerprintOf(der),
      keyBackup,
    });
    if (!account) {
      return res.status(404).json({ error: 'account_not_found' });
    }

    return res.json({
      account: accountShape(account),
    });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({
        error: err.constraint === 'accounts_handle_key' ? 'handle_taken' : 'account_exists',
      });
    }
    console.error('[api] rotate-key failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/account/export', requireSession, async (req, res) => {
  try {
    const data = await getAccountExportData(req.account.handle);
    res.json(data);
  } catch (err) {
    console.error('[api] account export failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/account/sessions', requireSession, async (req, res) => {
  const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  const currentHash = token ? sha256(Buffer.from(token, 'utf8')) : null;
  try {
    const rows = await getAccountSessions(req.account.id);
    res.json({
      sessions: rows.map((r) => {
        const hashBuf = Buffer.from(r.token_hash);
        return {
          tokenHash: hashBuf.toString('hex'),
          tokenHashShort: hashBuf.toString('hex').slice(0, 16),
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          userAgent: r.user_agent ?? '—',
          ipAddress: r.ip_address ?? '—',
          current: currentHash ? hashBuf.equals(currentHash) : false,
        };
      }),
    });
  } catch (err) {
    console.error('[api] account sessions failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.delete('/api/account/sessions/:tokenHash', requireSession, async (req, res) => {
  const tokenHashHex = String(req.params.tokenHash);
  try {
    const revoked = await revokeSession(tokenHashHex, req.account.id);
    if (!revoked) return res.status(404).json({ error: 'session_not_found' });
    return res.status(204).end();
  } catch (err) {
    console.error('[api] revoke session failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.delete('/api/account', requireSession, async (req, res) => {
  const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
  try {
    const removed = await deleteAccount(req.account.id);
    if (!removed) return res.status(404).json({ error: 'account_not_found' });
    return res.set('Set-Cookie', CLEAR_COOKIE).json({ ok: true });
  } catch (err) {
    console.error('[api] delete account failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

// --- Contacts (social graph) -------------------------------------------------
//
// Every route here requires a valid session. Contacts are mutual: both
// parties must accept before the relationship is "accepted". Blocked
// contacts cannot send posts to each other.

const HANDLE_OR_SELF_ERROR = 'invalid_handle';

app.get('/api/directory', requireSession, async (req, res) => {
  const q = String(req.query.q ?? '').trim().replace(/^@/, '');
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 50);

  if (!q) {
    return res.status(400).json({ error: 'invalid_query' });
  }

  try {
    const r = await pool.query(
      `SELECT handle, fingerprint
       FROM accounts
       WHERE handle ILIKE $1
         AND fingerprint <> $2
       ORDER BY handle
       LIMIT $3`,
      [`${q}%`, req.account.fingerprint, limit]
    );
    res.json({
      results: r.rows.map((row) => ({
        handle: row.handle,
        fingerprint: row.fingerprint,
      })),
    });
  } catch (err) {
    console.error('[api] directory failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/contacts', requireSession, async (req, res) => {
  const status = String(req.query.status ?? '');
  if (status && !['pending', 'accepted', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  try {
    const rows = await getContacts(req.account.id, status || undefined);
    res.json({
      contacts: rows.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        direction: r.direction,
        other: {
          handle: r.other_handle,
          fingerprint: r.other_fingerprint,
        },
      })),
    });
  } catch (err) {
    console.error('[api] contacts failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/contacts/requests', requireSession, async (req, res) => {
  try {
    const rows = await getPendingContactRequests(req.account.id);
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        requester: {
          handle: r.requester_handle,
          fingerprint: r.requester_fingerprint,
        },
      })),
    });
  } catch (err) {
    console.error('[api] contact requests failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/contacts', requireSession, async (req, res) => {
  const { target_handle } = req.body ?? {};

  if (!target_handle || typeof target_handle !== 'string') {
    return res.status(400).json({ error: 'invalid_handle' });
  }

  const cleanHandle = target_handle.trim().replace(/^@/, '');
  if (!HANDLE_RE.test(cleanHandle)) {
    return res.status(400).json({ error: 'invalid_handle' });
  }
  if (cleanHandle === req.account.handle) {
    return res.status(400).json({ error: 'cannot_contact_self' });
  }

  try {
    const target = await getAccountByHandle(cleanHandle);
    if (!target) {
      return res.status(404).json({ error: 'unknown_handle' });
    }

    // Check if a relationship already exists (either direction).
    const existing =
      (await getContactStatus(req.account.id, target.id)) ??
      (await getContactStatus(target.id, req.account.id));
    if (existing) {
      return res.status(409).json({ error: 'contact_exists', status: existing.status });
    }

    const contact = await createContact(req.account.id, target.id);
    if (!contact) {
      return res.status(409).json({ error: 'contact_exists', status: 'pending' });
    }

    return res.status(201).json({
      contact: {
        id: `${contact.requester_id}:${contact.target_id}`,
        status: contact.status,
        createdAt: contact.created_at,
        target: {
          handle: target.handle,
          fingerprint: target.fingerprint,
        },
      },
    });
  } catch (err) {
    console.error('[api] create contact failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/contacts/:id/accept', requireSession, async (req, res) => {
  const [requesterIdStr, targetIdStr] = String(req.params.id).split(':');
  const requesterId = Number(requesterIdStr);
  const targetId = Number(targetIdStr);
  if (!Number.isInteger(requesterId) || !Number.isInteger(targetId) || requesterId < 1 || targetId < 1) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const requests = await getPendingContactRequests(targetId);
    const request = requests.find((r) => Number(r.requester_id) === requesterId);
    if (!request) {
      return res.status(404).json({ error: 'request_not_found' });
    }

    const accepted = await acceptContact(requesterId, targetId);
    if (!accepted) {
      return res.status(404).json({ error: 'request_not_found' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[api] accept contact failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/contacts/:id/block', requireSession, async (req, res) => {
  const [requesterIdStr, targetIdStr] = String(req.params.id).split(':');
  const requesterId = Number(requesterIdStr);
  const targetId = Number(targetIdStr);
  if (!Number.isInteger(requesterId) || !Number.isInteger(targetId) || requesterId < 1 || targetId < 1) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    // Determine direction: if session account is the requester, block outgoing.
    // If session account is the target, block incoming.
    let blocked = false;
    const sessionAccountId = Number(req.account.id);
    if (targetId === sessionAccountId) {
      // Incoming request or contact: block as (requesterId, targetId=session account)
      blocked = await blockContact(requesterId, targetId);
    } else if (requesterId === sessionAccountId) {
      // Outgoing contact: block as (session account, targetId)
      blocked = await blockContact(requesterId, targetId);
    }

    if (!blocked) {
      return res.status(404).json({ error: 'contact_not_found' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[api] block contact failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

// --- Admin: single-operator dashboard (handle evobugz) ----------------------
//
// Every route here is gated by requireAdmin: a valid session whose handle
// is ADMIN_HANDLE. There is no other way in — no role flags, no elevation.

async function requireAdmin(req, res, next) {
  try {
    const account = await sessionFromRequest(req);
    if (!account) return res.status(401).json({ error: 'unauthenticated' });
    if (!isAdminHandle(account.handle)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.admin = account;
    return next();
  } catch (err) {
    console.error('[api] admin auth failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
}

app.get('/api/admin/overview', requireAdmin, async (_req, res) => {
  try {
    const [stats, site] = await Promise.all([getAdminStats(), getSiteState()]);
    res.json({ stats, site: siteShape(site) });
  } catch (err) {
    console.error('[api] admin overview failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/admin/waitlist', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status ?? 'pending');
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    const rows = await listWaitlist(status);
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        email: r.email,
        handle: r.handle,
        status: r.status,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        decidedBy: r.decided_by,
      })),
    });
  } catch (err) {
    console.error('[api] admin waitlist failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

/** Approve or reject one queued signup. */
function decideRoute(status) {
  return async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const row = await decideWaitlistEntry(id, status, req.admin.handle);
      if (!row) return res.status(404).json({ error: 'unknown_entry' });
      await recordAdminAction(req.admin.handle, status, row.handle, row.email);
      return res.json({
        entry: {
          id: row.id,
          email: row.email,
          handle: row.handle,
          status: row.status,
          decidedAt: row.decided_at,
          decidedBy: row.decided_by,
        },
      });
    } catch (err) {
      console.error(`[api] admin decide(${status}) failed:`, err.message);
      return res.status(503).json({ error: 'storage_unavailable' });
    }
  };
}

app.post('/api/admin/waitlist/:id/approve', requireAdmin, decideRoute('approved'));
app.post('/api/admin/waitlist/:id/reject', requireAdmin, decideRoute('rejected'));

/**
 * Full plaintext export — the payload the kill-switch seals. The client
 * encrypts it with the admin's passphrase BEFORE it touches disk; this
 * endpoint only exists behind requireAdmin + an active session.
 */
app.get('/api/admin/export', requireAdmin, async (_req, res) => {
  try {
    const dump = await exportAll();
    res.setHeader('Content-Disposition', 'attachment; filename="hd-export.json"');
    res.json(dump);
  } catch (err) {
    console.error('[api] admin export failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

/**
 * Kill-switch. Lockdown refuses every public write and every login except
 * the admin's; the export (sealed client-side) is the operator's offline
 * copy of everything the site held.
 */
app.post('/api/admin/lockdown', requireAdmin, async (req, res) => {
  try {
    const site = await setSiteLocked(true, req.admin.handle);
    console.log(`[api] LOCKDOWN engaged by ${req.admin.handle}`);
    res.json({ site: siteShape(site) });
  } catch (err) {
    console.error('[api] lockdown failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/admin/unlock', requireAdmin, async (req, res) => {
  try {
    const site = await setSiteLocked(false, req.admin.handle);
    console.log(`[api] lockdown released by ${req.admin.handle}`);
    res.json({ site: siteShape(site) });
  } catch (err) {
    console.error('[api] unlock failed:', err.message);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

// --- Admin tooling upgrades --------------------------------------------------

app.post('/api/admin/waitlist/:id/notes', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const { notes } = req.body ?? {};
  if (typeof notes !== 'string') {
    return res.status(400).json({ error: 'invalid_notes' });
  }
  try {
    const row = await updateWaitlistNotes(id, notes);
    if (!row) return res.status(404).json({ error: 'unknown_entry' });
    await recordAdminAction(req.admin.handle, 'notes', row.handle, row.email);
    return res.json({ entry: { id: row.id, notes: row.notes } });
  } catch (err) {
    console.error('[api] waitlist notes failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.post('/api/admin/waitlist/bulk', requireAdmin, async (req, res) => {
  const { ids, action } = req.body ?? {};
  if (!Array.isArray(ids) || !ids.length || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  try {
    const count = await bulkDecideWaitlist(ids, action, req.admin.handle);
    for (const id of ids) {
      await recordAdminAction(req.admin.handle, action, null, null);
    }
    return res.json({ updated: count });
  } catch (err) {
    console.error('[api] bulk decide failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  try {
    const rows = await getAdminActions(limit);
    res.json({
      actions: rows.map((r) => ({
        id: r.id,
        actorHandle: r.actor_handle,
        action: r.action,
        targetHandle: r.target_handle,
        targetEmail: r.target_email,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[api] audit log failed:', err.message);
    return res.status(503).json({ error: 'storage_unavailable' });
  }
});

// Unknown API route → JSON 404 (never the SPA).
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// --- Static client (production: npm run build && npm start) ---------------

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(DIST, 'index.html'));
    } else {
      next();
    }
  });
}

// --- Boot ------------------------------------------------------------------

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3001);

initSchema(); // never throws; retries every 15s while the DB is down

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on http://0.0.0.0:${PORT}`);
});
