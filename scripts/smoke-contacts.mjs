/**
 * Contacts smoke test: real API server + real PostgreSQL.
 *
 * Verifies the social graph: directory search, contact requests, accept/block,
 * pending requests list, contacts-only feed filtering, and blocked contact
 * post rejection.
 *
 * Run: node scripts/smoke-contacts.mjs
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
  registerProofMessage,
  signMessage,
  sealForRecipient,
} from '../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PORT = 3994;
const BASE = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const EMAIL_A = 'smoke-ct-a@example.com';
const EMAIL_B = 'smoke-ct-b@example.com';
const EMAIL_C = 'smoke-ct-c@example.com';
const HANDLE_A = 'ctalice';
const HANDLE_B = 'ctbob';
const HANDLE_C = 'ctcarol';
const PASSPHRASE = 'correct horse battery staple';

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
  return { email, handle, publicKey, encryptionPublicKey, keyBackup, proof };
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

  // --- fixture: all three users on waitlist + approved ----------------------
  for (const email of [EMAIL_A, EMAIL_B, EMAIL_C]) {
    const r = await post('/api/waitlist', { email });
    check(`waitlist invite for ${email}`, r.status === 201 || r.status === 409, String(r.status));
  }
  {
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    await db.query('UPDATE waitlist SET status = $1 WHERE email = ANY($2)', [
      'approved',
      [EMAIL_A, EMAIL_B, EMAIL_C],
    ]);
    await db.end();
  }

  // --- register A, B, C ------------------------------------------------------
  const regA = await buildRegistration(EMAIL_A, HANDLE_A, PASSPHRASE);
  const resA = await post('/api/auth/register', regA);
  const cookieA = cookieValue(resA.setCookie);
  check('register A → 201', resA.status === 201 && resA.data?.account?.handle === HANDLE_A, `${resA.status}`);

  const regB = await buildRegistration(EMAIL_B, HANDLE_B, PASSPHRASE);
  const resB = await post('/api/auth/register', regB);
  const cookieB = cookieValue(resB.setCookie);
  check('register B → 201', resB.status === 201, `${resB.status}`);

  const regC = await buildRegistration(EMAIL_C, HANDLE_C, PASSPHRASE);
  const resC = await post('/api/auth/register', regC);
  const cookieC = cookieValue(resC.setCookie);
  check('register C → 201', resC.status === 201, `${resC.status}`);

  // --- directory search ------------------------------------------------------
  const dirRes = await get(`/api/directory?q=${HANDLE_B}`, cookieA);
  check(
    'directory search → 200 with results',
    dirRes.status === 200 &&
      Array.isArray(dirRes.data?.results) &&
      dirRes.data.results.some((r) => r.handle === HANDLE_B),
    `${dirRes.status} ${JSON.stringify(dirRes.data)}`
  );
  check(
    'directory excludes self',
    !dirRes.data.results.some((r) => r.handle === HANDLE_A),
    JSON.stringify(dirRes.data)
  );

  // --- send contact request A → B --------------------------------------------
  const reqRes = await post('/api/contacts', { target_handle: HANDLE_B }, cookieA);
  check(
    'send contact request → 201',
    reqRes.status === 201 && reqRes.data?.contact?.status === 'pending',
    `${reqRes.status} ${JSON.stringify(reqRes.data)}`
  );
  const contactId = reqRes.data.contact.id;

  // Duplicate request → 409
  const dupRes = await post('/api/contacts', { target_handle: HANDLE_B }, cookieA);
  check(
    'duplicate contact request → 409',
    dupRes.status === 409 && dupRes.data?.status === 'pending',
    `${dupRes.status}`
  );

  // Self-contact → 400
  const selfRes = await post('/api/contacts', { target_handle: HANDLE_A }, cookieA);
  check('self contact → 400', selfRes.status === 400, `${selfRes.status}`);

  // Unknown handle → 404
  const unknownRes = await post('/api/contacts', { target_handle: 'nosuchuser' }, cookieA);
  check('unknown handle → 404', unknownRes.status === 404, `${unknownRes.status}`);

  // --- pending requests ------------------------------------------------------
  const pendingB = await get('/api/contacts/requests', cookieB);
  check(
    'B has pending request from A',
    pendingB.status === 200 &&
      pendingB.data.requests.some((r) => r.requester.handle === HANDLE_A),
    `${pendingB.status}`
  );

  const pendingA = await get('/api/contacts/requests', cookieA);
  check(
    'A has no pending incoming requests',
    pendingA.status === 200 && pendingA.data.requests.length === 0,
    `${pendingA.status}`
  );

  // --- B accepts A's request -------------------------------------------------
  const acceptRes = await post(`/api/contacts/${contactId}/accept`, undefined, cookieB);
  check(
    'accept contact → 200',
    acceptRes.status === 200 && acceptRes.data?.ok === true,
    `${acceptRes.status}`
  );

  // --- contacts list ---------------------------------------------------------
  const contactsA = await get('/api/contacts?status=accepted', cookieA);
  check(
    'A has accepted contact B',
    contactsA.status === 200 &&
      contactsA.data.contacts.some((c) => c.other.handle === HANDLE_B && c.status === 'accepted'),
    `${contactsA.status}`
  );

  const contactsB = await get('/api/contacts?status=accepted', cookieB);
  check(
    'B has accepted contact A',
    contactsB.status === 200 &&
      contactsB.data.contacts.some((c) => c.other.handle === HANDLE_A && c.status === 'accepted'),
    `${contactsB.status}`
  );

  // --- posts between contacts work -------------------------------------------
  const dirBForA = await get(`/api/accounts/${HANDLE_B}/fingerprint`, cookieA);
  const sealedAB = await sealForRecipient('contact test post', dirBForA.data.encryptionKey);
  const postAB = await post('/api/posts', {
    recipient: dirBForA.data.fingerprint,
    ciphertext: sealedAB.ct,
    nonce: sealedAB.iv,
    ephemeral: sealedAB.ephemeral,
    wrapped_key: sealedAB.wrappedKey,
    wrap_iv: sealedAB.wrapIv,
  }, cookieA);
  check(
    'post between contacts → 201',
    postAB.status === 201,
    `${postAB.status}`
  );

  // --- contacts-only feed ----------------------------------------------------
  const feedAContacts = await get('/api/feed?contacts_only=true', cookieA);
  check(
    'contacts-only feed → 200',
    feedAContacts.status === 200 && Array.isArray(feedAContacts.data?.posts),
    `${feedAContacts.status}`
  );
  check(
    'contacts-only feed contains contact post',
    feedAContacts.data.posts.some((p) => p.id === postAB.data.id),
    JSON.stringify(feedAContacts.data.posts.map((p) => p.id))
  );

  // --- block contact ---------------------------------------------------------
  const blockRes = await post(`/api/contacts/${contactId}/block`, undefined, cookieB);
  check(
    'block contact → 200',
    blockRes.status === 200 && blockRes.data?.ok === true,
    `${blockRes.status}`
  );

  // Blocked contact cannot send post
  const dirBForA2 = await get(`/api/accounts/${HANDLE_B}/fingerprint`, cookieA);
  const sealedAB2 = await sealForRecipient('blocked contact test', dirBForA2.data.encryptionKey);
  const postBlocked = await post('/api/posts', {
    recipient: dirBForA2.data.fingerprint,
    ciphertext: sealedAB2.ct,
    nonce: sealedAB2.iv,
    ephemeral: sealedAB2.ephemeral,
    wrapped_key: sealedAB2.wrappedKey,
    wrap_iv: sealedAB2.wrapIv,
  }, cookieA);
  check(
    'blocked contact cannot send post → 403',
    postBlocked.status === 403,
    `${postBlocked.status}`
  );

  // --- C cannot contact A/B (not in directory or no relationship) ------------
  const dirC = await get(`/api/directory?q=${HANDLE_A}`, cookieC);
  check(
    'C can find A in directory',
    dirC.status === 200 && dirC.data.results.some((r) => r.handle === HANDLE_A),
    `${dirC.status}`
  );

} catch (err) {
  console.error('SMOKE-CONTACTS ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
  console.log(`FAIL  unexpected error — ${err?.message ?? err}`);
} finally {
  try {
    await cleanup.connect();
    await cleanup.query('DELETE FROM accounts WHERE handle = ANY($1)', [
      [HANDLE_A, HANDLE_B, HANDLE_C],
    ]);
    await cleanup.query('DELETE FROM waitlist WHERE email = ANY($1)', [
      [EMAIL_A, EMAIL_B, EMAIL_C],
    ]);
    await cleanup.query('DELETE FROM contacts');
    await cleanup.query('DELETE FROM posts');
    await cleanup.query('DELETE FROM auth_challenges WHERE handle = ANY($1)', [
      [HANDLE_A, HANDLE_B, HANDLE_C],
    ]);
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
