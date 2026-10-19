import { useState } from 'react';
import { Link } from 'react-router-dom';

const ERROR_MESSAGES = {
  invalid_email: 'That does not look like an email address.',
  invalid_handle: 'Handles are 3–24 chars: letters, digits, underscore.',
  already_registered: 'That address is already in the queue.',
  handle_taken: 'That handle is already claimed.',
  site_locked: 'The site is locked down right now — try again later.',
  storage_unavailable: 'Storage node unreachable — try again in a moment.',
};

export default function Waitlist() {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | done | error
  const [message, setMessage] = useState(null);
  const [queueStatus, setQueueStatus] = useState(null); // pending | approved

  async function onSubmit(event) {
    event.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setMessage(null);

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, handle }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 201) {
        setQueueStatus(data.status ?? 'pending');
        setStatus('done');
        return;
      }
      if (res.status === 409 && data.status) {
        // Already queued: show where they stand instead of a bare error.
        setQueueStatus(data.status);
        setStatus('done');
        return;
      }
      setStatus('error');
      setMessage(ERROR_MESSAGES[data.error] ?? 'Something went wrong. Try again.');
    } catch {
      setStatus('error');
      setMessage('Cannot reach the API. Is it running?');
    }
  }

  if (status === 'done') {
    const approved = queueStatus === 'approved';
    return (
      <div className="waitlist-card" id="waitlist">
        <span className="kicker">
          {approved ? '// approved' : '// access request received'}
        </span>
        <h2 className="done-title">
          {approved
            ? 'Approved — claim your handle.'
            : 'You’re in the review queue.'}
        </h2>
        <p className="done-note">
          {approved
            ? 'Your keypair is generated in your browser, and the server only ever receives the public half.'
            : 'Every request is reviewed by hand — no auto-approval, no bots. Come back with the same email once you’re approved and this form will tell you.'}
        </p>
        {approved && (
          <div className="done-actions">
            <Link
              className="btn btn-primary"
              to={`/register?email=${encodeURIComponent(email)}`}
            >
              Claim your account now
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="waitlist" id="waitlist">
      <div className="waitlist-card">
        <span className="kicker">// early access</span>
        <h2>Claim your handle before the namespace fills up.</h2>
        <p className="waitlist-lede">
          The beta opens in waves, and every request is reviewed by hand —
          the operator approves each address themselves. We store an email
          and a desired handle — nothing else, and there is nothing else to
          store: your keys are generated after you install the client.
        </p>

        <form className="form" onSubmit={onSubmit} noValidate>
          <label className="sr-only" htmlFor="email">
            Email address
          </label>
          <input
            className="input"
            id="email"
            name="email"
            type="email"
            placeholder="you@domain.tld"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <label className="sr-only" htmlFor="handle">
            Desired handle
          </label>
          <input
            className="input input-handle"
            id="handle"
            name="handle"
            type="text"
            placeholder="@handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            maxLength={25}
          />
          <button
            className="btn btn-primary form-btn"
            type="submit"
            disabled={status === 'sending'}
          >
            {status === 'sending' ? 'Sealing…' : 'Join the queue'}
          </button>
        </form>

        {status === 'error' && message && (
          <p className="msg msg-err" role="alert">
            ✗ {message}
          </p>
        )}
        <p className="form-note">
          # one address per invite · no cookies · form posts go straight to our
          own API
        </p>
      </div>
    </section>
  );
}
