import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import {
  exportPublicKeyB64,
  exportEncryptionPublicKeyB64,
  generateEncryptionIdentity,
  generateIdentity,
  registerProofMessage,
  sealKeyBackup,
  signMessage,
} from '../crypto.js';

const ERROR_MESSAGES = {
  not_invited: 'That email is not on the waitlist — join the queue first.',
  not_approved: 'Your request is still in the review queue — wait for approval, then come back.',
  site_locked: 'The site is locked down right now — registration is closed.',
  handle_taken: 'That handle is already claimed.',
  account_exists: 'An account already exists for that email — log in instead.',
  invalid_email: 'That does not look like an email address.',
  invalid_handle: 'Handles are 3–24 chars: letters, digits, underscore.',
  invalid_key: 'Key rejected by the server — try again.',
  invalid_proof: 'Key proof rejected — try again.',
  invalid_backup: 'Key backup looks malformed — try again.',
  storage_unavailable: 'Storage node unreachable — try again in a moment.',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Register() {
  const { account, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [email, setEmail] = useState(params.get('email') ?? '');
  const [handle, setHandle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | error
  const [message, setMessage] = useState(null);

  if (!loading && account) return <Navigate to="/account" replace />;

  async function onSubmit(event) {
    event.preventDefault();
    if (status === 'sending') return;
    setMessage(null);

    const cleanEmail = email.trim().toLowerCase();
    const cleanHandle = handle.trim().replace(/^@/, '');
    if (!EMAIL_RE.test(cleanEmail)) {
      setStatus('error');
      setMessage(ERROR_MESSAGES.invalid_email);
      return;
    }
    if (passphrase.length < 8) {
      setStatus('error');
      setMessage('Passphrase needs at least 8 characters.');
      return;
    }
    if (passphrase !== confirm) {
      setStatus('error');
      setMessage('Passphrases do not match.');
      return;
    }

    setStatus('sending');
    try {
      // 1. Keys are born here — the server never sees the private halves.
      let signingKeyPair;
      let encryptionKeyPair;
      try {
        signingKeyPair = await generateIdentity();
        encryptionKeyPair = await generateEncryptionIdentity();
      } catch {
        setStatus('error');
        setMessage(
          'This browser does not support Ed25519/X25519 in WebCrypto — try a current Chrome, Edge, Firefox, or Safari.'
        );
        return;
      }

      const publicKey = await exportPublicKeyB64(signingKeyPair);
      const encryptionPublicKey = await exportEncryptionPublicKeyB64(encryptionKeyPair);
      const keyBackup = await sealKeyBackup(
        signingKeyPair.privateKey,
        encryptionKeyPair.privateKey,
        passphrase
      );
      const proof = await signMessage(
        signingKeyPair.privateKey,
        registerProofMessage(cleanEmail, cleanHandle)
      );

      // 2. Register: public keys + sealed backup + proof of possession.
      const { status: s, data } = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          handle: cleanHandle,
          publicKey,
          encryptionPublicKey,
          keyBackup,
          proof,
        }),
      });

      if (s === 201) {
        await refresh();
        navigate('/account', { replace: true });
        return;
      }
      setStatus('error');
      setMessage(ERROR_MESSAGES[data?.error] ?? 'Registration failed. Try again.');
    } catch {
      setStatus('error');
      setMessage('Cannot reach the API. Is it running?');
    }
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <span className="kicker">// claim your identity</span>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-lede">
          Your Ed25519 keypair is generated <strong>in this browser</strong>,
          right now. The server receives only the public key and a
          passphrase-sealed backup of the private key — a blob it cannot open.
          No password is stored anywhere, because there is no password.
        </p>

        <form className="form form-col" onSubmit={onSubmit} noValidate>
          <label className="field-label" htmlFor="reg-email">
            Email <span className="field-hint">(must be on the waitlist)</span>
          </label>
          <input
            className="input"
            id="reg-email"
            type="email"
            placeholder="you@domain.tld"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />

          <label className="field-label" htmlFor="reg-handle">
            Handle
          </label>
          <input
            className="input"
            id="reg-handle"
            type="text"
            placeholder="@handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            maxLength={25}
            required
          />

          <label className="field-label" htmlFor="reg-pass">
            Passphrase <span className="field-hint">(unlocks your key backup)</span>
          </label>
          <input
            className="input"
            id="reg-pass"
            type="password"
            placeholder="at least 8 characters"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
            required
          />

          <label className="field-label" htmlFor="reg-pass2">
            Repeat passphrase
          </label>
          <input
            className="input"
            id="reg-pass2"
            type="password"
            placeholder="…"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />

          <button className="btn btn-primary form-btn" type="submit" disabled={status === 'sending'}>
            {status === 'sending' ? 'Generating keypair…' : 'Generate keys & register'}
          </button>
        </form>

        {status === 'error' && message && (
          <p className="msg msg-err" role="alert">
            ✗ {message}
          </p>
        )}

        <p className="auth-note">
          <strong>Unrecoverable by design:</strong> we can reset a session, but
          nobody can recover a lost passphrase — the sealed backup is useless
          without it.
        </p>
        <p className="auth-note">
          Already have keys? <Link to="/login">Log in</Link>
          {' · '}
          Not on the list yet? <Link to="/#waitlist">Join the queue</Link>
        </p>
      </div>
    </section>
  );
}
