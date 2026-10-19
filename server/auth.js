/**
 * Auth primitives shared by the API routes.
 *
 * Protocol (v1) — no passwords anywhere:
 *   register: client generates an Ed25519 keypair in the browser, sends the
 *             public key (SPKI DER), a passphrase-sealed backup of the private
 *             key, and a proof signature over `hd-auth-v1:register:<email>:<handle>`.
 *   login:    server issues a random 32-byte nonce (single use, 2 min TTL);
 *             client decrypts the sealed backup locally with the passphrase,
 *             signs `hd-auth-v1:<nonce hex>`, server verifies against the
 *             stored public key and consumes the nonce.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';

export const AUTH_PREFIX = 'hd-auth-v1:';
export const SESSION_COOKIE = 'hd_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * The single admin account. Admin powers come from holding this handle —
 * there is no role table, no password, no elevation path. Whoever can
 * prove possession of evobugz's key IS the operator.
 */
export const ADMIN_HANDLE = process.env.ADMIN_HANDLE ?? 'evobugz';

export function isAdminHandle(handle) {
  return handle === ADMIN_HANDLE;
}

export function loginMessage(nonceBuf) {
  return Buffer.from(`${AUTH_PREFIX}${nonceBuf.toString('hex')}`, 'utf8');
}

export function registerMessage(email, handle) {
  return Buffer.from(
    `${AUTH_PREFIX}register:${email.toLowerCase()}:${handle}`,
    'utf8'
  );
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** Short display fingerprint: first 8 bytes of sha256(public key), grouped. */
export function fingerprintOf(derBuf) {
  return sha256(derBuf)
    .toString('hex')
    .slice(0, 16)
    .toUpperCase()
    .match(/.{4}/g)
    .join(' ');
}

/** Verify an Ed25519 signature over `message` using an SPKI DER public key. */
export function verifyEd25519(publicKeyDer, message, signature) {
  let key;
  try {
    key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  if (key.asymmetricKeyType !== 'ed25519') return false;
  try {
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** New bearer session token; only its sha256 is ever stored. */
export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(Buffer.from(token, 'utf8')) };
}

/** Minimal cookie header parser (no extra dependency for one cookie). */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSec, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export const CLEAR_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
