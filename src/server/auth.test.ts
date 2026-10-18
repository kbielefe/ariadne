import { describe, expect, it } from 'vitest';
import { cookieValue, originAllowed, secretEqual } from './auth';

describe('auth helpers', () => {
  it('compares secrets in constant time', () => {
    expect(secretEqual('abcd', 'abcd')).toBe(true);
    expect(secretEqual('abcd', 'abce')).toBe(false);
    expect(secretEqual('abcd', 'abc')).toBe(false);
  });

  it('reads a named cookie', () => {
    expect(cookieValue('a=1; ariadne_token=secret%21; b=2', 'ariadne_token')).toBe('secret!');
    expect(cookieValue('x=y', 'ariadne_token')).toBeUndefined();
  });

  it('allows http and https origins for allowed hosts', () => {
    const hosts = ['127.0.0.1:3100', 'ariadne.example'];
    expect(originAllowed('http://127.0.0.1:3100', hosts)).toBe(true);
    expect(originAllowed('https://ariadne.example', hosts)).toBe(true);
    expect(originAllowed('https://evil.example', hosts)).toBe(false);
    expect(originAllowed('ftp://ariadne.example', hosts)).toBe(false);
  });
});
