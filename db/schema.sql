-- HackersDigest schema (PostgreSQL 13+)
--
-- Design rule: the server stores ciphertext plus the minimum routing metadata
-- needed to deliver it. No plaintext content ever touches this database.

-- Beta queue: the only plaintext the front page writes. Entries start
-- 'pending'; the operator approves each one by hand from /admin. The admin
-- handle's own signup is auto-approved (see addWaitlist).
CREATE TABLE IF NOT EXISTS waitlist (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  handle     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending'
             CONSTRAINT waitlist_status_check CHECK (status IN ('pending','approved','rejected')),
  decided_at TIMESTAMPTZ,
  decided_by TEXT,                       -- handle of the operator who decided
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_email_key UNIQUE (email),
  CONSTRAINT waitlist_handle_key UNIQUE (handle)
);

-- Migration for databases created before the approval workflow existed.
-- Must run BEFORE the status index below (idempotent on fresh installs).
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON waitlist (created_at DESC);
CREATE INDEX IF NOT EXISTS waitlist_status_idx ON waitlist (status, created_at);

-- Site-wide state: a single row (id = 1). 'locked' is the kill-switch —
-- while true, the public site refuses all writes; only the admin can
-- (log in and) release it.
CREATE TABLE IF NOT EXISTS site_state (
  id        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  locked    BOOLEAN NOT NULL DEFAULT false,
  locked_at TIMESTAMPTZ,
  locked_by TEXT
);

INSERT INTO site_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Admin audit log: append-only record of every operator action
-- (approve, reject, notes, bulk_approve, bulk_reject, lockdown, unlock).
CREATE TABLE IF NOT EXISTS admin_actions (
  id           BIGSERIAL PRIMARY KEY,
  actor_handle TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_handle TEXT,
  target_email  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_actor_idx ON admin_actions (actor_handle);

-- Accounts: public identity only. The server stores the Ed25519 signing key
-- plus an X25519 encryption key, and a passphrase-sealed backup of both
-- private keys — a blob the server cannot open. No password verifier exists
-- anywhere.
CREATE TABLE IF NOT EXISTS accounts (
  id             BIGSERIAL PRIMARY KEY,
  handle         TEXT NOT NULL,
  email          TEXT NOT NULL,
  public_key     BYTEA NOT NULL,        -- SPKI DER (Ed25519)
  fingerprint    TEXT NOT NULL,         -- sha256(public_key), hex — display only
  encryption_key BYTEA,                 -- SPKI DER (X25519) — sealed into key_backup
  key_backup     JSONB NOT NULL,        -- PBKDF2 + AES-GCM sealed pkcs8 (signing + encryption keys)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_handle_key UNIQUE (handle),
  CONSTRAINT accounts_email_key UNIQUE (email),
  CONSTRAINT accounts_email_fkey FOREIGN KEY (email)
    REFERENCES waitlist (email) ON DELETE RESTRICT
);

-- Migration for databases created before the encryption_key column existed.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS encryption_key BYTEA;

-- Single-use login challenges (short TTL). The nonce is random; signing it
-- proves possession of the private key without transmitting it.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id         BIGSERIAL PRIMARY KEY,
  handle     TEXT NOT NULL,
  nonce      BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_challenges_lookup_idx
  ON auth_challenges (handle, expires_at DESC);

-- Sessions: only sha256(token) is stored, so a database leak does not
-- yield usable session cookies. user_agent/ip_address are captured at
-- creation time for the session list UI.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash BYTEA PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_agent TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Migration for databases created before the session metadata columns.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address TEXT;

CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

-- Published posts: sealed payload + routing metadata only.
CREATE TABLE IF NOT EXISTS posts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_key  TEXT NOT NULL,      -- author's public key fingerprint
  recipient   TEXT NOT NULL,      -- recipient fingerprint (or feed id)
  ciphertext  BYTEA NOT NULL,     -- sealed payload; the server cannot read it
  nonce       BYTEA NOT NULL,     -- AES-GCM nonce for ciphertext
  ephemeral_key BYTEA,            -- sender's ephemeral X25519 pubkey (SPKI DER)
  wrapped_key   BYTEA,            -- content key wrapped to recipient via ECDH
  wrap_iv       BYTEA,            -- AES-GCM IV used to wrap the content key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for databases created before the ephemeral/wrapped key columns.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS ephemeral_key BYTEA;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS wrapped_key BYTEA;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS wrap_iv BYTEA;

CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_recipient_idx ON posts (recipient);

-- Social graph: contact requests between accounts. Mutual by design — both
-- parties must accept before the relationship is "accepted". Blocked contacts
-- cannot send posts to each other.
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
