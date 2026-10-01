import { describe, expect, it } from 'vitest';
import { normalizeRepo, sameRepo } from './workmcp';

describe('repo matching', () => {
  it('treats https, ssh, and scp-style URLs of one repo as the same', () => {
    expect(normalizeRepo('git@github.com:Kb/Ariadne.git')).toBe('github.com/kb/ariadne');
    expect(normalizeRepo('https://github.com/kb/ariadne/')).toBe('github.com/kb/ariadne');
    expect(sameRepo('ssh://git@bitbucket.example:7999/proj/repo.git', { name: 'repo', url: 'https://bitbucket.example/scm/proj/repo.git' })).toBe(true);
    expect(sameRepo('git@github.com:other/ariadne.git', { name: 'x', url: 'https://github.com/kb/ariadne' })).toBe(false);
  });
  it('matches a local path or bare name by repo name', () => {
    expect(sameRepo('/home/me/src/ariadne', { name: 'x', url: 'https://github.com/kb/ariadne' })).toBe(true);
    expect(sameRepo('Ariadne', { name: 'ariadne' })).toBe(true);
    expect(sameRepo('ariadne', { name: 'other' })).toBe(false);
  });
});
