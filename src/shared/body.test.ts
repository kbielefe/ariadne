import { describe, expect, it } from 'vitest';
import { patchBody } from './body';

const doc = ['**What:** a thing.', '', '## Log', '', '- one', '', '### Detail', 'deep', '', '## Notes', 'n'].join('\n');

describe('patchBody', () => {
  it('leaves the body alone, replaces it, or appends with one blank line', () => {
    expect(patchBody('a', {})).toBeUndefined();
    expect(patchBody('a', { body: 'b' })).toBe('b');
    expect(patchBody('a\n\n', { append: '\nb' })).toBe('a\n\nb');
    expect(patchBody('', { append: 'b' })).toBe('b');
    expect(() => patchBody('a', { body: 'b', append: 'c' })).toThrow(/not both/);
  });

  it('replaces a section up to the next heading of the same level, keeping subsections inside it', () => {
    expect(patchBody(doc, { section: '## Log', body: '- two' })).toBe('**What:** a thing.\n\n## Log\n\n- two\n\n## Notes\nn');
    expect(patchBody(doc, { section: 'Notes', body: 'm' })).toBe(doc.replace('## Notes\nn', '## Notes\n\nm'));
    expect(patchBody(doc, { section: '### Detail', body: 'shallow' })).toBe(doc.replace('### Detail\ndeep', '### Detail\n\nshallow'));
  });

  it('appends to the end of a section', () => {
    expect(patchBody(doc, { section: '## Log', append: '- two' })).toBe(doc.replace('deep\n', 'deep\n\n- two\n'));
  });

  it('creates a missing section at the end, and ignores headings in code fences', () => {
    expect(patchBody('a', { section: 'Log', append: '- one' })).toBe('a\n\n## Log\n\n- one');
    const fenced = '```\n## Log\n```\n\n## Log\nx';
    expect(patchBody(fenced, { section: '## Log', body: 'y' })).toBe('```\n## Log\n```\n\n## Log\n\ny');
    expect(() => patchBody('a', { section: 'Log' })).toThrow(/needs body/);
  });
});
