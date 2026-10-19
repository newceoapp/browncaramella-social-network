/**
 * Client-side identity crypto — runs in the browser, and under Node ≥ 20 for
 * the API smoke tests, so the tests exercise the same code the UI uses.
 *
 * Identity = Ed25519 signing keypair + X25519 encryption keypair, both
 * generated in this process.
 * Key backup = both PKCS#8 private keys sealed with a passphrase via
 * PBKDF2-SHA256 → AES-256-GCM. The passphrase never leaves the device; the
 * server only ever sees the ciphertext blob.
 *
 * Post encryption = hybrid: random AES-256-GCM content key seals the post;
 * the content key is wrapped to the recipient's X25519 key via ECDH +
 * HKDF-SHA256, using a fresh ephemeral X25519 keypair per post (forward
 * secrecy). The server stores ciphertext + routing metadata only.
 *
 * X25519 is implemented in pure JavaScript (RFC 7748) because Node's
 * crypto.subtle does not support the X25519 named curve. Ed25519 uses the
 * platform's Web Crypto (supported in both browsers and Node ≥ 20).
 */

export const AUTH_PREFIX = 'hd-auth-v1:';
export const KDF_ITERATIONS = 250_000;

const encoder = new TextEncoder();

/** Statement the client signs to prove possession at registration. */
export function registerProofMessage(email, handle) {
  return encoder.encode(`${AUTH_PREFIX}register:${email.toLowerCase()}:${handle}`);
}

/** Statement the client signs during login (server builds the same bytes). */
export function loginMessage(nonceB64) {
  const bytes = b64ToBytes(nonceB64);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return encoder.encode(`${AUTH_PREFIX}${hex}`);
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ed25519 support probe: throws where WebCrypto lacks the algorithm. */
export async function assertEd25519() {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']);
  } catch {
    throw new Error('ed25519_unsupported');
  }
}

/** X25519 support probe: pure JS implementation always available. */
export async function assertX25519() {
  // Pure-JS X25519 (RFC 7748) — works in every JS environment.
}

/** Fresh identity keypair (extractable so we can back it up and export). */
export async function generateIdentity() {
  await assertEd25519();
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}

/** Fresh X25519 encryption keypair. Returns raw 32-byte key arrays. */
export async function generateEncryptionIdentity() {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = x25519(clampScalar(privateKey), X25519_BASE_U);
  return { privateKey, publicKey };
}

/** SPKI DER, base64 — what the server stores as public_key. */
export async function exportPublicKeyB64(keyPair) {
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  return bytesToB64(new Uint8Array(spki));
}

/** Encode raw 32-byte X25519 public key to SPKI DER, base64. */
export async function exportEncryptionPublicKeyB64(keyPair) {
  const spki = encodeSPKIX25519(keyPair.publicKey);
  return bytesToB64(spki);
}

/** Import an X25519 public key from base64 SPKI DER → raw 32-byte array. */
export async function importEncryptionPublicKey(b64) {
  return decodeSPKIX25519(b64ToBytes(b64));
}

/** X25519 Diffie-Hellman shared secret: clamp(privateKey) * publicKey. */
export async function x25519DH(privateKey, publicKey) {
  return x25519(clampScalar(privateKey), decodeU(publicKey));
}

/** Fingerprint of a base64 SPKI DER key: first 8 bytes of sha256, grouped. */
export async function fingerprintOfB64(publicKeyB64) {
  const hash = await crypto.subtle.digest('SHA-256', b64ToBytes(publicKeyB64));
  return new Uint8Array(hash)
    .subarray(0, 8)
    .toString('hex')
    .toUpperCase()
    .match(/.{4}/g)
    .join(' ');
}

async function deriveBackupKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Seal both private keys (signing + encryption) with the passphrase → v2 JSON
 * blob safe to store server-side. Layout: length-prefixed blobs:
 *   [u32 signingPkcs8Len][signingPkcs8Der][u32 encryptionRawLen=32][encryptionRaw32]
 */
export async function sealKeyBackup(signingPrivateKey, encryptionPrivateKey, passphrase) {
  const signingPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', signingPrivateKey));
  const combined = new Uint8Array(4 + signingPkcs8.length + 4 + encryptionPrivateKey.length);
  const dv = new DataView(combined.buffer);
  let offset = 0;
  const writeLen = (buf) => {
    dv.setUint32(offset, buf.length, true);
    offset += 4;
    combined.set(buf, offset);
    offset += buf.length;
  };
  writeLen(signingPkcs8);
  writeLen(encryptionPrivateKey);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, KDF_ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, combined)
  );
  return {
    v: 2,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    alg: 'AES-GCM',
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  };
}

/**
 * Open a sealed backup with the passphrase → { signingKey, encryptionKey }.
 * Rejects with Error('wrong_passphrase') when the passphrase is incorrect.
 * Accepts v1 (signing only, encryptionKey = null) and v2 backups.
 */
export async function openKeyBackup(backup, passphrase) {
  await assertEd25519();
  const key = await deriveBackupKey(
    passphrase,
    b64ToBytes(backup.salt),
    backup.iterations ?? KDF_ITERATIONS
  );
  let pkcs8;
  try {
    pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(backup.iv) },
      key,
      b64ToBytes(backup.ct)
    );
  } catch {
    throw new Error('wrong_passphrase');
  }

  const bytes = new Uint8Array(pkcs8);
  if (backup.v === 1) {
    // Legacy v1: the whole plaintext is a single Ed25519 PKCS#8 blob.
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'Ed25519' },
      true, // extractable — needed for backup re-sealing (passphrase change, rotation)
      ['sign']
    );
    return { signingKey, encryptionKey: null };
  }

  // v2: [u32 signingLen][signingPkcs8][u32 encryptionLen][encryptionRaw32]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readLen = () => {
    const len = view.getUint32(offset, true);
    offset += 4;
    const buf = bytes.subarray(offset, offset + len);
    offset += len;
    return buf;
  };
  const signingPkcs8 = readLen();
  const encryptionRaw = readLen();

  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    signingPkcs8,
    { name: 'Ed25519' },
    true, // extractable — needed for backup re-sealing (passphrase change, rotation)
    ['sign']
  );
  return { signingKey, encryptionKey: new Uint8Array(encryptionRaw) };
}

/** Sign UTF-8 message bytes → base64 signature. */
export async function signMessage(privateKey, messageBytes) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, messageBytes);
  return bytesToB64(new Uint8Array(sig));
}

/**
 * Hybrid-seal a UTF-8 string for a recipient's X25519 public key.
 * Fresh ephemeral X25519 keypair per post → forward secrecy. Returns a
 * self-describing sealed blob the server stores as-is.
 */
export async function sealForRecipient(plaintext, recipientPublicKeyB64) {
  const recipientKeyRaw = importEncryptionPublicKey(recipientPublicKeyB64);

  // Ephemeral X25519 keypair for this post.
  const ephemeral = await generateEncryptionIdentity();
  const ephemeralSpki = encodeSPKIX25519(ephemeral.publicKey);

  // ECDH shared secret: ephemeral private × recipient public.
  const shared = await x25519DH(ephemeral.privateKey, recipientKeyRaw);

  // Derive wrapping key from shared secret via HKDF-SHA256.
  const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const wrapBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('hackersdigest-post-wrap') },
    baseKey,
    256
  );
  const wrapKey = await crypto.subtle.importKey('raw', wrapBits, 'AES-GCM', false, [
    'wrapKey',
    'unwrapKey',
  ]);

  // Random content key, encrypt the post.
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const cryptoKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', true, [
    'encrypt',
    'wrapKey',
  ]);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: contentIv },
      cryptoKey,
      encoder.encode(plaintext)
    )
  );

  // Wrap the content key.
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.wrapKey('raw', cryptoKey, wrapKey, { name: 'AES-GCM', iv: wrapIv })
  );

  return {
    v: 1,
    kind: 'hackersdigest-sealed-post',
    ephemeral: bytesToB64(ephemeralSpki),
    wrappedKey: bytesToB64(wrapped),
    wrapIv: bytesToB64(wrapIv),
    iv: bytesToB64(contentIv),
    ct: bytesToB64(ct),
  };
}

/**
 * Open a sealed post with the recipient's private X25519 key → plaintext string.
 * Rejects with Error('wrong_key') when decryption fails (not our post).
 */
export async function openSealed(sealed, privateKey) {
  const senderKeyRaw = importEncryptionPublicKey(sealed.ephemeral);
  const shared = await x25519DH(privateKey, senderKeyRaw);

  const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const wrapBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('hackersdigest-post-wrap') },
    baseKey,
    256
  );
  const wrapKey = await crypto.subtle.importKey('raw', wrapBits, 'AES-GCM', false, [
    'wrapKey',
    'unwrapKey',
  ]);
  let contentKey;
  try {
    contentKey = await crypto.subtle.unwrapKey(
      'raw',
      b64ToBytes(sealed.wrappedKey),
      wrapKey,
      { name: 'AES-GCM', iv: b64ToBytes(sealed.wrapIv) },
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  } catch {
    throw new Error('wrong_key');
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(sealed.iv) },
      contentKey,
      b64ToBytes(sealed.ct)
    );
  } catch {
    throw new Error('wrong_key');
  }
  return new TextDecoder().decode(plain);
}

/**
 * Seal arbitrary JSON with a passphrase → self-describing blob.
 * Used by the admin kill-switch: the site export is encrypted HERE, in the
 * browser, so the operator's passphrase never reaches the server.
 */
export async function sealJSON(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, KDF_ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(JSON.stringify(data))
    )
  );
  return {
    v: 1,
    kind: 'hackersdigest-sealed-json',
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    alg: 'AES-GCM',
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  };
}

/**
 * Open a blob sealed with sealJSON → the original JSON value.
 * Rejects with Error('wrong_passphrase') when the passphrase is incorrect.
 */
export async function openJSON(sealed, passphrase) {
  const key = await deriveBackupKey(
    passphrase,
    b64ToBytes(sealed.salt),
    sealed.iterations ?? KDF_ITERATIONS
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(sealed.iv) },
      key,
      b64ToBytes(sealed.ct)
    );
  } catch {
    throw new Error('wrong_passphrase');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------------------
// Pure-JS X25519 (RFC 7748) — Montgomery curve u^2 = v^3 + 486662*u^2 + u
// over GF(2^255-19). All operations are constant-time-ish and work in any JS
// engine (Node and browser).
// ---------------------------------------------------------------------------

const X25519_P = 2n ** 255n - 19n;
const X25519_A24 = 121666n; // (486662 + 2) / 4
const X25519_BASE_U = 9n;

function clampScalar(k) {
  const b = new Uint8Array(k);
  b[0] &= 248;
  b[31] &= 127;
  b[31] |= 64;
  return b;
}

function mod(x) {
  return ((x % X25519_P) + X25519_P) % X25519_P;
}

function modPow(base, exp) {
  let result = 1n;
  base = base % X25519_P;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % X25519_P;
    base = (base * base) % X25519_P;
    exp /= 2n;
  }
  return result;
}

function modInv(a) {
  return modPow(a, X25519_P - 2n);
}

function bytesToIntLE(bytes) {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function intToBytesLE(n, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function encodeU(u) {
  return intToBytesLE(u, 32);
}

function decodeU(bytes) {
  return bytesToIntLE(bytes);
}

/** X25519 scalar multiplication: returns u-coordinate of k * u. */
function x25519(kBytes, u) {
  const k = clampScalar(kBytes);

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t -= 1) {
    const kt = (BigInt(k[Math.floor(t / 8)]) >> BigInt(t % 8)) & 1n;
    const newSwap = kt ^ swap;
    if (newSwap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const A = mod(x2 + z2);
    const AA = mod(A * A);
    const B = mod(x2 - z2);
    const BB = mod(B * B);
    const E = mod(AA - BB);

    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = mod(D * AA);
    const CB = mod(C * BB);

    x3 = mod((C + D) * (C + D));
    z3 = mod(x1 * mod((C - D) * (C - D)));
    x2 = mod(AA * BB);
    z2 = mod(E * mod(AA + X25519_A24 * E));
  }

  return intToBytesLE(mod(x2 * modInv(z2)), 32);
}

/** Encode raw 32-byte X25519 public key to SPKI DER (Algorithm: X25519, OID 1.3.101.110). */
function encodeSPKIX25519(raw32) {
  const spki = new Uint8Array(44);
  spki[0] = 0x30; spki[1] = 0x2a; // SEQUENCE, len 42
  spki[2] = 0x30; spki[3] = 0x05; // SEQUENCE, len 5
  spki[4] = 0x06; spki[5] = 0x03; spki[6] = 0x2b; spki[7] = 0x65; spki[8] = 0x6e; // OID 1.3.101.110
  spki[9] = 0x03; spki[10] = 0x21; spki[11] = 0x00; // BIT STRING, len 33, 0 unused
  spki.set(raw32, 12);
  return spki;
}

/** Decode SPKI DER → raw 32-byte X25519 public key. Last 32 bytes of the DER. */
function decodeSPKIX25519(der) {
  if (der.length < 12) throw new Error('invalid_spki');
  return new Uint8Array(der.subarray(der.length - 32));
}
