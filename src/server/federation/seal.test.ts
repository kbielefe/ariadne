import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { openSeal, seal } from './seal';

describe('seal', () => {
  it('opens for the recipient and not for anyone else', () => {
    const a = ed25519.keygen();
    const b = ed25519.keygen();
    const box = seal(a.publicKey, new TextEncoder().encode('secret-from-c'));
    expect(new TextDecoder().decode(openSeal(a.secretKey, box))).toBe('secret-from-c');
    expect(() => openSeal(b.secretKey, box)).toThrow();
    expect(Buffer.from(box).toString('utf8')).not.toContain('secret-from-c');
  });
});
