# Deploying HackersDigest to Botkeep.cloud

## Overview

Botkeep.cloud is a free hosting platform (512 MB RAM, 50% CPU, 1 GB storage,
one server slot on the free tier). It deploys Node.js apps from GitHub or ZIP,
runs `npm start`, and you configure environment variables in its panel.

## Prerequisites

- A Botkeep.cloud account (sign in at https://botkeep.cloud/)
- A GitHub account (for GitHub deployment) or ability to create a ZIP archive

## Important limitation — free tier database slots

On Botkeep's free tier you get **one server slot**. Provisioning a PostgreSQL
database from Botkeep's catalog occupies that slot, which means you may not be
able to run both the Node.js app **and** Botkeep-hosted PostgreSQL on the free
tier simultaneously.

**Workarounds:**
1. **Upgrade** to a paid plan that allows multiple servers.
2. **Use an external PostgreSQL** (Neon, Supabase, Railway, etc.) and host only
   the Node.js app on Botkeep's free tier. Set `DATABASE_URL` to the external
   PostgreSQL connection string.
3. **Run both on one server** — if Botkeep allows co-locating the app and
   database on the same server instance, this works within the free tier.

## Step 1: Prepare the code for deployment

The repository is ready for deployment as-is. Key files:

| File | Purpose |
|------|---------|
| `package.json` | `npm start` = `node server/index.js` (Botkeep-compatible) |
| `server/index.js` | Listens on `SERVER_PORT` (Botkeep convention), falls back to `PORT` |
| `dist/` | Committed production frontend bundle (served by Express) |
| `.gitignore` | Excludes `node_modules/`, `.env`, `*.log`, `.tmp-pgdata/`, `shots/` |
| `db/schema.sql` | Auto-applied on boot via `initSchema()` (idempotent) |

## Step 2: Push code to GitHub

If you have git available locally:

```bash
cd C:\Users\hello\Documents\hackersdigest
git init
git add .
git commit -m "Initial commit: encrypted feed + account management"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOURUSER/hackersdigest.git
git branch -M main
git push -u origin main
```

If you don't have git locally, use GitHub's web interface to create a repo and
upload the project files as a ZIP, or create a ZIP locally and upload it
directly to Botkeep (see Botkeep's "Deploy from a ZIP archive" guide).

## Step 3: Provision PostgreSQL on Botkeep

1. Log in to https://botkeep.cloud/
2. Go to the **Databases** section
3. Choose **PostgreSQL** from the catalog
4. Note the connection details (host, port, database name, user, password)
5. Build your `DATABASE_URL`:
   ```
   postgres://<user>:<password>@<host>:<port>/<database>
   ```

If using an external PostgreSQL instead, skip this and use that provider's
connection string.

## Step 4: Create the Node.js app on Botkeep

1. Go to **Apps** → Create new application
2. Choose **Node.js** runtime
3. Connect your GitHub repository (or upload ZIP)
4. **Start command**: `npm start`
5. **Node version**: Select a current LTS version (20+)
6. Review resource allocation (stay within your plan budget)
7. Create the app

## Step 5: Configure environment variables

In the Botkeep panel, go to your app's **Environment** / **Secrets** section
and add:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `postgres://...` | From Step 3 (Botkeep DB or external) |
| `SERVER_PORT` | `3001` | Botkeep assigns this; set to match their assignment |
| `ADMIN_HANDLE` | `evobugz` | The operator handle (whoever registers this becomes admin) |

Do **not** add `PORT` — Botkeep uses `SERVER_PORT`. The server falls back to
`PORT` then `3001` if `SERVER_PORT` is absent.

## Step 6: Configure domains (for HTTPS)

1. In the Botkeep panel, go to **Domains** / **Network**
2. Assign a domain to your app
3. Botkeep handles HTTPS/TLS termination
4. Your app listens on `0.0.0.0:SERVER_PORT` (already configured)

## Step 7: Deploy and verify

1. Trigger the deployment (automatic on GitHub push, or manual on ZIP upload)
2. Check the **Console** in the Botkeep panel for build/runtime output
3. Wait for `[api] listening on http://0.0.0.0:PORT` and `[db] connected`
4. Visit your domain — you should see the HackersDigest landing page

## Step 8: Bootstrap the operator account

The admin is whoever registers the handle `evobugz` (configurable via
`ADMIN_HANDLE`). The waitlist auto-approves this handle, so:

1. Visit your deployed site
2. Click **Request access** → join the waitlist with:
   - Email: any address
   - Handle: `evobugz` (or your `ADMIN_HANDLE`)
3. The entry is auto-approved → click **Claim your account now**
4. Register with your Ed25519 keys + passphrase
5. You're now the operator — the **Operator console** link appears in your
   Account page and the Nav

## Step 9: Post-deployment operations

- **Approvals**: Visit `/admin` to approve/reject waitlist requests
- **Kill-switch**: From `/admin`, seal the full DB export and lock down the site
- **Passphrase change**: From `/account`, re-seal your key backup with a new passphrase
- **Key rotation**: From `/account`, generate new signing + encryption keys
- **Export my data**: From `/account`, download your sealed data export
- **Session management**: From `/account`, view and revoke active sessions

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| App crashes on boot | `DATABASE_URL` missing or wrong | Check Environment variables in Botkeep panel |
| Frontend shows 404 | `dist/` not deployed | Ensure `dist/` is committed (not in .gitignore) |
| Can't register | Waitlist not approved | Join waitlist first, wait for approval |
| Not admin | Wrong handle | Register with `ADMIN_HANDLE` (`evobugz` by default) |
| 503 site_locked | Kill-switch engaged | Only the admin can release via `/admin` |

## File changes made for Botkeep compatibility

- `server/index.js`: Listen on `SERVER_PORT` env var (Botkeep convention), bind to `0.0.0.0`
- `.gitignore`: `dist/` is now tracked (production frontend bundle)
- `.env.example`: Documents `SERVER_PORT` for Botkeep

## Reverting local .env

If you created a local `.env` for development, it is gitignored and will not be
uploaded. Botkeep uses its own Environment panel for secrets.
