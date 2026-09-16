import { describe, expect, it } from 'vitest';
import {
  fileUriToPath,
  fileUrisToPaths,
  imageMediaType,
  mentionForPath,
  relativeToCwd,
} from '../src/shared/attachments';

describe('imageMediaType', () => {
  it('names the media type for the images the API accepts', () => {
    expect(imageMediaType('/Users/test/proj/shot.png')).toBe('image/png');
    expect(imageMediaType('/Users/test/proj/shot.JPG')).toBe('image/jpeg');
    expect(imageMediaType('/Users/test/proj/a.jpeg')).toBe('image/jpeg');
    expect(imageMediaType('/Users/test/proj/a.gif')).toBe('image/gif');
    expect(imageMediaType('/Users/test/proj/a.webp')).toBe('image/webp');
  });

  it('is nothing for anything else, so it goes in as a path', () => {
    expect(imageMediaType('/Users/test/proj/src/main.ts')).toBeUndefined();
    expect(imageMediaType('/Users/test/proj/shot.tiff')).toBeUndefined();
    expect(imageMediaType('/Users/test/proj/Makefile')).toBeUndefined();
    expect(imageMediaType('/Users/test/proj/src')).toBeUndefined();
  });
});

describe('fileUriToPath', () => {
  it('decodes a percent-escaped path', () => {
    expect(fileUriToPath('file:///Users/test/proj/my%20notes.md')).toBe('/Users/test/proj/my notes.md');
    expect(fileUriToPath('file:///Users/test/proj/caf%C3%A9.ts')).toBe('/Users/test/proj/café.ts');
  });

  it('treats a localhost authority as this machine and keeps a real one', () => {
    expect(fileUriToPath('file://localhost/Users/test/proj/a.ts')).toBe('/Users/test/proj/a.ts');
    expect(fileUriToPath('file://share/team/a.ts')).toBe('//share/team/a.ts');
  });

  it('drops the query and fragment VSCode can append', () => {
    expect(fileUriToPath('file:///Users/test/proj/a.ts?x=1#L3')).toBe('/Users/test/proj/a.ts');
  });

  it('is nothing for another scheme or a broken escape', () => {
    expect(fileUriToPath('https://example.com/a.png')).toBeUndefined();
    expect(fileUriToPath('untitled:Untitled-1')).toBeUndefined();
    expect(fileUriToPath('file:///Users/test/%ZZ')).toBeUndefined();
  });
});

describe('fileUrisToPaths', () => {
  it('reads one URI per line and skips comments and blanks', () => {
    const list = ['# dropped', 'file:///Users/test/proj/a.ts', '', 'file:///Users/test/proj/b%20c.ts', ''].join('\r\n');
    expect(fileUrisToPaths(list)).toEqual(['/Users/test/proj/a.ts', '/Users/test/proj/b c.ts']);
  });

  it('keeps only the local files out of a mixed drop', () => {
    const list = 'https://example.com/x.png\nfile:///Users/test/proj/a.ts';
    expect(fileUrisToPaths(list)).toEqual(['/Users/test/proj/a.ts']);
  });

  it('is empty for a drop that names nothing', () => {
    expect(fileUrisToPaths('')).toEqual([]);
  });
});

describe('relativeToCwd', () => {
  it('relativises a file inside the session folder', () => {
    expect(relativeToCwd('/Users/test/proj', '/Users/test/proj/src/main.ts')).toBe('src/main.ts');
    expect(relativeToCwd('/Users/test/proj/', '/Users/test/proj/src/main.ts')).toBe('src/main.ts');
    expect(relativeToCwd('/Users/test/proj', '/Users/test/proj')).toBe('.');
  });

  it('leaves a file outside it alone, including a sibling with a shared prefix', () => {
    expect(relativeToCwd('/Users/test/proj', '/Users/test/other/a.ts')).toBeUndefined();
    expect(relativeToCwd('/Users/test/proj', '/Users/test/proj-2/a.ts')).toBeUndefined();
    expect(relativeToCwd('', '/Users/test/proj/a.ts')).toBeUndefined();
  });
});

describe('mentionForPath', () => {
  it('mentions a file in the session folder by its relative path', () => {
    expect(mentionForPath('/Users/test/proj', '/Users/test/proj/src/main.ts')).toBe('@src/main.ts');
  });

  it('mentions one outside it in full', () => {
    expect(mentionForPath('/Users/test/proj', '/Users/test/notes/plan.md')).toBe('@/Users/test/notes/plan.md');
  });

  it('quotes a path with a space, which would otherwise end at the first word', () => {
    expect(mentionForPath('/Users/test/proj', '/Users/test/proj/my notes.md')).toBe('@"my notes.md"');
  });
});
