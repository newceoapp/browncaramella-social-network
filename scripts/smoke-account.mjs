/**
 * End-to-end account management test: real API server + real PostgreSQL.
 *
 * Exercises: passphrase change, key rotation, self-export, session list /
 * revoke, and account deletion — using the SAME src/crypto.js the browser UI uses.
 *
 * Run: node scripts/smoke-account.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import {
  generateIdentity,
  generateEncryptionIdentity,
  exportPublicKeyB64,
  exportEncryptionPublicKeyB64,
  sealKeyBackup,
  openKeyBackup,
  registerProofMessage,
  loginMessage,
  signMessage,
  sealForRecipient,
  openSealed,
  sealJSON,
  openJSON,
} from '../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PORT = 3996;
const BASE = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const EMAIL = 'smoke-acct@example.com';
const HANDLE = 'smokeacct';
const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'new correct horse battery staple';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const jsonHeaders = { 'content-type': 'application/json' };

async function post(urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie };
}
async function get(urlPath, cookie) {
  const res = await fetch(BASE + urlPath, {
    headers: cookie ? { cookie } : {},
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
function cookieValue(setCookie) {
  const m = setCookie.match(/^(hd_session=[^;]+)/);
  return m ? m[1] : null;
}

async function buildRegistration(email, handle, passphrase) {
  const signingKeyPair = await generateIdentity();
  const encryptionKeyPair = await generateEncryptionIdentity();
  const publicKey = await exportPublicKeyB64(signingKeyPair);
  const encryptionPublicKey = await exportEncryptionPublicKeyB64(encryptionKeyPair);
  const keyBackup = await sealKeyBackup(
    signingKeyPair.privateKey,
    encryptionKeyPair.privateKey,
    passphrase
  );
  const proof = await signMessage(
    signingKeyPair.privateKey,
    registerProofMessage(email, handle)
  );
  return { email, handle, publicKey, encryptionPublicKey, keyBackup, proof, signingKeyPair, encryptionKeyPair };
}

let server = null;
const cleanup = new pg.Client({ connectionString: DB_URL });

try {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT) },
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

  // --- fixture: user on waitlist + approved --------------------------------
  const wl = await post('/api/waitlist', { email: EMAIL, handle: HANDLE });
  check('waitlist invite → 201/409', wl.status === 201 || wl.status === 409, String(wl.status));
  {
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    await db.query('UPDATE waitlist SET status = $1 WHERE email = $2', ['approved', EMAIL]);
    await db.end();
  }

  // --- register ------------------------------------------------------------
  const reg = await buildRegistration(EMAIL, HANDLE, PASSPHRASE);
  const res = await post('/api/auth/register', reg);
  const cookie = cookieValue(res.setCookie);
  check('register → 201 + session', res.status === 201 && !!cookie && res.data?.account?.handle === HANDLE, `${res.status}`);

  // --- login (establishes session + encryptionKey) -------------------------
  const ch = await post('/api/auth/challenge', { handle: HANDLE });
  check('challenge → 200', ch.status === 200, String(ch.status));
  const keys = await openKeyBackup(ch.data.keyBackup, PASSPHRASE);
  const sig = await signMessage(keys.signingKey, loginMessage(ch.data.nonce));
  const login = await post('/api/auth/login', { handle: HANDLE, nonce: ch.data.nonce, signature: sig });
  const cookie2 = cookieValue(login.setCookie);
  check('login → 200 + session', login.status === 200 && !!cookie2, `${login.status}`);
  const activeCookie = cookie2;

  // --- passphrase change ---------------------------------------------------
  // `keys` was opened with PASSPHRASE from the challenge above.
  const newBackup = await sealKeyBackup(keys.signingKey, keys.encryptionKey, NEW_PASSPHRASE);
  const passRes = await post('/api/account/passphrase', { keyBackup: newBackup }, activeCookie);
  check('passphrase change → 200', passRes.status === 200, `${passRes.status} ${JSON.stringify(passRes.data)}`);

  // Verify: login with new passphrase works
  const ch2 = await post('/api/auth/challenge', { handle: HANDLE });
  const keys2 = await openKeyBackup(ch2.data.keyBackup, NEW_PASSPHRASE);
  const sig2 = await signMessage(keys2.signingKey, loginMessage(ch2.data.nonce));
  const login2 = await post('/api/auth/login', { handle: HANDLE, nonce: ch2.data.nonce, signature: sig2 });
  check('login with new passphrase → 200', login2.status === 200, `${login2.status}`);

  // --- key rotation --------------------------------------------------------
  const signingKeyPair = await generateIdentity();
  const encryptionKeyPair = await generateEncryptionIdentity();
  const publicKey = await exportPublicKeyB64(signingKeyPair);
  const encryptionPublicKey = await exportEncryptionPublicKeyB64(encryptionKeyPair);
  const rotBackup = await sealKeyBackup(signingKeyPair.privateKey, encryptionKeyPair.privateKey, NEW_PASSPHRASE);
  const rotProof = await signMessage(
    signingKeyPair.privateKey,
    new TextEncoder().encode(`hd-auth-v1:rotate:${HANDLE}`)
  );
  const rotRes = await post('/api/account/rotate-key', {
    publicKey, encryptionPublicKey, keyBackup: rotBackup, proof: rotProof,
  }, activeCookie);
  check('rotate-key → 200', rotRes.status === 200, `${rotRes.status} ${JSON.stringify(rotRes.data)}`);
  check('rotated account has new fingerprint', !!rotRes.data?.account?.fingerprint && rotRes.data.account.fingerprint !== login2.data.account.fingerprint, `old=${login2.data.account.fingerprint} new=${rotRes.data.account.fingerprint}`);

  // --- self-export ---------------------------------------------------------
  const ch3 = await post('/api/auth/challenge', { handle: HANDLE });
  const keys3 = await openKeyBackup(ch3.data.keyBackup, NEW_PASSPHRASE);
  const expRes = await get('/api/account/export', activeCookie);
  check('account export → 200', expRes.status === 200, `${expRes.status}`);
  check('export contains account', !!expRes.data?.account, JSON.stringify(expRes.data));
  check('export contains sessions', Array.isArray(expRes.data?.sessions));
  check('export contains posts', Array.isArray(expRes.data?.posts));
  check('export contains waitlist', Array.isArray(expRes.data?.waitlist));

  // Seal the export with passphrase and verify it opens
  const sealed = await sealJSON(expRes.data, NEW_PASSPHRASE);
  const opened = await openJSON(sealed, NEW_PASSPHRASE);
  check('sealed export reopens with passphrase', !!opened && opened.account.handle === HANDLE, `account=${opened.account?.handle}`);

  // --- sessions list -------------------------------------------------------
  const sessRes = await get('/api/account/sessions', activeCookie);
  check('sessions list → 200', sessRes.status === 200, `${sessRes.status}`);
  check('sessions is array', Array.isArray(sessRes.data?.sessions));
  check('sessions has current', sessRes.data?.sessions?.some((s) => s.current === true));

  // --- create a post for export data ---------------------------------------
  const dirRes = await get(`/api/accounts/${HANDLE}/fingerprint`);
  const sealedPost = await sealForRecipient('rotated account test post', dirRes.data.encryptionKey);
  const postRes = await post('/api/posts', {
    recipient: dirRes.data.fingerprint,
    ciphertext: sealedPost.ct,
    nonce: sealedPost.iv,
    ephemeral: sealedPost.ephemeral,
    wrapped_key: sealedPost.wrappedKey,
    wrap_iv: sealedPost.wrapIv,
  }, activeCookie);
  check('create post → 201', postRes.status === 201, `${postRes.status}`);

  // --- revoke a session (create a second one first) ------------------------
  const ch4 = await post('/api/auth/challenge', { handle: HANDLE });
  const keys4 = await openKeyBackup(ch4.data.keyBackup, NEW_PASSPHRASE);
  const sig4 = await signMessage(keys4.signingKey, loginMessage(ch4.data.nonce));
  const login4 = await post('/api/auth/login', { handle: HANDLE, nonce: ch4.data.nonce, signature: sig4 });
  const cookie4 = cookieValue(login4.setCookie);

  const sessRes2 = await get('/api/account/sessions', cookie4);
  check('sessions list after second login → 200', sessRes2.status === 200);
  const nonCurrent = sessRes2.data.sessions.find((s) => !s.current);
  if (nonCurrent) {
    const revRes = await post(`/api/account/sessions/${nonCurrent.tokenHash}`, undefined, cookie4);
    // Use DELETE directly
    const delRes = await fetch(`${BASE}/api/account/sessions/${encodeURIComponent(nonCurrent.tokenHash)}`, {
      method: 'DELETE',
      headers: { cookie: cookie4 },
    });
    check('revoke session → 204', delRes.status === 204, String(delRes.status));
  }

  // --- delete account ------------------------------------------------------
  const delRes = await fetch(`${BASE}/api/account`, {
    method: 'DELETE',
    headers: { cookie: cookie4 },
  });
  check('delete account → 200', delRes.status === 200, String(delRes.status));
  const delData = await delRes.json().catch(() => null);
  check('delete account returns ok', delData?.ok === true);

  // Verify account is gone: login should fail
  const ch5 = await post('/api/auth/challenge', { handle: HANDLE });
  check('challenge after delete → 404', ch5.status === 404, String(ch5.status));

} catch (err) {
  console.error('SMOKE-ACCOUNT ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
  console.log(`FAIL  unexpected error — ${err?.message ?? err}`);
} finally {
  try {
    await cleanup.connect();
    await cleanup.query('DELETE FROM accounts WHERE handle = $1', [HANDLE]);
    await cleanup.query('DELETE FROM waitlist WHERE email = $1', [EMAIL]);
    await cleanup.query('DELETE FROM auth_challenges WHERE handle = $1', [HANDLE]);
    await cleanup.query('DELETE FROM posts');
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
