import { useEffect, useState } from 'react';

export default function StatsBar() {
  const [stats, setStats] = useState({ db: 'unknown', signups: null, locked: null });

  useEffect(() => {
    let alive = true;
    fetch('/api/stats')
      .then((r) => r.json())
      .then((data) => {
        if (alive)
          setStats({
            db: data.db ?? 'unknown',
            signups: data.signups ?? null,
            locked: data.locked ?? null,
          });
      })
      .catch(() => {
        if (alive) setStats({ db: 'unknown', signups: null, locked: null });
      });
    return () => {
      alive = false;
    };
  }, []);

  const dbUp = stats.db === 'up';
  const dbClass = dbUp ? 'is-up' : stats.db === 'down' ? 'is-down' : 'is-unknown';

  return (
    <section className="stats" aria-label="Live stats">
      <div className="stats-inner">
        <div className="stat">
          <b>{stats.signups ?? '—'}</b>
          <span>in the beta queue</span>
        </div>
        <div className="stat">
          <b>0 B</b>
          <span>plaintext on the server</span>
        </div>
        <div className="stat">
          <b>0</b>
          <span>third-party trackers here</span>
        </div>
        <div className="stat">
          <b className={`db-value ${dbClass}`}>
            <span className="db-dot" aria-hidden="true" />
            {stats.db === 'up' ? 'up' : stats.db === 'down' ? 'offline' : 'unknown'}
          </b>
          <span>postgres status</span>
        </div>
        {stats.locked && (
          <div className="stat">
            <b className="db-value is-down">
              <span className="db-dot" aria-hidden="true" />
              locked
            </b>
            <span>site status</span>
          </div>
        )}
      </div>
    </section>
  );
}
