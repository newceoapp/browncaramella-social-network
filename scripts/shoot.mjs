/**
 * Loads the running app in a real browser (system Edge), verifies the DOM
 * renders, checks for layout overflow at desktop + mobile widths, and drives
 * the complete product flow through the real UI:
 *
 *   1. user joins the waitlist → lands in the review queue (pending),
 *   2. admin (evobugz) registers (auto-approved), approves the user at /admin,
 *   3. admin engages the kill-switch: sealed export downloads, site locks,
 *      the public site refuses writes, admin releases the lockdown,
 *   4. user re-submits → approved → claims account → signs out → logs back in.
 *
 * Screenshots land in shots/ for human review.
 *
 * Prerequisite: npm install --no-save playwright-core
 * Run: node scripts/shoot.mjs   (with the app served, default :3001)
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
const BASE = process.env.BASE_URL ?? 'http://localhost:3001';

const USER_EMAIL = 'shot-test@example.com';
const USER_HANDLE = 'shottest';
const ADMIN_EMAIL = 'shot-admin@example.com';
const ADMIN_HANDLE = 'evobugz';
const USER_PASS = 'correct horse battery';
const ADMIN_PASS = 'operator passphrase for tests';
const KILL_PASS = 'kill switch passphrase';

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });

try {
  // Two independent contexts: user and operator never share a session.
  const userCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  // The flow deliberately provokes two failing fetches (signup against the
  // locked site → 503, duplicate waitlist re-submit → 409). Those console
  // messages are expected; bump this counter right before triggering one.
  let expectFailedFetch = 0;
  const watch = (page, tag) => {
    page.on('pageerror', (e) => errors.push(`pageerror(${tag}): ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expectFailedFetch > 0 && /Failed to load resource/.test(m.text())) {
        expectFailedFetch -= 1;
        return;
      }
      errors.push(`console(${tag}): ${m.text()}`);
    });
  };

  const hOverflow = (page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );

  // ---- 1. landing page renders (user context) -----------------------------
  const page = await userCtx.newPage();
  watch(page, 'user');

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000); // let the terminal animation run a bit

  check('no browser JS errors (landing)', errors.length === 0, errors.join(' | '));
  check('hero headline visible', await page.locator('h1').isVisible());
  check('terminal visible', await page.locator('.terminal').isVisible());
  const typedLen = (await page.locator('.term-body').textContent())?.trim().length ?? 0;
  check('terminal is typing', typedLen > 0, `${typedLen} chars`);
  check('6 feature cards', (await page.locator('.card').count()) === 6);
  check('3 steps', (await page.locator('.step').count()) === 3);
  check('waitlist form visible', await page.locator('.form').isVisible());

  const statsText = (await page.locator('.stats-inner').textContent())?.replace(/\s+/g, ' ').trim();
  check('stats show live db status', /up/.test(statsText ?? ''), statsText);
  check('site starts unlocked', !/locked/i.test(statsText ?? ''));

  // ---- layout: no horizontal overflow (logged out) ----
  const desktopOverflow = await hOverflow(page);
  check('no desktop h-overflow', desktopOverflow <= 0, `${desktopOverflow}px`);

  await page.screenshot({ path: path.join(OUT, 'desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const mobileOverflow = await hOverflow(page);
  check('no mobile h-overflow', mobileOverflow <= 0, `${mobileOverflow}px`);
  check('mobile CTA still visible', await page.locator('.nav-cta').isVisible());
  check('mobile login link visible', await page.locator('.nav-login').isVisible());
  await page.screenshot({ path: path.join(OUT, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- 2. user joins the waitlist → review queue (pending) ----------------
  await page.fill('#email', USER_EMAIL);
  await page.fill('#handle', USER_HANDLE);
  await page.click('.form-btn');
  await page.waitForSelector('.done-title', { timeout: 5000 });
  const pendingTitle = (await page.locator('.done-title').textContent())?.trim();
  check(
    'waitlist signup → review-queue state',
    /review queue/.test(pendingTitle ?? ''),
    pendingTitle
  );
  check(
    'pending state has NO register link',
    (await page.locator('.done-actions').count()) === 0
  );
  await page.screenshot({ path: path.join(OUT, 'submitted.png'), fullPage: false });

  // ---- 3. admin bootstrap: evobugz joins (auto-approved) + registers ------
  const admin = await adminCtx.newPage();
  watch(admin, 'admin');

  await admin.goto(BASE, { waitUntil: 'networkidle' });
  await admin.fill('#email', ADMIN_EMAIL);
  await admin.fill('#handle', ADMIN_HANDLE);
  await admin.click('.form-btn');
  await admin.waitForSelector('.done-title', { timeout: 5000 });
  const adminDone = (await admin.locator('.done-title').textContent())?.trim();
  check(
    'admin waitlist signup auto-approved',
    /approved/i.test(adminDone ?? ''),
    adminDone
  );
  check(
    'approved state shows claim link',
    (await admin.locator('.done-actions a').count()) === 1
  );

  await admin.click('.done-actions a');
  await admin.waitForSelector('#reg-email', { timeout: 5000 });
  check('done-state → /register link', admin.url().includes('/register'), admin.url());
  check(
    'register email prefilled from waitlist',
    (await admin.inputValue('#reg-email')) === ADMIN_EMAIL,
    await admin.inputValue('#reg-email')
  );

  const regOverflow = await hOverflow(admin);
  check('no h-overflow on register page', regOverflow <= 0, `${regOverflow}px`);
  await admin.screenshot({ path: path.join(OUT, 'register.png'), fullPage: true });

  await admin.fill('#reg-handle', ADMIN_HANDLE);
  await admin.fill('#reg-pass', ADMIN_PASS);
  await admin.fill('#reg-pass2', ADMIN_PASS);
  await admin.click('button[type="submit"]');
  await admin.waitForSelector('.account-card', { timeout: 30000 });
  check('admin register → account page', admin.url().includes('/account'), admin.url());

  const acctTitle = (await admin.locator('.auth-title').textContent())?.trim();
  check('account shows handle', acctTitle === `@${ADMIN_HANDLE}`, acctTitle);

  const fingerprint = (await admin.locator('.account-row .mono.accent').textContent())?.trim();
  check(
    'fingerprint shown (16 hex in 4s)',
    /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/.test(fingerprint ?? ''),
    fingerprint
  );
  check(
    'public key block rendered',
    ((await admin.locator('.key-block pre').textContent()) ?? '').trim().length >= 60
  );
  check(
    'nav shows logged-in handle',
    (await admin.locator('.nav-handle').textContent())?.trim() === `@${ADMIN_HANDLE}`
  );

  // ---- 4. operator console: approve the pending user ----------------------
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.admin-tile', { timeout: 5000 });
  const adminNav = await admin.locator('.nav-links a:has-text("Admin")').count();
  check('nav shows Admin link for operator', adminNav === 1);

  const tiles = (await admin.locator('.admin-tile b').allTextContents()).map((t) => t.trim());
  check('dashboard shows live site status', tiles[0] === 'live', tiles[0]);
  check('dashboard counts pending requests', Number(tiles[1]) >= 1, tiles[1]);

  const userRow = admin.locator('.admin-row', { hasText: USER_EMAIL });
  check('pending queue lists the user', (await userRow.count()) === 1);
  await admin.screenshot({ path: path.join(OUT, 'admin-queue.png'), fullPage: true });

  await userRow.locator('button:has-text("Approve")').click();
  await admin.waitForTimeout(600);
  check(
    'approve removes request from queue',
    (await admin.locator('.admin-row', { hasText: USER_EMAIL }).count()) === 0
  );

  // ---- 5. kill-switch: seal export, lock the site -------------------------
  await admin.fill('#kill-pass', KILL_PASS);
  await admin.fill('#kill-pass2', KILL_PASS);
  const [download] = await Promise.all([
    admin.waitForEvent('download', { timeout: 30000 }),
    admin.click('.admin-kill button[type="submit"]'),
  ]);
  check('kill-switch downloads sealed export', !!download, download?.suggestedFilename());

  // verify the downloaded file is actually sealed ciphertext
  const dlPath = await download.path();
  let sealedOk = false;
  let sealedHasNoPlaintext = false;
  if (dlPath) {
    const raw = fs.readFileSync(dlPath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      sealedOk =
        parsed.kind === 'hackersdigest-sealed-json' &&
        typeof parsed.salt === 'string' &&
        typeof parsed.iv === 'string' &&
        typeof parsed.ct === 'string';
      sealedHasNoPlaintext = !raw.includes(USER_EMAIL) && !raw.includes(ADMIN_EMAIL);
    } catch {
      sealedOk = false;
    }
  }
  check('download is a sealed blob (salt/iv/ct)', sealedOk);
  check('sealed export leaks no plaintext emails', sealedHasNoPlaintext);

  await admin.waitForSelector('.admin-tile.is-locked', { timeout: 10000 });
  const lockTile = (await admin.locator('.admin-tile.is-locked b').textContent())?.trim();
  check('dashboard shows LOCKED', lockTile === 'LOCKED', lockTile);
  await admin.screenshot({ path: path.join(OUT, 'admin-locked.png'), fullPage: true });

  // public site refuses writes while locked
  const lockedStats = await (await fetch(`${BASE}/api/stats`)).json();
  check('api reports locked=true', lockedStats.locked === true);

  await page.reload({ waitUntil: 'networkidle' });
  const lockedBar = (await page.locator('.stats-inner').textContent())?.replace(/\s+/g, ' ');
  check('stats bar shows locked status', /locked/i.test(lockedBar ?? ''), lockedBar);

  await page.fill('#email', 'locked-out@example.com');
  await page.fill('#handle', 'lockedout');
  expectFailedFetch = 1; // the 503 from the locked site is the point of the test
  await page.click('.form-btn');
  await page.waitForSelector('.msg-err', { timeout: 5000 });
  const lockErr = (await page.locator('.msg-err').textContent())?.trim();
  check('locked site refuses signup', /locked down/.test(lockErr ?? ''), lockErr);

  // ---- 6. release the lockdown -------------------------------------------
  await admin.click('button:has-text("Release lockdown")');
  await admin.waitForSelector('.admin-tile b:has-text("live")', { timeout: 10000 });
  const unlockedStats = await (await fetch(`${BASE}/api/stats`)).json();
  check('release restores unlocked site', unlockedStats.locked === false);

  // ---- 7. user comes back: approved → claim → account ---------------------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#email', USER_EMAIL);
  await page.fill('#handle', USER_HANDLE);
  expectFailedFetch = 1; // duplicate signup → 409, but its payload carries the approved status
  await page.click('.form-btn');
  await page.waitForSelector('.done-title', { timeout: 5000 });
  const approvedTitle = (await page.locator('.done-title').textContent())?.trim();
  check(
    're-submit after approval → claim state',
    /approved/i.test(approvedTitle ?? ''),
    approvedTitle
  );

  await page.click('.done-actions a');
  await page.waitForSelector('#reg-handle', { timeout: 5000 });
  await page.fill('#reg-handle', USER_HANDLE);
  await page.fill('#reg-pass', USER_PASS);
  await page.fill('#reg-pass2', USER_PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.account-card', { timeout: 30000 });
  check('approved user registers', page.url().includes('/account'), page.url());

  // mobile nav while logged in as a regular user
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const acctMobileOverflow = await hOverflow(page);
  check('no mobile h-overflow (logged in)', acctMobileOverflow <= 0, `${acctMobileOverflow}px`);
  check('mobile nav handle visible', await page.locator('.nav-handle').isVisible());
  check(
    'regular user has NO Admin nav link',
    (await page.locator('.nav-links a:has-text("Admin")').count()) === 0
  );
  await page.screenshot({ path: path.join(OUT, 'account-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'account.png'), fullPage: true });

  // ---- 8. sign out, then login: wrong passphrase fails, right one works ---
  await page.click('.account-actions .btn-ghost');
  await page.waitForURL(`${BASE}/`, { timeout: 5000 });
  check('sign out → back home', new URL(page.url()).pathname === '/', page.url());
  // waitForURL can resolve before React re-renders the nav, so wait for the
  // actual logged-out text rather than just the URL change.
  await page.waitForSelector('.nav-login:has-text("Log in")', { timeout: 5000 });
  check(
    'nav shows Log in again',
    (await page.locator('.nav-login').textContent())?.includes('Log in')
  );

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login-handle', { timeout: 5000 });
  const loginOverflow = await hOverflow(page);
  check('no h-overflow on login page', loginOverflow <= 0, `${loginOverflow}px`);
  await page.fill('#login-handle', USER_HANDLE);
  await page.fill('#login-pass', 'totally wrong');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.msg-err', { timeout: 15000 });
  const errMsg = (await page.locator('.msg-err').textContent())?.trim();
  check('wrong passphrase rejected', /Wrong passphrase/.test(errMsg ?? ''), errMsg);
  check(
    'still on /login after failure',
    new URL(page.url()).pathname === '/login',
    page.url()
  );
  await page.screenshot({ path: path.join(OUT, 'login-error.png'), fullPage: false });

  await page.fill('#login-pass', USER_PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.account-card', { timeout: 30000 });
  check('correct passphrase → /account', page.url().includes('/account'), page.url());
  const reTitle = (await page.locator('.auth-title').textContent())?.trim();
  check('re-login shows same handle', reTitle === `@${USER_HANDLE}`, reTitle);

  check('no browser JS errors (whole run)', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('script ran without exception', false, String(err));
} finally {
  await browser.close();
  // Clean up every test row so the dev DB stays pristine — except real
  // entries (e.g. the operator's own signup), which are left untouched.
  // Also force-release any lockdown a crashed run might have left engaged.
  try {
    const client = new pg.Client({
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://postgres:postgres@localhost:5432/hackersdigest',
      connectionTimeoutMillis: 3000,
    });
    await client.connect();
    await client.query('DELETE FROM auth_challenges WHERE handle IN ($1, $2)', [
      USER_HANDLE,
      ADMIN_HANDLE,
    ]);
    await client.query('DELETE FROM accounts WHERE handle IN ($1, $2)', [
      USER_HANDLE,
      ADMIN_HANDLE,
    ]);
    await client.query('DELETE FROM waitlist WHERE email IN ($1, $2)', [
      USER_EMAIL,
      ADMIN_EMAIL,
    ]);
    await client.query(
      'UPDATE site_state SET locked = false, locked_at = NULL, locked_by = NULL WHERE id = 1'
    );
    await client.end();
    console.log('cleaned up test rows + released any lockdown');
  } catch (err) {
    console.log(`cleanup skipped (${err.message})`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
