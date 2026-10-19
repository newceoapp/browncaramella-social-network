import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import {
  fingerprintOfB64,
  generateEncryptionIdentity,
  generateIdentity,
  exportPublicKeyB64,
  exportEncryptionPublicKeyB64,
  openKeyBackup,
  sealKeyBackup,
  sealJSON,
  signMessage,
} from '../crypto.js';

export default function Account() {
  const { account, encryptionKey, loading, logout, setEncryptionKey } = useAuth();
  const navigate = useNavigate();

  const [encFingerprint, setEncFingerprint] = useState(null);

  // Passphrase change
  const [passStatus, setPassStatus] = useState('idle');
  const [passMessage, setPassMessage] = useState(null);
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPass2, setNewPass2] = useState('');

  // Key rotation
  const [rotStatus, setRotStatus] = useState('idle');
  const [rotMessage, setRotMessage] = useState(null);
  const [rotPass, setRotPass] = useState('');

  // Export
  const [expStatus, setExpStatus] = useState('idle');
  const [expMessage, setExpMessage] = useState(null);
  const [expPass, setExpPass] = useState('');

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [sessStatus, setSessStatus] = useState('idle');
  const [sessMessage, setSessMessage] = useState(null);

  if (loading) {
    return (
      <section className="auth-page">
        <div className="auth-card">
          <p className="auth-lede">Checking session…</p>
        </div>
      </section>
    );
  }

  if (!account) return <Navigate to="/login" replace />;

  useEffect(() => {
    if (!account.encryptionKey) {
      setEncFingerprint(null);
      return;
    }
    fingerprintOfB64(account.encryptionKey).then(setEncFingerprint);
  }, [account.encryptionKey]);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    setSessStatus('idle');
    const res = await apiFetch('/api/account/sessions');
    if (res.status === 200) {
      setSessions(res.data.sessions ?? []);
    } else {
      setSessStatus('error');
      setSessMessage('Could not load sessions.');
    }
  }

  async function onLogout() {
    navigate('/', { replace: true });
    await logout();
  }

  /* ---------- Passphrase change ---------- */
  async function onChangePassphrase(event) {
    event.preventDefault();
    if (passStatus === 'sending') return;
    setPassMessage(null);

    if (!curPass) {
      setPassStatus('error');
      setPassMessage('Enter your current passphrase.');
      return;
    }
    if (newPass.length < 8) {
      setPassStatus('error');
      setPassMessage('New passphrase needs at least 8 characters.');
      return;
    }
    if (newPass !== newPass2) {
      setPassStatus('error');
      setPassMessage('New passphrases do not match.');
      return;
    }

    setPassStatus('sending');
    try {
      // Verify current passphrase by opening the backup.
      let keys;
      try {
        keys = await openKeyBackup(account.keyBackup ?? {}, curPass);
      } catch {
        setPassStatus('error');
        setPassMessage('Current passphrase is incorrect.');
        return;
      }

      // Re-seal the same keys with the new passphrase.
      const newBackup = await sealKeyBackup(keys.signingKey, keys.encryptionKey, newPass);

      const res = await apiFetch('/api/account/passphrase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyBackup: newBackup }),
      });

      if (res.status === 200) {
        setPassStatus('done');
        setCurPass('');
        setNewPass('');
        setNewPass2('');
      } else {
        setPassStatus('error');
        setPassMessage('Passphrase change failed. Try again.');
      }
    } catch {
      setPassStatus('error');
      setPassMessage('Cannot reach the API. Is it running?');
    } finally {
      setPassStatus('idle');
    }
  }

  /* ---------- Key rotation ---------- */
  async function onRotateKeys(event) {
    event.preventDefault();
    if (rotStatus === 'sending') return;
    setRotMessage(null);

    if (!rotPass) {
      setRotStatus('error');
      setRotMessage('Enter your passphrase to authorize rotation.');
      return;
    }

    setRotStatus('sending');
    try {
      // Verify current passphrase by opening the backup.
      let keys;
      try {
        keys = await openKeyBackup(account.keyBackup ?? {}, rotPass);
      } catch {
        setRotStatus('error');
        setRotMessage('Passphrase is incorrect.');
        return;
      }

      // Generate new signing + encryption keypairs.
      const signingKeyPair = await generateIdentity();
      const encryptionKeyPair = await generateEncryptionIdentity();
      const publicKey = await exportPublicKeyB64(signingKeyPair);
      const encryptionPublicKey = await exportEncryptionPublicKeyB64(encryptionKeyPair);

      // Seal new keys with the current passphrase.
      const newBackup = await sealKeyBackup(signingKeyPair.privateKey, encryptionKeyPair.privateKey, rotPass);

      // Proof of possession: sign the rotation statement with the new key.
      const proof = await signMessage(
        signingKeyPair.privateKey,
        new TextEncoder().encode(`hd-auth-v1:rotate:${account.handle}`)
      );

      const res = await apiFetch('/api/account/rotate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, encryptionPublicKey, keyBackup: newBackup, proof }),
      });

      if (res.status === 200) {
        setEncryptionKey(encryptionKeyPair.privateKey);
        setRotStatus('done');
        setRotPass('');
      } else {
        setRotStatus('error');
        setRotMessage('Key rotation failed. Try again.');
      }
    } catch {
      setRotStatus('error');
      setRotMessage('Cannot reach the API. Is it running?');
    } finally {
      setRotStatus('idle');
    }
  }

  /* ---------- Export my data ---------- */
  async function onExport() {
    if (expStatus === 'sending') return;
    if (!expPass) {
      setExpStatus('error');
      setExpMessage('Enter your passphrase to seal the export.');
      return;
    }

    setExpStatus('sending');
    setExpMessage(null);
    try {
      const res = await apiFetch('/api/account/export');
      if (res.status !== 200) {
        setExpStatus('error');
        setExpMessage('Export failed. Try again.');
        return;
      }

      const sealed = await sealJSON(res.data, expPass);
      const blob = new Blob([JSON.stringify(sealed, null, 2)], { type: 'application/json' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hackersdigest-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setExpStatus('done');
      setExpPass('');
    } catch {
      setExpStatus('error');
      setExpMessage('Export failed. Try again.');
    } finally {
      setExpStatus('idle');
    }
  }

  /* ---------- Session revocation ---------- */
  async function onRevokeSession(tokenHash) {
    setSessStatus('sending');
    const res = await apiFetch(`/api/account/sessions/${encodeURIComponent(tokenHash)}`, {
      method: 'DELETE',
    });
    if (res.status === 204) {
      await loadSessions();
      setSessStatus('idle');
    } else {
      setSessStatus('error');
      setSessMessage('Could not revoke session.');
    }
  }

  /* ---------- Delete account ---------- */
  async function onDeleteAccount() {
    if (!window.confirm('Delete your account? This cannot be undone. All your data will be removed.')) return;
    if (!window.confirm('Type DELETE to confirm.')) return;
    // Second confirmation handled inline below via prompt
    const confirm = window.prompt('Type DELETE to permanently delete your account:');
    if (confirm !== 'DELETE') return;

    const res = await apiFetch('/api/account', { method: 'DELETE' });
    if (res.status === 200) {
      await logout();
      navigate('/', { replace: true });
    } else {
      setSessStatus('error');
      setSessMessage('Account deletion failed.');
    }
  }

  const since = account.createdAt
    ? new Date(account.createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '—';

  const currentSession = sessions.find((s) => s.current);

  return (
    <section className="auth-page">
      <div className="auth-card account-card">
        <span className="kicker">// identity</span>
        <h1 className="auth-title">@{account.handle}</h1>

        <div className="account-grid">
          <div className="account-row">
            <span>key fingerprint</span>
            <b className="mono accent">{account.fingerprint}</b>
          </div>
          {account.encryptionKey && (
            <div className="account-row">
              <span>encryption fingerprint</span>
              <b className="mono accent">{encFingerprint ?? '—'}</b>
            </div>
          )}
          <div className="account-row">
            <span>email</span>
            <b>{account.email}</b>
          </div>
          <div className="account-row">
            <span>member since</span>
            <b>{since}</b>
          </div>
          <div className="account-row">
            <span>session</span>
            <b className="accent">active · httpOnly cookie</b>
          </div>
        </div>

        <div className="key-block">
          <span className="field-label">public key · Ed25519 · SPKI base64</span>
          <pre>{account.publicKey}</pre>
        </div>

        <p className="auth-note">
          Your private key exists only as a backup sealed with your passphrase
          — the server stores the ciphertext and cannot read it. Lose the
          passphrase and the key is gone: by design, not by policy.
        </p>

        {/* ---------- Change passphrase ---------- */}
        <div className="account-card">
          <h2 className="account-section">// change passphrase</h2>
          <form className="form form-col" onSubmit={onChangePassphrase} noValidate>
            <label className="field-label" htmlFor="acct-cur-pass">
              Current passphrase
            </label>
            <input
              className="input"
              id="acct-cur-pass"
              type="password"
              value={curPass}
              onChange={(e) => setCurPass(e.target.value)}
              autoComplete="current-password"
              required
            />
            <label className="field-label" htmlFor="acct-new-pass">
              New passphrase
            </label>
            <input
              className="input"
              id="acct-new-pass"
              type="password"
              placeholder="at least 8 characters"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              autoComplete="new-password"
              required
            />
            <label className="field-label" htmlFor="acct-new-pass2">
              Repeat new passphrase
            </label>
            <input
              className="input"
              id="acct-new-pass2"
              type="password"
              placeholder="…"
              value={newPass2}
              onChange={(e) => setNewPass2(e.target.value)}
              autoComplete="new-password"
              required
            />
            <button
              className="btn btn-primary form-btn"
              type="submit"
              disabled={passStatus === 'sending'}
            >
              {passStatus === 'sending' ? 'Re-sealing…' : 'Change passphrase'}
            </button>
          </form>
          {passStatus === 'error' && passMessage && (
            <p className="msg msg-err" role="alert">✗ {passMessage}</p>
          )}
          {passStatus === 'done' && (
            <p className="msg msg-ok" role="status">
              ✓ Passphrase changed. Key backup re-sealed with the new passphrase.
            </p>
          )}
        </div>

        {/* ---------- Rotate keys ---------- */}
        <div className="account-card">
          <h2 className="account-section">// rotate keys</h2>
          <p className="auth-note">
            Generates a new Ed25519 signing key and X25519 encryption key,
            re-seals both with your passphrase, and updates the server.
            Posts sealed to your old encryption key will no longer be
            decryptable.
          </p>
          <form className="form form-col" onSubmit={onRotateKeys} noValidate>
            <label className="field-label" htmlFor="acct-rot-pass">
              Passphrase (authorize rotation)
            </label>
            <input
              className="input"
              id="acct-rot-pass"
              type="password"
              value={rotPass}
              onChange={(e) => setRotPass(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              className="btn btn-primary form-btn"
              type="submit"
              disabled={rotStatus === 'sending'}
            >
              {rotStatus === 'sending' ? 'Rotating keys…' : 'Rotate keys'}
            </button>
          </form>
          {rotStatus === 'error' && rotMessage && (
            <p className="msg msg-err" role="alert">✗ {rotMessage}</p>
          )}
          {rotStatus === 'done' && (
            <p className="msg msg-ok" role="status">
              ✓ Keys rotated. New encryption key is active on this device.
            </p>
          )}
        </div>

        {/* ---------- Export ---------- */}
        <div className="account-card">
          <h2 className="account-section">// export my data</h2>
          <p className="auth-note">
            Downloads your account data (profile, sessions, posts, waitlist
            entry) sealed with your passphrase. The server never sees your
            passphrase.
          </p>
          <form className="form form-col" onSubmit={(e) => { e.preventDefault(); onExport(); }} noValidate>
            <label className="field-label" htmlFor="acct-exp-pass">
              Export passphrase
            </label>
            <input
              className="input"
              id="acct-exp-pass"
              type="password"
              placeholder="…"
              value={expPass}
              onChange={(e) => setExpPass(e.target.value)}
              autoComplete="new-password"
              required
            />
            <button
              className="btn btn-primary form-btn"
              type="submit"
              disabled={expStatus === 'sending'}
            >
              {expStatus === 'sending' ? 'Sealing export…' : 'Download sealed export'}
            </button>
          </form>
          {expStatus === 'error' && expMessage && (
            <p className="msg msg-err" role="alert">✗ {expMessage}</p>
          )}
          {expStatus === 'done' && (
            <p className="msg msg-ok" role="status">✓ Sealed export downloaded.</p>
          )}
        </div>

        {/* ---------- Sessions ---------- */}
        <div className="account-card">
          <h2 className="account-section">// active sessions</h2>
          {sessStatus === 'error' && sessMessage && (
            <p className="msg msg-err" role="alert">✗ {sessMessage}</p>
          )}
          {sessions.length === 0 ? (
            <p className="auth-note">No active sessions found.</p>
          ) : (
            <ul className="admin-list">
              {sessions.map((s) => (
                <li className="admin-row" key={s.tokenHash}>
                  <div className="admin-row-info">
                    <b>{s.current ? 'current session' : 'session'}</b>
                    <span className="mono accent">…{s.tokenHashShort}</span>
                    <span className="admin-when">
                      started {new Date(s.createdAt).toLocaleString()} · expires {new Date(s.expiresAt).toLocaleString()}
                    </span>
                    <span>{s.userAgent}</span>
                    <span>{s.ipAddress}</span>
                  </div>
                  {!s.current && (
                    <div className="admin-row-actions">
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => onRevokeSession(s.tokenHash)}
                        disabled={sessStatus === 'sending'}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------- Delete account ---------- */}
        <div className="account-card account-card-danger">
          <h2 className="account-section">// delete account</h2>
          <p className="auth-note">
            Permanently deletes your account, all sessions, and all posts
            addressed to you or authored by you. This cannot be undone.
          </p>
          <button
            className="btn btn-danger form-btn"
            type="button"
            onClick={onDeleteAccount}
          >
            Delete my account
          </button>
        </div>

        <div className="account-actions">
          <button className="btn btn-ghost" type="button" onClick={onLogout}>
            Sign out
          </button>
          {account.isAdmin && (
            <Link className="btn btn-primary" to="/admin">
              Operator console
            </Link>
          )}
          <Link className="btn btn-primary" to="/#waitlist">
            Back to the front page
          </Link>
        </div>
      </div>
    </section>
  );
}
