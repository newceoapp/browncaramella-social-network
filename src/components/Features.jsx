const CARDS = [
  {
    title: 'Zero-knowledge storage',
    body: 'The server holds sealed ciphertext and the bare metadata needed to route it. A subpoena gets bytes nobody on our side can open.',
    icon: (
      <>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  {
    title: 'Keys stay on your device',
    body: 'Ed25519 identity keys are generated in the client and never transmitted. Lose the key, lose the account — by design, not by policy.',
    icon: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="M11 12l8-8M16 7l3 3" />
      </>
    ),
  },
  {
    title: 'Metadata minimization',
    body: 'Sealed-sender envelopes hide who talks to whom from the infrastructure — not just what they say inside the message.',
    icon: (
      <>
        <path d="M3 3l18 18" />
        <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.5 1.9-1.4 3M6.6 6.6C4.4 8 3 10.1 3 12c0 2.5 4 7 9 7 1.6 0 3-.4 4.2-1" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      </>
    ),
  },
  {
    title: 'Self-hostable',
    body: 'One Node process and one Postgres database. Run your own instance, keep your own data, federate with the rest — no permission needed.',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </>
    ),
  },
  {
    title: 'No ads, no algorithms',
    body: 'Reverse-chronological feed. You see whom you follow, in the order it happened. Nothing is promoted, boosted, or sold around it.',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M5.6 5.6l12.8 12.8" />
      </>
    ),
  },
  {
    title: 'Open by default',
    body: 'Client, protocol spec, and server ship source-available for review. Trust the math and the diffs, not the marketing.',
    icon: (
      <>
        <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />
      </>
    ),
  },
];

export default function Features() {
  return (
    <section className="section" id="features">
      <div className="section-head">
        <span className="kicker">// why it exists</span>
        <h2>Privacy that comes from cryptography, not from promises.</h2>
        <p>
          Every mainstream network asks you to trust its servers, its staff, and
          its government. HackersDigest removes the need for trust: the
          plaintext never exists anywhere except on the devices of the people
          in the conversation.
        </p>
      </div>
      <div className="cards">
        {CARDS.map((card) => (
          <article className="card" key={card.title}>
            <div className="card-ico" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {card.icon}
              </svg>
            </div>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
