import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

export interface Identity {
  key: Ed25519PrivateKey;
  peerId: string;
  /** 32-byte Ed25519 seed, for opening sealed spool frames. */
  seed: Uint8Array;
  publicKey: Uint8Array;
}

export async function loadIdentity(file: string): Promise<Identity> {
  let key: Ed25519PrivateKey;
  try {
    key = privateKeyFromProtobuf(new Uint8Array(await readFile(file))) as Ed25519PrivateKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    key = await generateKeyPair('Ed25519');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, privateKeyToProtobuf(key), { mode: 0o600 });
  }
  return ident(key);
}

export function ident(key: Ed25519PrivateKey): Identity {
  return { key, peerId: peerIdFromPrivateKey(key).toString(), seed: key.raw.subarray(0, 32), publicKey: key.publicKey.raw };
}
