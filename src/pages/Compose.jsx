import { useCallback, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import {
  exportEncryptionPublicKeyB64,
  generateEncryptionIdentity,
  sealForRecipient,
} from '../crypto.js';

const ERROR_MESSAGES = {
  unknown_handle: 'No account with that handle.',
  invalid_handle: 'Handles are 3–24 chars: letters, digits, underscore.',
  no_encryption_key: "That account hasn't set up encryption keys yet.",
  site_locked: 'The site is locked down right now — posting is closed.',
  storage_unavailable: 'Storage node unreachable — try again in a moment.',
};

function SkeletonLine({ width = '100%' }) {
  return (
    <div className="skeleton-line" style={{ width }} aria-hidden="true" />
  );
}

function ComposeSkeleton() {
  return (
    <section className="auth-page">
      <div className="auth-card compose-card">
        <span className="kicker">// write a post</span>
        <h1 className="auth-title">New sealed post</h1>
        <p className="auth-lede">
          The post is encrypted before it leaves this browser. The server
          stores ciphertext only.
        </p>
        <form className="form form-col" noValidate>
          <label className="field-label" htmlFor="compose-recipient">
            To (handle)
          </label>
          <div className="skeleton-line" style={{ width: '70%' }} />
          <p className="form-note">
            Posts are sealed to the recipient&rsquo;s encryption key. They can&rsquo;t
            be read by the server or by anyone else.
          </p>
          <label className="field-label" htmlFor="compose-content">
            Message
          </label>
          <div className="skeleton-line" style={{ width: '100%', height: '96px' }} />
        </form>
        <div className="form-actions">
          <div className="skeleton-line" style={{ width: '30%', height: '44px' }} />
          <div className="skeleton-line" style={{ width: '60%', height: '44px' }} />
        </div>
      </div>
    </section>
  );
}

export default function Compose() {
  const { account, encryptionKey, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return <ComposeSkeleton />;
  }

  if (!account) return <Navigate to="/login" replace />;

  const [recipient, setRecipient] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | done | error
  const [message, setMessage] = useState(null);

  if (!account.encryptionKey) {
    return (
      <section className="auth-page">
        <div className="auth-card compose-card">
          <span className="kicker">// setup required</span>
          <h1 className="auth-title">Encryption key not found</h1>
          <p className="auth-lede">
            Your account was created before encryption keys existed. Log out and
            log in again to generate one, or contact the operator.
          </p>
          <button className="btn btn-ghost" type="button" onClick={() => { navigate('/account', { replace: true }); }}>
            Back to account
          </button>
        </div>
      </section>
    );
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (status === 'sending') return;
    setMessage(null);

    const cleanRecipient = recipient.trim().replace(/^@/, '');
    if (!cleanRecipient) {
      setStatus('error');
      setMessage('Enter a recipient handle.');
      return;
    }
    if (!content.trim()) {
      setStatus('error');
      setMessage('Write something before sending.');
      return;
    }

    setStatus('sending');
    try {
      // 1. Resolve the recipient's encryption public key.
      const resolved = await apiFetch(`/api/accounts/${encodeURIComponent(cleanRecipient)}/fingerprint`);
      if (resolved.status === 404) {
        setStatus('error');
        setMessage(ERROR_MESSAGES.unknown_handle);
        return;
      }
      if (resolved.status !== 200 || !resolved.data?.encryptionKey) {
        setStatus('error');
        setMessage(ERROR_MESSAGES.no_encryption_key);
        return;
      }

      // 2. Seal the post for the recipient — client-side only.
      const sealed = await sealForRecipient(content, resolved.data.encryptionKey);

      // 3. Send ciphertext + routing metadata to the server.
      const res = await apiFetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: resolved.data.fingerprint,
          ciphertext: sealed.ct,
          nonce: sealed.iv,
          ephemeral: sealed.ephemeral,
          wrapped_key: sealed.wrappedKey,
          wrap_iv: sealed.wrapIv,
        }),
      });

      if (res.status === 201) {
        setStatus('done');
        return;
      }
      if (res.status === 503) {
        setStatus('error');
        setMessage(ERROR_MESSAGES[res.data?.error] || 'Posting failed. Try again.');
        return;
      }
      setStatus('error');
      setMessage(ERROR_MESSAGES[res.data?.error] || 'Post failed. Try again.');
    } catch {
      setStatus('error');
      setMessage('Cannot reach the API. Is it running?');
    }
  }

  return (
    <section className="compose-page">
      <div className="compose-card">
        <span className="kicker">// write a post</span>
        <h1 className="auth-title">New sealed post</h1>
        <p className="auth-lede">
          The post is encrypted to <strong>{cleanDisplay(recipient)}</strong>
          before it leaves this browser. The server stores ciphertext only.
        </p>

        <form className="form form-col" onSubmit={onSubmit} noValidate>
          <label className="field-label" htmlFor="compose-recipient">
            To (handle)
          </label>
          <input
            className="input"
            id="compose-recipient"
            type="text"
            placeholder="@handle"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            maxLength={25}
            required
          />
          <p className="form-note">
            Posts are sealed to the recipient&rsquo;s encryption key. They can&rsquo;t
            be read by the server or by anyone else.
          </p>

          <label className="field-label" htmlFor="compose-content">
            Message
          </label>
          <textarea
            className="input input-textarea"
            id="compose-content"
            placeholder="Type your message here…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
          />

          <div className="form-actions">
            <Link className="btn btn-ghost" to="/feed">
              Cancel
            </Link>
            <button
              className="btn btn-primary form-btn"
              type="submit"
              disabled={status === 'sending'}
            >
              {status === 'sending' ? 'Sealing & sending…' : 'Send sealed post'}
            </button>
          </div>
        </form>

        {status === 'error' && message && (
          <p className="msg msg-err" role="alert">✗ {message}</p>
        )}

        {status === 'done' && (
          <div className="msg msg-ok" role="status">
            ✓ Post sealed and sent. Only the recipient can decrypt it.
          </div>
        )}

        <p className="auth-note compose-foot">
          <Link to="/feed">Back to feed</Link>
          {' · '}
          <Link to="/account">Account</Link>
        </p>
      </div>
    </section>
  );
}

function cleanDisplay(handle) {
  return handle ? `@${handle}` : '—';
}
