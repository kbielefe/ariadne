// Sealed frames for the relay spool. The recipient's key opens them; the relay's does not.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PUB = 32;
const NONCE = 24;

/** Box `plain` so only the Ed25519 public key `recipientPub` (32 bytes) can open it. */
export function seal(recipientPub: Uint8Array, plain: Uint8Array): Uint8Array {
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = sha256(x25519.getSharedSecret(eph, ed25519.utils.toMontgomery(recipientPub)));
  const nonce = randomBytes(NONCE);
  const ct = xchacha20poly1305(key, nonce).encrypt(plain);
  const out = new Uint8Array(PUB + NONCE + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, PUB);
  out.set(ct, PUB + NONCE);
  return out;
}

/** `seed` is the 32-byte Ed25519 seed (the first half of a libp2p raw private key). */
export function openSeal(seed: Uint8Array, box: Uint8Array): Uint8Array {
  if (box.length < PUB + NONCE + 16) throw new Error('sealed frame is too short');
  const ephPub = box.subarray(0, PUB);
  const nonce = box.subarray(PUB, PUB + NONCE);
  const ct = box.subarray(PUB + NONCE);
  const key = sha256(x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(seed), ephPub));
  return xchacha20poly1305(key, nonce).decrypt(ct);
}
