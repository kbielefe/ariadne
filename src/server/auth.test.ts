import { describe, expect, it } from 'vitest';
import { originAllowed } from './auth';

describe('originAllowed', () => {
  it('allows http and https origins for allowed hosts', () => {
    const hosts = ['127.0.0.1:3100', 'ariadne.bielefeldt.dev'];
    expect(originAllowed('http://127.0.0.1:3100', hosts)).toBe(true);
    expect(originAllowed('https://ariadne.bielefeldt.dev', hosts)).toBe(true);
    expect(originAllowed('https://evil.example', hosts)).toBe(false);
    expect(originAllowed('ftp://ariadne.bielefeldt.dev', hosts)).toBe(false);
  });
});
