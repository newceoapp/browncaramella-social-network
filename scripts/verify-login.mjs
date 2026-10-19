/**
 * Verify the admin account can log in end-to-end:
 *   GET /api/auth/challenge -> open sealed backup locally -> sign nonce ->
 *   POST /api/auth/login -> GET /api/auth/me -> POST /api/admin/overview
 *
 * Mirrors scripts/smoke-auth.mjs but against the seeded admin account.
 */
import { spawn } from 'node:child_process';
import {
  openKeyBackup,
  loginMessage,
  signMessage,
} from '../src/crypto.js';

const BASE = 'http://localhost:3001';
const ADMIN_HANDLE = 'evobugz';
const PASSPHRASE = 'admin-digest-2026';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

async function post(urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
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

// Ensure the API is up.
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise(r => setTimeout(r, 150)); }
}
check('API up on :3001', up);
if (!up) process.exit(1);

// 1. Challenge.
const ch = await post('/api/auth/challenge', { handle: ADMIN_HANDLE });
check('challenge → 200 nonce + sealed backup', ch.status === 200 && !!ch.data?.nonce && !!ch.data?.keyBackup?.ct, String(ch.status));

// 2. Open backup locally with the passphrase.
const keys = await openKeyBackup(ch.data.keyBackup, PASSPHRASE);
check('sealed backup opens with passphrase', !!keys.signingKey);

// 3. Sign + login.
const sig = await signMessage(keys.signingKey, loginMessage(ch.data.nonce));
const login = await post('/api/auth/login', { handle: ADMIN_HANDLE, nonce: ch.data.nonce, signature: sig });
const cookie = cookieValue(login.setCookie);
check('login → 200 + session cookie', login.status === 200 && !!cookie && login.data?.account?.handle === ADMIN_HANDLE, `${login.status} handle=${login.data?.account?.handle ?? '-'}`);
check('account carries isAdmin=true', login.data?.account?.isAdmin === true, String(login.data?.account?.isAdmin));

// 4. Session probe.
const me = await get('/api/auth/me', cookie);
check('/me → account', me.status === 200 && me.data?.account?.handle === ADMIN_HANDLE, String(me.status));

// 5. Admin dashboard access.
const ov = await get('/api/admin/overview', cookie);
check('/api/admin/overview → 200 (admin in dashboard)', ov.status === 200, String(ov.status));
if (ov.status === 200) {
  console.log('   overview:', JSON.stringify(ov.data));
}

// 6. Wrong passphrase fails client-side (never reaches server).
let wrong = false;
try { await openKeyBackup(ch.data.keyBackup, 'wrong'); } catch (e) { wrong = e.message === 'wrong_passphrase'; }
check('wrong passphrase rejected locally', wrong);

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} login checks passed`);
process.exit(failed.length ? 1 : 0);
