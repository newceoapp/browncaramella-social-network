import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import { openJSON, sealJSON } from '../crypto.js';

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function Admin() {
  const { account, loading } = useAuth();

  const [overview, setOverview] = useState(null);
  const [queue, setQueue] = useState([]);
  const [loadError, setLoadError] = useState(null);

  // kill-switch state
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [killStatus, setKillStatus] = useState('idle'); // idle | working | error
  const [killMessage, setKillMessage] = useState(null);
  const exportBusy = useRef(false);

  const refresh = useCallback(async () => {
    const [ov, wl] = await Promise.all([
      apiFetch('/api/admin/overview'),
      apiFetch('/api/admin/waitlist?status=pending'),
    ]);
    if (ov.status === 200) {
      setOverview(ov.data);
      setLoadError(null);
    } else {
      setLoadError(ov.status === 403 ? 'forbidden' : 'unreachable');
    }
    if (wl.status === 200) setQueue(wl.data.entries ?? []);
  }, []);

  useEffect(() => {
    if (account?.isAdmin) refresh();
  }, [account, refresh]);

  if (loading) {
    return (
      <section className="admin-page">
        <div className="admin-card">
          <p className="auth-lede">Checking operator session…</p>
        </div>
      </section>
    );
  }
  if (!account) return <Navigate to="/login" replace />;
  if (!account.isAdmin) return <Navigate to="/account" replace />;

  async function decide(id, action) {
    const res = await apiFetch(`/api/admin/waitlist/${id}/${action}`, {
      method: 'POST',
    });
    if (res.status === 200) {
      setQueue((q) => q.filter((e) => e.id !== id));
      refresh();
    } else {
      setLoadError('unreachable');
    }
  }

  /**
   * The kill-switch, in order of operations:
   *   1. pull the full export over the admin session,
   *   2. seal it HERE, in the browser, with the operator's passphrase —
   *      the server never sees the passphrase and cannot decrypt the file,
   *   3. hand the sealed blob to the operator as a download,
   *   4. only then ask the server to engage lockdown.
   * If sealing or the download fails, lockdown is never engaged.
   */
  async function onEngage(event) {
    event.preventDefault();
    if (killStatus === 'working' || exportBusy.current) return;
    setKillMessage(null);

    if (passphrase.length < 8) {
      setKillStatus('error');
      setKillMessage('Passphrase needs at least 8 characters.');
      return;
    }
    if (passphrase !== confirm) {
      setKillStatus('error');
      setKillMessage('Passphrases do not match.');
      return;
    }

    setKillStatus('working');
    exportBusy.current = true;
    try {
      const res = await apiFetch('/api/admin/export');
      if (res.status !== 200) {
        setKillStatus('error');
        setKillMessage('Export failed — lockdown NOT engaged.');
        return;
      }

      const sealed = await sealJSON(res.data, passphrase);
      const blob = new Blob([JSON.stringify(sealed, null, 2)], {
        type: 'application/json',
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hackersdigest-lockdown-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const lock = await apiFetch('/api/admin/lockdown', { method: 'POST' });
      if (lock.status === 200) {
        setPassphrase('');
        setConfirm('');
        setKillStatus('idle');
        setKillMessage('✓ Site locked. Sealed export downloaded.');
        refresh();
      } else {
        setKillStatus('error');
        setKillMessage('Export downloaded, but engaging lockdown failed — retry.');
      }
    } catch {
      setKillStatus('error');
      setKillMessage('Sealing failed — lockdown NOT engaged.');
    } finally {
      exportBusy.current = false;
    }
  }

  async function onRelease() {
    if (killStatus === 'working') return;
    setKillStatus('working');
    const res = await apiFetch('/api/admin/unlock', { method: 'POST' });
    if (res.status === 200) {
      setKillStatus('idle');
      setKillMessage('✓ Lockdown released.');
      refresh();
    } else {
      setKillStatus('error');
      setKillMessage('Release failed — try again.');
    }
  }

  const stats = overview?.stats;
  const site = overview?.site;
  const locked = site?.locked === true;

  return (
    <section className="admin-page">
      <div className="admin-head">
        <span className="kicker">// operator console</span>
        <h1 className="auth-title">@{account.handle}</h1>
        <p className="auth-lede">
          Single-operator dashboard. Approvals are manual by design — every
          handle in the namespace is one you looked at yourself.
        </p>
      </div>

      {loadError === 'unreachable' && (
        <p className="msg msg-err" role="alert">
          ✗ Could not reach the admin API.
        </p>
      )}

      <div className="admin-grid">
        <div className={`admin-tile ${locked ? 'is-locked' : ''}`}>
          <b className={locked ? 'tile-locked' : 'accent'}>
            {locked ? 'LOCKED' : 'live'}
          </b>
          <span>site status</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.waitlist.pending ?? '—'}</b>
          <span>awaiting approval</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.waitlist.approved ?? '—'}</b>
          <span>approved queue</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.waitlist.rejected ?? '—'}</b>
          <span>rejected</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.accounts ?? '—'}</b>
          <span>registered keys</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.sessions ?? '—'}</b>
          <span>live sessions</span>
        </div>
        <div className="admin-tile">
          <b>{stats?.posts ?? '—'}</b>
          <span>sealed posts</span>
        </div>
        <div className="admin-tile">
          <b>{locked ? timeAgo(site.lockedAt) : '—'}</b>
          <span>{locked ? `locked by ${site.lockedBy}` : 'no lockdown'}</span>
        </div>
      </div>

      <div className="admin-card">
        <h2 className="admin-section">
          // access requests
          <span className="admin-count">{queue.length}</span>
        </h2>
        {queue.length === 0 ? (
          <p className="auth-note">Queue empty — nobody is waiting.</p>
        ) : (
          <ul className="admin-list">
            {queue.map((entry) => (
              <li className="admin-row" key={entry.id}>
                <div className="admin-row-info">
                  <b>@{entry.handle ?? '—'}</b>
                  <span>{entry.email}</span>
                  <span className="admin-when">requested {timeAgo(entry.createdAt)}</span>
                </div>
                <div className="admin-row-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => decide(entry.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => decide(entry.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`admin-card admin-kill ${locked ? 'is-locked' : ''}`}>
        <h2 className="admin-section">// kill-switch</h2>
        {!locked ? (
          <>
            <p className="auth-note">
              Engaging downloads the <strong>entire site database</strong>{' '}
              sealed with your passphrase — encrypted in this browser, so the
              server never sees the password — and then locks every public
              write. Only your handle can log in to release it.
            </p>
            <form className="form form-col" onSubmit={onEngage} noValidate>
              <label className="field-label" htmlFor="kill-pass">
                Export passphrase <span className="field-hint">(min 8 chars — cannot be recovered)</span>
              </label>
              <input
                className="input"
                id="kill-pass"
                type="password"
                placeholder="…"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
                required
              />
              <label className="field-label" htmlFor="kill-pass2">
                Repeat passphrase
              </label>
              <input
                className="input"
                id="kill-pass2"
                type="password"
                placeholder="…"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
              <button
                className="btn btn-danger"
                type="submit"
                disabled={killStatus === 'working'}
              >
                {killStatus === 'working'
                  ? 'Sealing export…'
                  : 'Seal export & lock down site'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="auth-note">
              Site is locked since {timeAgo(site.lockedAt)}. Public signups,
              registrations, and logins are refused; your sealed export is
              already downloaded.
            </p>
            <button
              className="btn btn-primary"
              type="button"
              onClick={onRelease}
              disabled={killStatus === 'working'}
            >
              Release lockdown
            </button>
          </>
        )}

        {killStatus === 'error' && killMessage && (
          <p className="msg msg-err" role="alert">
            ✗ {killMessage}
          </p>
        )}
        {killStatus !== 'error' && killMessage && (
          <p className="msg msg-ok" role="status">
            {killMessage}
          </p>
        )}
      </div>

      <p className="auth-note admin-foot">
        <Link to="/account">Your account</Link>
        {' · '}
        <Link to="/">Front page</Link>
      </p>
    </section>
  );
}
