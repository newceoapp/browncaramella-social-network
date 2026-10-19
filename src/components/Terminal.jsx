import { useEffect, useState } from 'react';

const LINES = [
  { kind: 'cmd', text: 'hd keygen --algo ed25519' },
  { kind: 'ok', text: '✓ identity keypair sealed on this device' },
  { kind: 'dim', text: '  fingerprint 9F3C 1A77 E20B 4D18 6C55' },
  { kind: 'cmd', text: 'hd post "ship it"' },
  { kind: 'prog', text: 'encrypting ████████████████████ 100%' },
  { kind: 'ok', text: '→ ciphertext 2.1 KB · plaintext written to server: 0 B' },
  { kind: 'cmd', text: 'hd feed --decrypt' },
  { kind: 'dim', text: '42 posts decrypted locally · 0 keys shared with the server' },
];

const SPEED = 24; // ms per character
const LINE_PAUSE = 420; // ms between finished lines
const LOOP_PAUSE = 3200; // ms before replaying

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export default function Terminal() {
  const reduced = prefersReducedMotion();
  const [pos, setPos] = useState(() =>
    reduced ? { line: LINES.length, chars: 0 } : { line: 0, chars: 0 }
  );

  useEffect(() => {
    if (reduced) return undefined;
    const current = LINES[pos.line];
    let timer;

    if (!current) {
      // All lines shown — pause, then replay.
      timer = setTimeout(() => setPos({ line: 0, chars: 0 }), LOOP_PAUSE);
    } else if (pos.chars < current.text.length) {
      timer = setTimeout(
        () => setPos((p) => ({ ...p, chars: p.chars + 1 })),
        SPEED
      );
    } else {
      const isLast = pos.line === LINES.length - 1;
      timer = setTimeout(
        () => setPos((p) => ({ line: p.line + 1, chars: 0 })),
        isLast ? LOOP_PAUSE : LINE_PAUSE
      );
    }
    return () => clearTimeout(timer);
  }, [pos, reduced]);

  const visible = LINES.slice(0, pos.line);
  const typing = LINES[pos.line];
  const typedText = typing ? typing.text.slice(0, pos.chars) : '';

  return (
    <div className="terminal" role="img" aria-label="Terminal demo: generating keys, sealing a post, decrypting a feed locally">
      <div className="term-bar">
        <span className="term-dot" />
        <span className="term-dot" />
        <span className="term-dot" />
        <span className="term-title">guest@local — hd</span>
      </div>
      <pre className="term-body">
        {visible.map((line, i) => (
          <Line key={i} line={line} />
        ))}
        {typing && (
          <span className={`t-${typing.kind}`}>
            {typing.kind === 'cmd' && <span className="t-prompt">$ </span>}
            {typedText}
            <span className="cursor" aria-hidden="true">
              ▍
            </span>
          </span>
        )}
        {!typing && <span className="cursor t-ok" aria-hidden="true">▍</span>}
      </pre>
    </div>
  );
}

function Line({ line }) {
  return (
    <span className={`t-${line.kind}`}>
      {line.kind === 'cmd' && <span className="t-prompt">$ </span>}
      {line.text}
      {'\n'}
    </span>
  );
}
