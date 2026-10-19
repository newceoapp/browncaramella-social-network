import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function TryIt() {
  const { account } = useAuth();
  const navigate = useNavigate();

  const goTo = (path) => {
    if (!account) {
      navigate('/login', { replace: true });
      return;
    }
    navigate(path, { replace: true });
  };

  const loggedIn = !!account;

  return (
    <section className="tryit">
      <span className="kicker">// try it live</span>
      <h2>Open the encrypted feed</h2>
      <p className="tryit-lede">
        Keys are generated on your device. Posts are sealed before they leave
        it. The server only ever moves ciphertext it cannot open.
      </p>
      <div className="tryit-grid">
        <a
          className="tryit-card"
          onClick={(e) => { e.preventDefault(); goTo('/feed'); }}
          role="link"
          aria-label="Open your encrypted feed"
        >
          <span className="tryit-kicker">// encrypted feed</span>
          <h3>Read your sealed posts</h3>
          <p>
            Decrypt messages addressed to you and browse your own sent posts.
            Nothing is readable by the server.
          </p>
          <span className="tryit-arrow">→</span>
        </a>
        <a
          className="tryit-card"
          onClick={(e) => { e.preventDefault(); goTo('/compose'); }}
          role="link"
          aria-label="Compose a new sealed post"
        >
          <span className="tryit-kicker">// compose</span>
          <h3>Write a sealed post</h3>
          <p>
            Encrypt a message to any contact before it leaves your device.
            Only the recipient can decrypt it.
          </p>
          <span className="tryit-arrow">→</span>
        </a>
      </div>
      {loggedIn ? null : (
        <p className="tryit-logged-out">
          Not logged in?{' '}
          <a
            className="tryit-link"
            href="/login"
            onClick={(e) => { e.preventDefault(); navigate('/login', { replace: true }); }}
          >
            Log in
          </a>{' '}
          or{' '}
          <a
            className="tryit-link"
            href="/#waitlist"
            onClick={(e) => { e.preventDefault(); navigate('/', { replace: true }); }}
          >
            request beta access
          </a>
          to get started.
        </p>
      )}
    </section>
  );
}
