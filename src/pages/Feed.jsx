import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { apiFetch, useAuth } from '../auth.jsx';
import { openSealed } from '../crypto.js';

const PAGE_SIZE = 25;

function SkeletonLine({ width = '100%' }) {
  return (
    <div
      className="skeleton-line"
      style={{ width }}
      aria-hidden="true"
    />
  );
}

function SkeletonPost() {
  return (
    <li className="feed-row skeleton">
      <div className="feed-row-header">
        <span className="feed-role-sent skeleton-line" style={{ width: '40%' }} />
        <span className="feed-when skeleton-line" style={{ width: '26%' }} />
      </div>
      <div className="feed-row-body">
        <SkeletonLine width="60%" />
        <SkeletonLine width="45%" />
      </div>
    </li>
  );
}

export default function Feed() {
  const { account, encryptionKey, loading, logout } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return (
      <section className="auth-page">
        <div className="auth-card">
          <p className="auth-lede">Loading feed…</p>
        </div>
      </section>
    );
  }

  if (!account) return <Navigate to="/login" replace />;

  const [posts, setPosts] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [decrypted, setDecrypted] = useState({}); // postId -> plaintext
  const [decrypting, setDecrypting] = useState({}); // postId -> boolean
  const [seenPostIds, setSeenPostIds] = useState(() => {
    try {
      const stored = localStorage.getItem('hd:seenPosts');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  const mounted = useRef(true);

  const load = useCallback(async (cursor) => {
    const url = new URL('/api/feed', window.location.origin);
    if (cursor) url.searchParams.set('before', cursor);
    url.searchParams.set('limit', String(PAGE_SIZE));

    const res = await apiFetch(url.pathname + url.search);
    if (res.status !== 200) {
      setError('Unable to load feed.');
      setInitialLoading(false);
      return;
    }
    const data = res.data;
    const incoming = data.posts ?? [];

    if (cursor) {
      setPosts((prev) => [...prev, ...incoming]);
    } else {
      setPosts(incoming);
    }
    setNextCursor(data.nextCursor ?? null);
    setError(null);
    setInitialLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(null);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Mark newly loaded posts as seen so unread indicators only show for
  // posts the user hasn't opened yet.
  useEffect(() => {
    if (!initialLoading && posts.length > 0) {
      const newlySeen = posts.filter((p) => !seenPostIds.has(p.id));
      if (newlySeen.length > 0) {
        setSeenPostIds((prev) => {
          const next = new Set(prev);
          newlySeen.forEach((p) => next.add(p.id));
          try {
            localStorage.setItem('hd:seenPosts', JSON.stringify([...next]));
          } catch {
            /* localStorage unavailable — unread indicators won't persist */
          }
          return next;
        });
      }
    }
  }, [posts, initialLoading, seenPostIds]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    await load(nextCursor);
    setLoadingMore(false);
  }, [load, loadingMore, nextCursor]);

  async function decryptPost(post) {
    if (!post.forMe || !encryptionKey) return;
    if (decrypted[post.id]) return;
    setDecrypting((d) => ({ ...d, [post.id]: true }));
    try {
      const sealed = {
        ephemeral: post.ephemeralKey,
        wrappedKey: post.wrappedKey,
        wrapIv: post.wrapIv,
        iv: post.nonce,
        ct: post.ciphertext,
      };
      const plain = await openSealed(sealed, encryptionKey);
      if (mounted.current) {
        setDecrypted((d) => ({ ...d, [post.id]: plain }));
      }
    } catch {
      if (mounted.current) {
        setDecrypted((d) => ({ ...d, [post.id]: '[unable to decrypt]' }));
      }
    } finally {
      if (mounted.current) {
        setDecrypting((d) => { const n = { ...d }; delete n[post.id]; return n; });
      }
    }
  }

  // Decrypt posts addressed to us as they appear.
  useEffect(() => {
    posts.forEach((p) => {
      if (p.forMe && !decrypted[p.id]) decryptPost(p);
    });
  }, [posts, decrypted, encryptionKey]);

  async function onDelete(post) {
    if (!window.confirm('Delete this post?')) return;
    const res = await apiFetch(`/api/posts/${post.id}`, { method: 'DELETE' });
    if (res.status === 204) {
      setPosts((prev) => prev.filter((p) => p.id !== post.id));
      setDecrypted((d) => { const n = { ...d }; delete n[post.id]; return n; });
      setSeenPostIds((prev) => { const n = new Set(prev); n.delete(post.id); return n; });
    } else {
      setError('Could not delete post.');
    }
  }

  const isUnread = (post) => post.forMe && !seenPostIds.has(post.id);

  return (
    <section className="feed-page">
      <div className="feed-card">
        <div className="feed-head">
          <span className="kicker">// encrypted feed</span>
          <h1 className="auth-title">@{account.handle}</h1>
          <p className="auth-lede">
            Posts are sealed client-side. Only you and the intended recipient
            can read them — the server sees ciphertext only.
          </p>
        </div>

        {error && (
          <p className="msg msg-err" role="alert">✗ {error}</p>
        )}

        {initialLoading ? (
          <ul className="feed-list skeleton-list">
            {[0, 1, 2].map((i) => <SkeletonPost key={i} />)}
          </ul>
        ) : posts.length === 0 ? (
          <p className="auth-note">No posts yet. <Link to="/compose">Write one</Link>.</p>
        ) : (
          <ul className="feed-list">
            {posts.map((post) => {
              const plain = decrypted[post.id];
              const isDecrypting = !!decrypting[post.id];
              const unread = isUnread(post);
              return (
                <li
                  className={`feed-row ${unread ? 'feed-row-unread' : ''}`}
                  key={post.id}
                  onClick={() => {
                    if (unread && post.forMe && !decrypted[post.id] && encryptionKey) {
                      decryptPost(post);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (unread && post.forMe && !decrypted[post.id] && encryptionKey) {
                        decryptPost(post);
                      }
                    }
                  }}
                >
                  <div className="feed-row-header">
                    <span
                      className={post.mine ? 'feed-role-sent' : 'feed-role-recv'}
                    >
                      {post.mine ? '→ sent' : '← for you'}
                    </span>
                    {unread && post.forMe && (
                      <span className="feed-unread-dot" aria-label="unread" />
                    )}
                    <span className="feed-when">
                      {new Date(post.createdAt).toLocaleString()}
                    </span>
                    {post.mine && !post.forMe && (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => onDelete(post)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  <div className="feed-row-body">
                    {plain !== undefined ? (
                      plain === '[unable to decrypt]' ? (
                        <p className="feed-ct">✗ Unable to decrypt this post.</p>
                      ) : (
                        <p className="feed-plain">{plain}</p>
                      )
                    ) : isDecrypting ? (
                      <p className="feed-ct">decrypting…</p>
                    ) : post.forMe ? (
                      <p className="feed-ct">sealed — click to decrypt</p>
                    ) : (
                      <p className="feed-ct">sealed to another key</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor && !loadingMore && (
          <button className="btn btn-ghost" type="button" onClick={() => loadMore()}>
            Older posts
          </button>
        )}
        {loadingMore && <p className="auth-note">Loading…</p>}

        <p className="auth-note feed-foot">
          <Link to="/compose">New post</Link>
          {' · '}
          <Link to="/account">Account</Link>
          {' · '}
          <button className="btn btn-ghost" type="button" onClick={() => { logout(); navigate('/', { replace: true }); }}>
            Sign out
          </button>
        </p>
      </div>
    </section>
  );
}
