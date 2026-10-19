import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Nav() {
  const { account, logout } = useAuth();

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">
            &gt;_
          </span>
          hackersdigest
        </Link>
        <nav className="nav-links">
          <Link to="/#features">Features</Link>
          <Link to="/#how">How it works</Link>
          {account && <Link to="/account">Account</Link>}
          {account && <Link to="/feed">Feed</Link>}
          {account && <Link to="/compose">Compose</Link>}
          {account?.isAdmin && <Link to="/admin">Admin</Link>}
        </nav>
        <div className="nav-auth">
          {account ? (
            <>
              <Link className="nav-handle" to="/account" title="Your account">
                @{account.handle}
              </Link>
              <button
                className="btn btn-ghost nav-login"
                type="button"
                onClick={() => logout()}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link className="btn btn-ghost nav-login" to="/login">
                Log in
              </Link>
              <Link className="btn btn-primary nav-cta" to="/#waitlist">
                Request access
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
