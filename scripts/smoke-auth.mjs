/**
 * End-to-end auth test: real system PostgreSQL + a real API server process.
 *
 * Imports src/crypto.js — the SAME module the browser UI uses — so the test
 * exercises the actual registration/login logic, not a parallel reimplementation.
 *
 * Run: node scripts/smoke-auth.mjs
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
} from '../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PORT = 3999;
const BASE = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const EMAIL_A = 'smoke-auth-a@example.com';
const EMAIL_B = 'smoke-auth-b@example.com';
const EMAIL_C = 'smoke-auth-c@example.com'; // never put on the waitlist
const HANDLE_A = 'smokealice';
const HANDLE_B = 'smokebob';
const PASSPHRASE = 'correct horse battery staple';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const jsonHeaders = { 'content-type': 'application/json' };

/** POST helper that carries a session cookie like a browser would. */
async function post(urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      ...(cookie ? { cookie } : {}),
    },
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

/** Build a complete registration payload with the real client crypto. */
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
  // NOTE: never spread keyPair into a request body — CryptoKey implements
  // toJSON() in current browsers/Node and would serialize the private JWK.
  return { email, handle, publicKey, encryptionPublicKey, keyBackup, proof };
}

let server = null;
const cleanup = new pg.Client({ connectionString: DB_URL });

try {
  // --- boot a dedicated API server on :3999 -------------------------------
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

  // --- fixtures: A and B on the waitlist, C is NOT ------------------------
  for (const email of [EMAIL_A, EMAIL_B]) {
    const r = await post('/api/waitlist', { email });
    check(`waitlist invite for ${email}`, r.status === 201 || r.status === 409, String(r.status));
  }
  // Signups now land 'pending' — the approval gate itself is exercised by
  // smoke-admin; this suite cares about auth mechanics, so approve directly.
  {
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    await db.query('UPDATE waitlist SET status = $1 WHERE email = ANY($2)', [
      'approved',
      [EMAIL_A, EMAIL_B],
    ]);
    await db.end();
  }

  // --- registration -------------------------------------------------------
  const regA = await buildRegistration(EMAIL_A, HANDLE_A, PASSPHRASE);
  const resA = await post('/api/auth/register', regA);
  const cookieA = cookieValue(resA.setCookie);
  check(
    'register A → 201 + session cookie',
    resA.status === 201 && !!cookieA && resA.data?.account?.handle === HANDLE_A,
    `${resA.status} handle=${resA.data?.account?.handle ?? '-'}`
  );
  check(
    'registration returns fingerprint',
    /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/.test(resA.data?.account?.fingerprint ?? ''),
    resA.data?.account?.fingerprint ?? '-'
  );

  const meA = await get('/api/auth/me', cookieA);
  check('/me with session → account', meA.status === 200 && meA.data?.account?.handle === HANDLE_A, String(meA.status));
  {
    const anon = await get('/api/auth/me');
    check(
      '/me without session → 200 null account',
      anon.status === 200 && anon.data?.account == null,
      `${anon.status} ${JSON.stringify(anon.data)}`
    );
  }

  // invite gate: C is not on the waitlist
  const regC = await buildRegistration(EMAIL_C, 'smokecarol', PASSPHRASE);
  const resC = await post('/api/auth/register', regC);
  check('register not-on-waitlist → 403 not_invited', resC.status === 403 && resC.data?.error === 'not_invited', `${resC.status} ${resC.data?.error}`);

  // duplicate handle
  const regA2 = await buildRegistration(EMAIL_B, HANDLE_A, PASSPHRASE);
  const resA2 = await post('/api/auth/register', regA2);
  check('duplicate handle → 409 handle_taken', resA2.status === 409 && resA2.data?.error === 'handle_taken', `${resA2.status} ${resA2.data?.error}`);

  // proof of possession: garbage proof must be rejected
  const regB = await buildRegistration(EMAIL_B, HANDLE_B, PASSPHRASE);
  const badProof = await post('/api/auth/register', { ...regB, proof: Buffer.alloc(64).toString('base64') });
  check('forged proof → 400 invalid_proof', badProof.status === 400 && badProof.data?.error === 'invalid_proof', `${badProof.status} ${badProof.data?.error}`);

  // real B registration succeeds (needed for login tests)
  const resB = await post('/api/auth/register', regB);
  check('register B → 201', resB.status === 201, String(resB.status));

  // --- login flow ---------------------------------------------------------
  const ch = await post('/api/auth/challenge', { handle: HANDLE_B });
  check('challenge → nonce + sealed key backup', ch.status === 200 && !!ch.data?.nonce && !!ch.data?.keyBackup && !!ch.data?.keyBackup?.ct, String(ch.status));

  // wrong passphrase fails client-side, before any signature is sent
  let wrongPassOk = false;
  try {
    await openKeyBackup(ch.data.keyBackup, 'not the passphrase');
  } catch (err) {
    wrongPassOk = err?.message === 'wrong_passphrase';
  }
  check('wrong passphrase → rejected locally', wrongPassOk);

  // correct passphrase → sign → login
  let keys;
  keys = await openKeyBackup(ch.data.keyBackup, PASSPHRASE);
  const sigB = await signMessage(keys.signingKey, loginMessage(ch.data.nonce));
  const loginB = await post('/api/auth/login', { handle: HANDLE_B, nonce: ch.data.nonce, signature: sigB });
  const cookieB = cookieValue(loginB.setCookie);
  check('login B → 200 + session', loginB.status === 200 && !!cookieB && loginB.data?.account?.handle === HANDLE_B, String(loginB.status));

  // replay: same nonce again → consumed
  const replay = await post('/api/auth/login', { handle: HANDLE_B, nonce: ch.data.nonce, signature: sigB });
  check('replayed challenge → 401 challenge_expired', replay.status === 401 && replay.data?.error === 'challenge_expired', `${replay.status} ${replay.data?.error}`);

  // tampered signature
  const ch2 = await post('/api/auth/challenge', { handle: HANDLE_B });
  const sigBytes = Buffer.from(sigB, 'base64');
  sigBytes[0] ^= 0xff;
  const tampered = await post('/api/auth/login', {
    handle: HANDLE_B,
    nonce: ch2.data.nonce,
    signature: sigBytes.toString('base64'),
  });
  check('tampered signature → 401 invalid_signature', tampered.status === 401 && tampered.data?.error === 'invalid_signature', `${tampered.status} ${tampered.data?.error}`);

  // unknown handle
  const chUnknown = await post('/api/auth/challenge', { handle: 'nosuchhandle' });
  check('challenge unknown handle → 404', chUnknown.status === 404, String(chUnknown.status));

  // fresh challenge works again (old consumed one doesn't leak)
  const ch3 = await post('/api/auth/challenge', { handle: HANDLE_B });
  const sig3 = await signMessage(keys.signingKey, loginMessage(ch3.data.nonce));
  const relogin = await post('/api/auth/login', { handle: HANDLE_B, nonce: ch3.data.nonce, signature: sig3 });
  check('fresh challenge → login again', relogin.status === 200, String(relogin.status));

  // logout kills the session
  const out = await post('/api/auth/logout', {}, cookieB);
  check('logout → ok', out.status === 200, String(out.status));
  {
    const dead = await get('/api/auth/me', cookieB);
    check(
      'session dead after logout → 200 null account',
      dead.status === 200 && dead.data?.account == null,
      `${dead.status} ${JSON.stringify(dead.data)}`
    );
  }
} catch (err) {
  console.error('SMOKE-AUTH ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
  console.log(`FAIL  unexpected error — ${err?.message ?? err}`);
} finally {
  // --- cleanup: accounts (cascades sessions), challenges, waitlist rows ---
  try {
    await cleanup.connect();
    // accounts reference waitlist(email) with ON DELETE RESTRICT — order matters.
    await cleanup.query('DELETE FROM accounts WHERE handle = ANY($1)', [
      [HANDLE_A, HANDLE_B, 'smokecarol'],
    ]);
    await cleanup.query(
      'DELETE FROM waitlist WHERE email = ANY($1)',
      [[EMAIL_A, EMAIL_B, EMAIL_C]]
    );
    await cleanup.query(
      'DELETE FROM auth_challenges WHERE handle = ANY($1)',
      [[HANDLE_A, HANDLE_B, 'smokecarol', 'nosuchhandle']]
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
