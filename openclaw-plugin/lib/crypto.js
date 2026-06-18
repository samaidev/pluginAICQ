/**
 * AICQ Crypto Utilities
 * NaCl-based E2EE: Ed25519 signing, X25519 key exchange, symmetric encryption
 */
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

// ─── Key Generation ────────────────────────────────────────────────────

function generateSigningKeypair() {
  const keyPair = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
    publicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(keyPair.secretKey).toString('base64'),
  };
}

function generateExchangeKeypair() {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
    publicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(keyPair.secretKey).toString('base64'),
  };
}

// ─── Signing ───────────────────────────────────────────────────────────

function signMessage(message, secretKeyHex) {
  const secretKey = Buffer.from(secretKeyHex, 'hex');
  // If message looks like hex (64 chars), treat as raw bytes to match server's bytes.fromhex()
  let messageBytes;
  if (/^[0-9a-fA-F]{64}$/.test(message)) {
    messageBytes = Buffer.from(message, 'hex');
  } else {
    messageBytes = naclUtil.decodeUTF8(message);
  }
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return Buffer.from(signature).toString('hex');
}

function verifySignature(message, signatureHex, publicKeyHex) {
  try {
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    // If message looks like hex (64 chars), treat as raw bytes to match server
    let messageBytes;
    if (/^[0-9a-fA-F]{64}$/.test(message)) {
      messageBytes = Buffer.from(message, 'hex');
    } else {
      messageBytes = naclUtil.decodeUTF8(message);
    }
    const signature = Buffer.from(signatureHex, 'hex');
    return nacl.sign.detached.verify(messageBytes, signature, publicKey);
  } catch (e) {
    return false;
  }
}

// ─── Key Exchange & Session Key Derivation ─────────────────────────────

function deriveSessionKey(ourSecretKeyHex, theirPublicKeyHex) {
  const ourSecret = Buffer.from(ourSecretKeyHex, 'hex');
  const theirPublic = Buffer.from(theirPublicKeyHex, 'hex');
  const shared = nacl.box.before(theirPublic, ourSecret);
  const hash = nacl.hash(shared);
  // Return base64 to match the encoding expected by encryptMessage/decryptMessage
  return Buffer.from(hash).toString('base64');
}

// ─── Symmetric Encryption (NaCl SecretBox) ─────────────────────────────

function encryptMessage(plaintext, sessionKeyB64) {
  const key = Buffer.from(sessionKeyB64, 'base64');
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = naclUtil.decodeUTF8(plaintext);
  const encrypted = nacl.secretbox(messageBytes, nonce, key);
  if (!encrypted) throw new Error('Encryption failed');
  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('base64');
}

function decryptMessage(ciphertextB64, sessionKeyB64) {
  const key = Buffer.from(sessionKeyB64, 'base64');
  const combined = Buffer.from(ciphertextB64, 'base64');
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) throw new Error('Decryption failed');
  return naclUtil.encodeUTF8(decrypted);
}

// ─── Fingerprint ───────────────────────────────────────────────────────

function computeFingerprint(publicKeyHex) {
  const publicKey = Buffer.from(publicKeyHex, 'hex');
  const hash = nacl.hash(publicKey);
  const hex = Buffer.from(hash).toString('hex');
  return hex.match(/.{2}/g).join(':');
}

// NOTE: encryptWithPassword / decryptWithPassword / convertEd25519ToX25519 were
// removed in v3.7.0 because they were dead code with incorrect implementations:
//   - encryptWithPassword/decryptWithPassword used a broken hash-based KDF
//     (not a proper PBKDF) — vulnerable to brute force.
//   - convertEd25519ToX25519 used nacl.sign.keyPair.fromSeed on the *public*
//     key, which is cryptographically incorrect; the fallback hash was also
//     wrong.
// If you need these features, use a proper implementation:
//   - For password-based encryption: use `argon2` or `scrypt` to derive a key.
//   - For Ed25519 -> X25519: use the curve25519 conversion math directly
//     (see https://github.com/dchest/ed2curve-js for a reference implementation).

module.exports = {
  generateSigningKeypair,
  generateExchangeKeypair,
  signMessage,
  verifySignature,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  computeFingerprint,
  randomBytes: (n) => Buffer.from(nacl.randomBytes(n)).toString('base64'),
};
