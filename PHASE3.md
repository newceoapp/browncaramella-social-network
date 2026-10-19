# HackersDigest — Phase 3 Plan

**Social Graph, Admin Upgrades, Ops & Polish**

Builds on Phase 1 (encrypted feed) and Phase 2 (account management), both complete
and tested (smoke: 15/15, smoke-auth: 20/20, smoke-admin: 39/39, smoke-feed: 21/21,
smoke-account: 24/24, `npm run build` green).

---

## Execution order (recommended)

1. **Track C — Operations & Reliability** (first)
   Makes everything else safer to ship; standardizes deployment.
2. **Track A — Social Graph & Contacts**
   Core product feature: turns 1:1 posts into a network.
3. **Track B — Admin Tooling Upgrades**
   Operator quality-of-life; meaningful once there are users to manage.
4. **Track D — UX & Polish**
   Polish on top of working features.

Tracks can be scoped independently; only Track C has hard prerequisites (none).

---

## Track C — Operations & Reliability

### Goal
Rate limiting, structured logging, Docker, CI, and a disaster-recovery path so the
app is safe to run and easy to reproduce.

### Database
No schema changes required.

### API
- Rate limiting (in-memory sliding window per IP + route) on:
  - `POST /api/auth/challenge`
  - `POST /api/auth/login`
  - `POST /api/auth/register`
  - `POST /api/waitlist`
- `429 Too Many Requests` with `Retry-After` when exceeded.

### Logging
- Structured JSON logs: timestamp, level, route, handle (if session), status, latency.
- Never log passphrases, private keys, signatures, or sealed backup contents.

### Docker
- `Dockerfile` — multi-stage: build frontend with Vite, run `node server/index.js`.
- `docker-compose.dev.yml` — app + PostgreSQL for local development.
- `.dockerignore` excluding `node_modules/`, `dist/`, `.env`, `shots/`.

### CI (GitHub Actions)
- `npm run build`
- All five smoke suites against embedded PostgreSQL.
- Lint if eslint is added later.

### Disaster recovery
- `scripts/restore.mjs` — takes a sealed kill-switch export JSON + operator passphrase,
  restores all tables into a fresh database (rebuild after total loss).

### Definition of done
- [ ] Rate limiting returns 429 on the four write/auth routes.
- [ ] Structured JSON logging active (no secrets in logs).
- [ ] `Dockerfile` builds; `docker-compose.dev.yml` spins up app + PG.
- [ ] CI workflow runs build + smoke suites on push/PR.
- [ ] `scripts/restore.mjs` restores a sealed export into a fresh DB.
- [ ] `npm run build` green; all five smoke suites still green.

---

## Track A — Social Graph & Contacts

### Goal
Users can find each other and build a contact list, so the feed is a social network
rather than isolated 1:1 posts.

### Database (additive, idempotent migrations)
```sql
CREATE TABLE IF NOT EXISTS contacts (
  requester_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_id    BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
               CONSTRAINT contacts_status_check CHECK (status IN ('pending','accepted','blocked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, target_id)
);
CREATE INDEX IF NOT EXISTS contacts_target_status_idx ON contacts (target_id, status);
CREATE INDEX IF NOT EXISTS contacts_requester_idx ON contacts (requester_id);
```

### API routes
- `GET /api/directory?q=search&limit=20` — handle-prefix search returning
  `{ handle, fingerprint }`. Login-required (prevents enumeration). Rate-limited.
- `POST /api/contacts` — `{ target_handle }` → creates pending request.
  `409` if already exists; `404` if unknown handle; `400` if self.
- `GET /api/contacts?status=pending|accepted|blocked` — my contact list.
- `POST /api/contacts/:id/accept` — accept pending → `accepted`.
- `POST /api/contacts/:id/block` → `blocked`; blocked users cannot send posts to you.

### Feed refinement
- `GET /api/feed?contacts_only=1&before=cursor&limit=50` — posts where:
  - authored by me, OR
  - addressed to me by an accepted contact, OR
  - authored by an accepted contact and addressed to me (mutual).

### UX
- `/directory` page: search + "Add contact" button.
- Contacts page: accepted / pending / blocked tabs.
- Nav badge: pending request count.
- Feed filter toggle: "All" vs "Contacts only".

### Definition of done
- [ ] `contacts` table migration (idempotent).
- [ ] Directory + contact CRUD routes documented in README.
- [ ] `/directory` and contacts pages in `src/pages/`.
- [ ] Feed `contacts_only` filter.
- [ ] New smoke test `scripts/smoke-contacts.mjs` (real server + real PG).
- [ ] `npm run build` green; all prior suites still green.

### Open decisions
- Mutual vs one-way contacts: recommend **mutual** (both accept).
- Directory public or login-required: recommend **login-required**.

---

## Track B — Admin Tooling Upgrades

### Goal
Operator gets notes, bulk actions, and an audit trail without breaking the
single-operator model (admin = holder of `ADMIN_HANDLE` key).

### Database (additive, idempotent migrations)
```sql
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE TABLE IF NOT EXISTS admin_actions (
  id          BIGSERIAL PRIMARY KEY,
  actor_handle TEXT NOT NULL,
  action      TEXT NOT NULL,           -- approve | reject | notes | bulk_approve | bulk_reject | lockdown | unlock
  target_handle TEXT,
  target_email  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC);
```

### API routes
- `POST /api/admin/waitlist/:id/notes` — `{ notes }` → updates `notes`; records in `admin_actions`.
- `POST /api/admin/waitlist/bulk` — `{ ids: [], action: "approve"|"reject" }` → processes all,
  records each in `admin_actions`.
- `GET /api/admin/audit-log?limit=50&before=` — paginated admin action history.

### UX
- Notes field on each queue row in `/admin`.
- Bulk select + approve/reject buttons.
- Audit log tab in `/admin`.

### Definition of done
- [ ] `waitlist.notes` + `admin_actions` migrations (idempotent).
- [ ] Notes + bulk + audit-log routes documented in README.
- [ ] `/admin` UI updated (notes, bulk, audit log).
- [ ] New smoke test for admin upgrades (real server + real PG).
- [ ] `npm run build` green; all prior suites still green.

---

## Track D — UX & Polish

### Goal
Product-grade feel on top of working features.

### Changes
- Replace or supplement the Terminal demo: link `/feed` and `/compose` as the real
  "try it" destinations (keep Terminal as a feature illustration if desired).
- Unread indicators on feed rows (posts created since last visit).
- Empty states with clear CTAs on feed/compose.
- Mobile layout refinements for compose and feed.
- Accessibility audit: focus management, ARIA labels, reduced-motion (already supported).
- Loading skeletons instead of blank states during data fetch.

### Definition of done
- [ ] Feed/compose feel polished on desktop and mobile.
- [ ] Unread indicators working.
- [ ] Accessibility review passed (keyboard navigation, ARIA, reduced motion).
- [ ] `npm run build` green; all prior suites still green.

---

## Global definition of done (every track)

- [ ] Schema migrations are additive and idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- [ ] New API routes documented in `README.md` API table.
- [ ] Client UI under `src/pages/` or `src/components/`.
- [ ] New smoke checks in `scripts/smoke-*.mjs` using real server + real PG and importing `src/crypto.js`.
- [ ] `npm run build` green.
- [ ] All five existing smoke suites still green.

---

## Notes for implementation

- The server already degrades gracefully when PostgreSQL is down; new routes should
  follow the same pattern (try/catch → `503 storage_unavailable`).
- All API responses use camelCase; DB rows are snake_case (see existing `postShape`,
  `accountShape` helpers).
- Sessions remain `sha256(token)` in HttpOnly SameSite=Lax cookies; no password
  verifiers exist anywhere.
- The kill-switch (`/api/admin/lockdown`) still blocks public writes including posts;
  admin routes remain gated to `ADMIN_HANDLE`.
