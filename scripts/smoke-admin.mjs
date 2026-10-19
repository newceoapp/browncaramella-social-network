/**
 * End-to-end admin test: approval queue + kill-switch, against a real API
 * server process and the system PostgreSQL.
 *
 * Imports src/crypto.js — the SAME module the browser dashboard uses — to
 * verify the kill-switch export really opens with the admin passphrase and
 * nothing else (the seal happens client-side by design).
 *
 * Run: node scripts/smoke-admin.mjs
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
  sealJSON,
  openJSON,
} from '../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PORT = 3998;
const BASE = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/hackersdigest';

const ADMIN = 'evobugz';
const ADMIN_EMAIL = 'smoke-admin@example.com';
const USER_EMAIL = 'smoke-user@example.com';
const REJECTED_EMAIL = 'smoke-rejected@example.com';
const STRANGER_EMAIL = 'smoke-stranger@example.com'; // never waitlisted
const USER_HANDLE = 'smokeuser';
const REJECTED_HANDLE = 'smokereject';
const PASSPHRASE = 'correct horse battery staple';
const KILL_PASSPHRASE = 'operator lockdown passphrase';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const jsonHeaders = { 'content-type': 'application/json' };

async function post(urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
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

/** Register like the browser does: fresh keypair + proof of possession. */
async function register(email, handle, passphrase) {
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
  return post('/api/auth/register', { email, handle, publicKey, encryptionPublicKey, keyBackup, proof });
}

let server = null;
const cleanup = new pg.Client({ connectionString: DB_URL });

try {
  // --- boot a dedicated API server on :3998 -------------------------------
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server err] ' + d));

  for (let i = 0; i < 40; i += 1) {
    try {
      const h = await get('/api/health');
      if (h.status === 200) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('server up', (await get('/api/health')).status === 200);

  // Start from a clean slate (also releases a lockdown a previous crashed
  // run might have left behind).
  await cleanup.connect();
  await cleanup.query(
    `DELETE FROM auth_challenges WHERE handle IN ($1, $2, $3)`,
    [ADMIN, USER_HANDLE, REJECTED_HANDLE]
  );
  await cleanup.query(`DELETE FROM accounts WHERE handle IN ($1, $2, $3)`, [
    ADMIN,
    USER_HANDLE,
    REJECTED_HANDLE,
  ]);
  await cleanup.query(
    `DELETE FROM waitlist WHERE email IN ($1, $2, $3, $4)`,
    [ADMIN_EMAIL, USER_EMAIL, REJECTED_EMAIL, STRANGER_EMAIL]
  );
  await cleanup.query('UPDATE site_state SET locked = false, locked_at = NULL, locked_by = NULL WHERE id = 1');

  // --- approval workflow ---------------------------------------------------

  const wlUser = await post('/api/waitlist', { email: USER_EMAIL, handle: USER_HANDLE });
  check(
    'user signup → 201 pending',
    wlUser.status === 201 && wlUser.data?.status === 'pending',
    `${wlUser.status} ${wlUser.data?.status}`
  );

  const regPending = await register(USER_EMAIL, USER_HANDLE, PASSPHRASE);
  check(
    'pending user cannot register → 403 not_approved',
    regPending.status === 403 && regPending.data?.error === 'not_approved',
    `${regPending.status} ${regPending.data?.error}`
  );

  const wlAdmin = await post('/api/waitlist', { email: ADMIN_EMAIL, handle: ADMIN });
  check(
    'admin signup auto-approved',
    wlAdmin.status === 201 && wlAdmin.data?.status === 'approved',
    `${wlAdmin.status} ${wlAdmin.data?.status}`
  );

  const regAdmin = await register(ADMIN_EMAIL, ADMIN, PASSPHRASE);
  check(
    'admin registers → 201',
    regAdmin.status === 201,
    String(regAdmin.status)
  );
  const adminCookie = cookieValue(regAdmin.setCookie);
  check('admin session cookie set', !!adminCookie);
  check(
    'admin account carries isAdmin',
    regAdmin.data?.account?.isAdmin === true,
    String(regAdmin.data?.account?.isAdmin)
  );

  // stranger: not admin, valid session? — no account; use admin-vs-user gate
  // via a second registration after approval below.

  // --- admin route authorization -------------------------------------------

  check(
    'admin routes without session → 401',
    (await get('/api/admin/overview')).status === 401
  );

  // --- approval queue ------------------------------------------------------

  const queue = await get('/api/admin/waitlist?status=pending', adminCookie);
  check(
    'pending queue lists user request',
    queue.status === 200 &&
      (queue.data?.entries ?? []).some(
        (e) => e.email === USER_EMAIL && e.handle === USER_HANDLE
      ),
    JSON.stringify(queue.data?.entries?.map((e) => e.email))
  );

  const pendingId = (queue.data?.entries ?? []).find(
    (e) => e.email === USER_EMAIL
  )?.id;

  const approve = await post(`/api/admin/waitlist/${pendingId}/approve`, {}, adminCookie);
  check(
    'approve → 200 approved',
    approve.status === 200 && approve.data?.entry?.status === 'approved',
    `${approve.status} ${approve.data?.entry?.status}`
  );
  check(
    'decision records the operator',
    approve.data?.entry?.decidedBy === ADMIN,
    String(approve.data?.entry?.decidedBy)
  );

  const regUser = await register(USER_EMAIL, USER_HANDLE, PASSPHRASE);
  check('approved user registers → 201', regUser.status === 201, String(regUser.status));
  const userCookie = cookieValue(regUser.setCookie);
  check(
    'regular account isAdmin=false',
    regUser.data?.account?.isAdmin === false,
    String(regUser.data?.account?.isAdmin)
  );

  check(
    'non-admin gets 403 on admin routes',
    (await get('/api/admin/overview', userCookie)).status === 403
  );
  check(
    'non-admin cannot list the queue',
    (await get('/api/admin/waitlist?status=pending', userCookie)).status === 403
  );
  check(
    'non-admin cannot export',
    (await get('/api/admin/export', userCookie)).status === 403
  );
  check(
    'non-admin cannot engage lockdown',
    (await post('/api/admin/lockdown', {}, userCookie)).status === 403
  );

  // reject flow
  await post('/api/waitlist', { email: REJECTED_EMAIL, handle: REJECTED_HANDLE });
  const rejQueue = await get('/api/admin/waitlist?status=pending', adminCookie);
  const rejId = (rejQueue.data?.entries ?? []).find(
    (e) => e.email === REJECTED_EMAIL
  )?.id;
  const reject = await post(`/api/admin/waitlist/${rejId}/reject`, {}, adminCookie);
  check(
    'reject → 200 rejected',
    reject.status === 200 && reject.data?.entry?.status === 'rejected',
    `${reject.status} ${reject.data?.entry?.status}`
  );
  const regRejected = await register(REJECTED_EMAIL, REJECTED_HANDLE, PASSPHRASE);
  check(
    'rejected user cannot register → 403 not_approved',
    regRejected.status === 403 && regRejected.data?.error === 'not_approved',
    `${regRejected.status} ${regRejected.data?.error}`
  );

  // duplicate waitlist hit returns current status
  const dup = await post('/api/waitlist', { email: USER_EMAIL, handle: USER_HANDLE });
  check(
    'duplicate signup → 409 with approved status',
    dup.status === 409 && dup.data?.status === 'approved',
    `${dup.status} ${dup.data?.status}`
  );

  // --- overview stats ------------------------------------------------------
  // Counts are deltas: the dev DB holds real rows (the operator's own
  // signup among them) that the test must not disturb or depend on.

  const overview = await get('/api/admin/overview', adminCookie);
  const s = overview.data?.stats;
  check(
    'overview: two test accounts exist',
    overview.status === 200 && s?.accounts >= 2,
    String(s?.accounts)
  );
  check(
    'overview: at least the two approved test emails',
    s?.waitlist.approved >= 2,
    JSON.stringify(s?.waitlist)
  );
  check(
    'overview: one rejected test email',
    s?.waitlist.rejected >= 1,
    JSON.stringify(s?.waitlist)
  );
  check(
    'overview reports unlocked',
    overview.data?.site?.locked === false
  );

  // --- kill-switch ---------------------------------------------------------

  const exportRes = await get('/api/admin/export', adminCookie);
  check(
    'export → 200 with all tables',
    exportRes.status === 200 &&
      Array.isArray(exportRes.data?.waitlist) &&
      Array.isArray(exportRes.data?.accounts) &&
      Array.isArray(exportRes.data?.sessions) &&
      Array.isArray(exportRes.data?.posts),
    `waitlist=${exportRes.data?.waitlist?.length} accounts=${exportRes.data?.accounts?.length}`
  );

  // The dashboard seals the export in the browser; replicate exactly that:
  // sealJSON comes from the client module, and this server process never
  // sees KILL_PASSPHRASE.
  const sealed = await sealJSON(exportRes.data, KILL_PASSPHRASE);
  check(
    'sealed export carries no plaintext',
    !JSON.stringify(sealed).includes(USER_EMAIL) &&
      !JSON.stringify(sealed).includes(ADMIN_EMAIL),
    ''
  );
  const reopened = await openJSON(sealed, KILL_PASSPHRASE);
  check(
    'sealed export reopens with the passphrase',
    (reopened?.accounts?.length ?? 0) >= 2 &&
      (reopened?.waitlist?.length ?? 0) >= 3,
    `accounts=${reopened?.accounts?.length} waitlist=${reopened?.waitlist?.length}`
  );
  let wrongPassFailed = false;
  try {
    await openJSON(sealed, 'not the passphrase');
  } catch (err) {
    wrongPassFailed = err?.message === 'wrong_passphrase';
  }
  check('wrong passphrase cannot open the export', wrongPassFailed);

  const lock = await post('/api/admin/lockdown', {}, adminCookie);
  check(
    'lockdown engages → locked',
    lock.status === 200 && lock.data?.site?.locked === true,
    `${lock.status} ${lock.data?.site?.locked}`
  );
  check(
    'lockdown records who locked',
    lock.data?.site?.lockedBy === ADMIN,
    String(lock.data?.site?.lockedBy)
  );

  // site refuses public writes while locked
  const lockedWaitlist = await post('/api/waitlist', {
    email: STRANGER_EMAIL,
    handle: 'smokestranger',
  });
  check(
    'locked: waitlist signup → 503 site_locked',
    lockedWaitlist.status === 503 && lockedWaitlist.data?.error === 'site_locked',
    `${lockedWaitlist.status} ${lockedWaitlist.data?.error}`
  );
  const lockedRegister = await register(STRANGER_EMAIL, 'smokestranger', PASSPHRASE);
  check(
    'locked: registration → 503 site_locked',
    lockedRegister.status === 503 && lockedRegister.data?.error === 'site_locked',
    String(lockedRegister.status)
  );

  // non-admin cannot log in while locked
  const chLocked = await post('/api/auth/challenge', { handle: USER_HANDLE });
  check(
    'locked: user challenge → 503 site_locked',
    chLocked.status === 503 && chLocked.data?.error === 'site_locked',
    String(chLocked.status)
  );

  // admin CAN log in while locked (must be able to release it)
  const chAdmin = await post('/api/auth/challenge', { handle: ADMIN });
  check('locked: admin challenge still works', chAdmin.status === 200, String(chAdmin.status));
  const adminKeys = await openKeyBackup(chAdmin.data.keyBackup, PASSPHRASE);
  const adminSig = await signMessage(adminKeys.signingKey, loginMessage(chAdmin.data.nonce));
  const loginAdmin = await post('/api/auth/login', {
    handle: ADMIN,
    nonce: chAdmin.data.nonce,
    signature: adminSig,
  });
  check(
    'locked: admin logs in → 200',
    loginAdmin.status === 200,
    String(loginAdmin.status)
  );
  const adminCookie2 = cookieValue(loginAdmin.setCookie) ?? adminCookie;

  const stats = await get('/api/stats');
  check('stats report locked=true', stats.data?.locked === true);

  // release
  const unlock = await post('/api/admin/unlock', {}, adminCookie2);
  check(
    'unlock → 200 unlocked',
    unlock.status === 200 && unlock.data?.site?.locked === false,
    String(unlock.status)
  );

  const afterUnlock = await post('/api/waitlist', {
    email: STRANGER_EMAIL,
    handle: 'smokestranger',
  });
  check(
    'after unlock: signup works again → 201 pending',
    afterUnlock.status === 201 && afterUnlock.data?.status === 'pending',
    `${afterUnlock.status} ${afterUnlock.data?.status}`
  );

  const stats2 = await get('/api/stats');
  check('stats report locked=false after unlock', stats2.data?.locked === false);
} catch (err) {
  console.error('SMOKE-ADMIN ERROR:', err);
  results.push({ name: 'unexpected error', pass: false });
} finally {
  if (server) {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    await cleanup.query(
      `DELETE FROM auth_challenges WHERE handle IN ($1, $2, $3, 'smokestranger')`,
      [ADMIN, USER_HANDLE, REJECTED_HANDLE]
    );
    await cleanup.query(
      `DELETE FROM accounts WHERE handle IN ($1, $2, $3, 'smokestranger')`,
      [ADMIN, USER_HANDLE, REJECTED_HANDLE]
    );
    await cleanup.query(
      `DELETE FROM waitlist WHERE email IN ($1, $2, $3, $4)`,
      [ADMIN_EMAIL, USER_EMAIL, REJECTED_EMAIL, STRANGER_EMAIL]
    );
    await cleanup.query(
      'UPDATE site_state SET locked = false, locked_at = NULL, locked_by = NULL WHERE id = 1'
    );
    await cleanup.end();
    console.log('cleaned up test rows + released any lockdown');
  } catch (err) {
    console.log(`cleanup skipped (${err.message})`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
