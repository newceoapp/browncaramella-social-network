import TryIt from './TryIt.jsx';

export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-copy">
        <span className="badge">
          <span className="badge-dot" aria-hidden="true" />
          Zero-knowledge · E2E encrypted · open protocol
        </span>
        <h1>
          The social network that <span className="hl">can&apos;t read</span> your
          posts.
        </h1>
        <p className="lede">
          HackersDigest is an end-to-end encrypted feed. Keys are generated on
          your device, posts are sealed before they leave it, and the server
          only ever moves ciphertext it cannot open. Not a promise in a privacy
          policy — an architecture.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary" href="#waitlist">
            Request beta access
          </a>
          <a className="btn btn-ghost" href="#how">
            How the encryption works
          </a>
        </div>
        <p className="hero-note">
          # no cookies · no trackers · no third-party requests on this page
        </p>
      </div>
      <TryIt />
    </section>
  );
}
