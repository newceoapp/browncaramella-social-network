const STEPS = [
  {
    num: '01',
    title: 'Generate locally',
    body: 'On first launch the client creates your identity keypair. The private half is passphrase-encrypted and stays on your device — the server only ever learns the public half.',
  },
  {
    num: '02',
    title: 'Seal before send',
    body: 'Posts are encrypted for their recipients before the request leaves your machine. The API receives a ciphertext blob, a nonce, and routing metadata. Nothing else.',
  },
  {
    num: '03',
    title: 'Decrypt on read',
    body: 'Your feed arrives as sealed blobs. The client decrypts them in memory and renders the plaintext. What the server cannot read, it cannot leak, sell, or lose.',
  },
];

export default function HowItWorks() {
  return (
    <section className="section section-alt" id="how">
      <div className="section-head">
        <span className="kicker">// how it works</span>
        <h2>Three steps, all of them on your side of the wire.</h2>
        <p>
          The server is a post office for sealed envelopes: it stamps,
          sorts, and delivers — and has no key to read what passes through it.
        </p>
      </div>
      <div className="steps">
        {STEPS.map((step) => (
          <article className="step" key={step.num}>
            <span className="step-num">{step.num}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
