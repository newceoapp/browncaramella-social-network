import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import { loginMessage, openKeyBackup, signMessage } from '../crypto.js';
const ERROR_MESSAGES = {
  unknown_handle: 'No account with that handle.',
  invalid_handle: 'Handles are 3–24 chars: letters, digits, underscore.',
  invalid_signature: 'Signature rejected — try again.',
  challenge_expired: 'That challenge expired — try again.',
  site_locked: 'The site is locked down right now — only the operator can log in.',
  storage_unavailable: 'Storage node unreachable — try again in a moment.',
};

export default function Login() {
  const { account, loading, refresh, setEncryptionKey } = useAuth();
  const navigate = useNavigate();

  const [handle, setHandle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | error
  const [message, setMessage] = useState(null);

  if (!loading && account) return <Navigate to="/account" replace />;

  async function onSubmit(event) {
    event.preventDefault();
    if (status === 'sending') return;
    setMessage(null);

    const cleanHandle = handle.trim().replace(/^@/, '');
    setStatus('sending');

    try {
      // 1. Ask for a challenge — the response carries the sealed key backup.
      const challenge = await apiFetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: cleanHandle }),
      });
      if (challenge.status === 404) {
        setStatus('error');
        setMessage(ERROR_MESSAGES.unknown_handle);
        return;
      }
      if (challenge.status !== 200) {
        setStatus('error');
        setMessage(ERROR_MESSAGES[challenge.data?.error] ?? 'Could not get a challenge.');
        return;
      }

      // 2. Unlock the backup locally. Wrong passphrase dies here, client-side.
      let privateKey;
      let encryptionKey;
      try {
        const keys = await openKeyBackup(challenge.data.keyBackup, passphrase);
        privateKey = keys.signingKey;
        encryptionKey = keys.encryptionKey;
      } catch (err) {
        setStatus('error');
        setMessage(
          err?.message === 'wrong_passphrase'
            ? 'Wrong passphrase.'
            : 'This browser cannot open the key backup (Ed25519/X25519 unsupported).'
        );
        return;
      }

      // 3. Sign the nonce — the private key itself never leaves this device.
      const signature = await signMessage(
        privateKey,
        loginMessage(challenge.data.nonce)
      );
      const login = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: cleanHandle,
          nonce: challenge.data.nonce,
          signature,
        }),
      });

      if (login.status === 200) {
        await refresh();
        if (encryptionKey) {
          setEncryptionKey(encryptionKey);
        }
        navigate('/account', { replace: true });
        return;
      }
      setStatus('error');
      setMessage(ERROR_MESSAGES[login.data?.error] ?? 'Login failed. Try again.');
    } catch {
      setStatus('error');
      setMessage('Cannot reach the API. Is it running?');
    }
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <span className="kicker">// prove you hold the key</span>
        <h1 className="auth-title">Log in</h1>
        <p className="auth-lede">
          No password goes over the wire. Your passphrase opens the sealed key
          backup <em>on this device</em>; the client then signs a one-time
          nonce from the server, and that signature is the login.
        </p>

        <form className="form form-col" onSubmit={onSubmit} noValidate>
          <label className="field-label" htmlFor="login-handle">
            Handle
          </label>
          <input
            className="input"
            id="login-handle"
            type="text"
            placeholder="@handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="username"
            spellCheck="false"
            maxLength={25}
            required
          />

          <label className="field-label" htmlFor="login-pass">
            Passphrase
          </label>
          <input
            className="input"
            id="login-pass"
            type="password"
            placeholder="…"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            required
          />

          <button className="btn btn-primary form-btn" type="submit" disabled={status === 'sending'}>
            {status === 'sending' ? 'Verifying signature…' : 'Unlock & log in'}
          </button>
        </form>

        {status === 'error' && message && (
          <p className="msg msg-err" role="alert">
            ✗ {message}
          </p>
        )}

        <p className="auth-note">
          No account yet? <Link to="/register">Create one</Link>
          {' · '}
          Back to <Link to="/">the front page</Link>
        </p>
      </div>
    </section>
  );
}
