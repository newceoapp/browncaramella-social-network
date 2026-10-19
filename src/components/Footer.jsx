import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <a className="brand" href="#top">
            <span className="brand-mark" aria-hidden="true">
              &gt;_
            </span>
            hackersdigest
          </a>
          <p>
            An end-to-end encrypted social network for people who read the
            source.
          </p>
          <p className="fingerprint">
            pgp fingerprint<br />
            9F3C 1A77 E20B 4D18 6C55
          </p>
        </div>

        <div className="footer-col">
          <h4>Project</h4>
          <Link to="/#features">Features</Link>
          <Link to="/#how">How it works</Link>
          <Link to="/#waitlist">Request access</Link>
        </div>

        <div className="footer-col">
          <h4>Transparency</h4>
          <a href="#top" title="Coming with the public beta">Threat model</a>
          <a href="#top" title="Coming with the public beta">Source code</a>
          <a href="#top" title="Coming with the public beta">Audit reports</a>
        </div>

        <div className="footer-col">
          <h4>Community</h4>
          <a href="#top" title="Coming with the public beta">GitHub</a>
          <a href="#top" title="Coming with the public beta">Matrix room</a>
          <a href="#top" title="Coming with the public beta">Mastodon</a>
        </div>
      </div>

      <div className="footer-bottom">
        <span>© 2026 HackersDigest</span>
        <span>no cookies · no trackers · no third-party requests</span>
        <span>react + express + postgresql</span>
      </div>
    </footer>
  );
}
