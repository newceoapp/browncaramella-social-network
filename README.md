# HackersDigest — front page

Landing page for **HackersDigest**, an end-to-end encrypted social network for
hackers. Node.js + React, PostgreSQL for storage.

The design rule that shapes the data layer: *the server stores ciphertext and
routing metadata — never plaintext.* The landing page itself follows the same
ethics: zero cookies, zero trackers, zero third-party requests (including
fonts).

## Stack

- **React 18 + Vite** — SPA front page (`src/`)
- **Express** — API + static serving in production (`server/`)
- **PostgreSQL** — waitlist today; sealed `posts` table prepared for the feed
  (`db/schema.sql`)
- No CSS framework, no external assets — one stylesheet (`src/styles.css`)

## Quickstart

```bash
npm install

# Database (system-wide PostgreSQL 18 — installed via winget, service
# "postgresql-x64-18", superuser password "postgres", port 5432):
npm run db:init                    # create "hackersdigest" + apply db/schema.sql

npm run dev                        # API on :3001, Vite on :5173 (proxies /api)
```

No system PostgreSQL? `node scripts/dev-db.mjs` boots an embedded one on the
same port instead (`npm i --no-save embedded-postgres` first; it steps aside
automatically when the system service is already running).

Open http://localhost:5173.

Production build:

```bash
npm run build && npm start         # Express serves dist/ + API on :3001
```

Configuration lives in `.env` (copy from `.env.example`):

```
PORT=3001
DATABASE_URL=postgres://postgres:postgres@localhost:5432/hackersdigest
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API + Vite dev server together |
| `npm run build` | Production bundle into `dist/` |
| `npm start` | Serve API + `dist/` from Express |
| `npm run db:init` | Create the database if missing, apply `db/schema.sql` |
| `node scripts/dev-db.mjs` | Embedded PostgreSQL fallback (skips if :5432 is taken) |
| `npm run smoke` | 15-check end-to-end test (waitlist API) against an embedded PG |
| `npm run smoke-auth` | 20-check auth test (register/login/session lifecycle) against an embedded PG |
| `npm run smoke-admin` | 39-check admin test (approval queue + kill-switch lifecycle) against an embedded PG |
| `npm run shoot` | Browser checks: renders, overflow, waitlist → approval → register → login, admin dashboard, kill-switch round-trip + screenshots into `shots/` |

`smoke`, `smoke-auth`, `smoke-admin` and `shoot` need dev-only extras that
are not part of the stack:
`npm install --no-save embedded-postgres playwright-core`.

## API

| Route | Behavior |
| --- | --- |
| `GET /api/health` | `{ ok, db: "up"\|"down", uptime }` |
| `GET /api/stats` | `{ db, signups, posts }` — degrades to `null` counts when the DB is down |
| `POST /api/waitlist` | `{ email, handle? }` → `201 { position, status }` where `status` is `pending` (awaiting manual approval) or `approved` (admin handle only); `409` duplicate carries the current `status` so returning visitors learn where they stand; `400` validation; `503 site_locked` during lockdown |
| `POST /api/auth/register` | `{ email, handle, publicKey, keyBackup, proof }` → `201` + session; invite-gated: the email must be on the waitlist **and approved** (`403 not_invited` / `403 not_approved`); proof must be a valid signature over `hd-auth-v1:register:<email>:<handle>` |
| `POST /api/auth/challenge` | `{ handle }` → `200 { nonce, keyBackup }`, `404` unknown handle — hands out the passphrase-sealed key backup for the client to unlock locally |
| `POST /api/auth/login` | `{ handle, nonce, signature }` → `200` + session; the signature must verify against the stored public key over `hd-auth-v1:<nonce>`; nonces are single-use with a 2-minute TTL |
| `GET /api/auth/me` | Session probe → `200 { account }` or `200 { account: null }` (anonymous is not an error) |
| `POST /api/auth/logout` | Deletes the session row, clears the cookie → `200` |

## Account management

| Route | Behavior |
| --- | --- |
| `POST /api/account/passphrase` | Re-seal the key backup with a new passphrase. Body: `{ keyBackup }`. Requires session. |
| `POST /api/account/rotate-key` | Rotate signing + encryption keys. Body: `{ publicKey, encryptionPublicKey, keyBackup, proof }` where `proof` signs `hd-auth-v1:rotate:<handle>`. Requires session. |
| `GET /api/account/export` | Plaintext dump of the session account's data (profile, sessions, posts, waitlist entry). Client seals it with the passphrase. Requires session. |
| `GET /api/account/sessions` | List active sessions (created/expires, user agent, IP, current flag). Requires session. |
| `DELETE /api/account/sessions/:tokenHash` | Revoke a session. Requires session; session must belong to the account. → `204`. |
| `DELETE /api/account` | Delete the account and all its sessions. Clears the session cookie. → `200 { ok }`. Requires session. |

## Rate limiting

`POST /api/waitlist`, `POST /api/auth/register`, `POST /api/auth/challenge`,
and `POST /api/auth/login` are rate limited per IP (default: 60 requests per
60-second window, configurable via `RATE_LIMIT_MAX` and
`RATE_LIMIT_WINDOW_MS`). Responses include `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` headers; excess
requests get `429`.

## Contacts (social graph)

| Route | Behavior |
| --- | --- |
| `GET /api/directory?q=search&limit=20` | Search handles by prefix. Returns `{ results: [{ handle, fingerprint }] }`. Requires session. Excludes self. |
| `POST /api/contacts` | Send a contact request: `{ target_handle }` → `201 { contact }`. `409` if already exists, `404` unknown handle, `400` self-contact. Requires session. |
| `GET /api/contacts?status=pending|accepted|blocked` | List contacts. Requires session. |
| `GET /api/contacts/requests` | List pending incoming contact requests. Requires session. |
| `POST /api/contacts/:id/accept` | Accept a pending request → `200 { ok }`. Requires session; request must be addressed to the session account. |
| `POST /api/contacts/:id/block` | Block a contact or pending request → `200 { ok }`. Requires session. Blocked contacts cannot send posts. |

Contacts use compound IDs `requester_id:target_id` in URLs.

## Encrypted feed

| Route | Behavior |
| --- | --- |
| `GET /api/accounts/:handle/fingerprint` | Resolve a handle to its fingerprint + encryption public key (base64 SPKI DER). Public — no session needed. |
| `POST /api/posts` | Create a sealed post. Body: `{ recipient, ciphertext, nonce, ephemeral, wrapped_key, wrap_iv }` → `201 { id }`. Requires session; `503` during lockdown; `400` for bad inputs, unknown recipient, or blocked contact. |
| `GET /api/feed?before=cursor&limit=50&contacts_only=true` | Feed for the session account: posts addressed to it or authored by it, newest first. With `contacts_only=true`, only posts exchanged with accepted contacts. Returns `{ posts, nextCursor }`. Requires session. |
| `GET /api/posts/:id` | Single post. Accessible only to its author or recipient. Requires session. |
| `DELETE /api/posts/:id` | Delete a post — author only → `204`. Requires session. |

## Admin & approvals

One operator account: whoever registers the handle **`evobugz`** (override
with `ADMIN_HANDLE` in `.env`) is the admin. There is no role table and no
elevation path — admin powers come from holding that handle's key.

**Approvals are manual.** Waitlist signups land as `pending`; the operator
approves or rejects each one from `/admin`. Only `approved` emails may
register. (The admin handle's own waitlist signup is auto-approved —
somebody has to bootstrap the queue.)

| Route | Behavior |
| --- | --- |
| `GET /api/admin/overview` | Queue counts by status, accounts, live sessions, posts, lockdown state — admin session required |
| `GET /api/admin/waitlist?status=pending` | The approval queue, newest first |
| `POST /api/admin/waitlist/:id/approve` | Approve one request (records `decided_by` and audit log entry) |
| `POST /api/admin/waitlist/:id/reject` | Reject one request (records `decided_by` and audit log entry) |
| `POST /api/admin/waitlist/:id/notes` | Add/update notes on a waitlist entry: `{ notes }` → `200 { entry }`. Records audit log entry. |
| `POST /api/admin/waitlist/bulk` | Bulk approve/reject: `{ ids: [], action: "approve"|"reject" }` → `200 { updated }`. Records one audit log entry per entry. |
| `GET /api/admin/audit-log?limit=50` | Append-only admin action history: actor, action, target handle/email, timestamp. Requires session. |
| `GET /api/admin/export` | Full plaintext dump of every table — the kill-switch payload |
| `POST /api/admin/lockdown` | Engage the kill-switch (records audit log entry) |
| `POST /api/admin/unlock` | Release it (records audit log entry) |

Every `/api/admin/*` route requires a session whose handle is the admin;
anyone else gets `401`/`403`.

### The kill-switch

From `/admin`, the operator enters a passphrase and clicks **Seal export &
lock down site**. The browser then:

1. downloads the full data export over the admin session,
2. seals it **client-side** (PBKDF2-SHA256 250k → AES-256-GCM, same scheme
   as key backups) — the server never sees the passphrase and cannot open
   the file,
3. hands the operator the sealed `.json` as a download,
4. only then asks the server to engage lockdown.

While locked: waitlist signups, registrations, and logins all return
`503 site_locked` — except the admin's own login, so the operator can always
get back in to release the lockdown. `GET /api/stats` reports `locked`, and
the front page's stats bar shows it.

The API is designed to **degrade gracefully**: if PostgreSQL is unreachable the
server boots anyway, retries every 15s, and the page shows honest status
(`postgres: offline`) instead of breaking.

## Authentication

Accounts are **keypair challenge-response (Ed25519)** — the server never sees
a password, because there is none:

1. **Registration is invite-gated by the waitlist.** The client generates an
   Ed25519 keypair in the browser (WebCrypto), signs
   `hd-auth-v1:register:<email>:<handle>` as proof of possession, and sends the
   public key plus a passphrase-sealed backup of the private key
   (PKCS#8 → PBKDF2-SHA256 250k iterations → AES-256-GCM). The server stores
   both as-is; it cannot open the sealed blob.
2. **Login is a challenge-response.** The client asks for a nonce (which also
   returns the sealed backup), unlocks it locally with the passphrase, signs
   `hd-auth-v1:<nonce>`, and posts the signature. A wrong passphrase dies
   client-side — the server never learns it. Nonces are single-use, 2-minute
   TTL, so replays fail.
3. **Sessions** are random base64url tokens in an `HttpOnly; SameSite=Lax`
   cookie. Only `sha256(token)` is stored, TTL 7 days, so a database leak
   yields no usable cookies.

The private key never leaves the device unencrypted; the only server-side copy
is ciphertext it has no key for. Losing the passphrase loses the account —
stated on the register page, by design.

## Database

`db/schema.sql` (PostgreSQL 13+):

- `waitlist` — the only plaintext the app writes: email, handle, timestamp,
  plus `status` (pending/approved/rejected) for the manual approval queue.
  Also the invite list: `accounts.email` has a foreign key to it.
- `accounts` — handle, email, public key (SPKI DER), fingerprint, sealed
  key backup (opaque JSONB blob)
- `auth_challenges` — single-use login nonces, short TTL
- `sessions` — `sha256(token)` only, never the token itself
- `site_state` — single row; `locked` is the kill-switch flag
- `posts` — the future feed: `ciphertext BYTEA` + `nonce` + key fingerprints,
  the pattern the whole product is built on

## Project layout

```
db/schema.sql        DDL
server/index.js      Express app (API + static + auth routes)
server/auth.js       auth protocol helpers (signatures, fingerprints, cookies)
server/db.js         pg pool, schema bootstrap, queries
server/create-db.js  npm run db:init
src/crypto.js        shared client crypto (Ed25519, sealed key backup/export)
src/auth.jsx         AuthProvider session context
src/pages/           Landing, Register, Login, Account, Admin
src/components/      Nav, Hero, Terminal, StatsBar, Features, HowItWorks, Waitlist, Footer
src/styles.css       all styling
scripts/             dev-db, smoke tests, browser checks
```

## Not built yet (on purpose)

There is real auth now — keypairs, challenge-response login, sessions — and the
encrypted feed is wired: posts are sealed client-side (AES-256-GCM content key,
wrapped to the recipient's X25519 key via ECDH + HKDF-SHA256) and the server
stores ciphertext only. Account management is wired: passphrase change, key
rotation, self-export, session list/revoke, and account deletion. What remains
is social graph (contacts, directory) and a global/public feed (needs
out-of-band group key distribution).
