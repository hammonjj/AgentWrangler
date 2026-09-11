import { describe, expect, it } from 'vitest';
import { permissionDetail } from '../src/claude/permissionDetail';

describe('permissionDetail', () => {
  it('summarises a Bash prompt with its description and command on one line', () => {
    const d = permissionDetail('Bash', {
      command: 'cd /proj\ngit add -A src\ngit commit -q -m "x"',
      description: 'Commit the picker fix',
    });
    expect(d).toBe('Commit the picker fix — cd /proj git add -A src git commit -q -m "x"');
  });

  it('falls back to the command alone', () => {
    expect(permissionDetail('Bash', { command: 'rm -rf dist' })).toBe('rm -rf dist');
  });

  it('names the file for edits, relative to cwd when inside it', () => {
    expect(permissionDetail('Edit', { file_path: '/proj/src/a.ts', old_string: 'x', new_string: 'y' }, '/proj')).toBe(
      'src/a.ts',
    );
    expect(permissionDetail('Write', { file_path: '/elsewhere/notes.md' }, '/proj')).toBe('notes.md');
  });

  it('quotes the question for AskUserQuestion', () => {
    expect(
      permissionDetail('AskUserQuestion', {
        questions: [{ question: 'Which date library?', header: 'Library', options: [] }, { question: 'Dark mode?' }],
      }),
    ).toBe('Which date library? (+1 more)');
  });

  it('uses the URL or query for web tools', () => {
    expect(permissionDetail('WebFetch', { url: 'https://example.com/x', prompt: 'summarise' })).toBe(
      'https://example.com/x',
    );
    expect(permissionDetail('WebSearch', { query: 'vitest mock timers' })).toBe('vitest mock timers');
  });

  it('picks the first string field of an unknown tool', () => {
    expect(permissionDetail('mcp__figma__get_screenshot', { nodeId: '1:2', name: 'Hero frame' })).toBe('Hero frame');
    expect(permissionDetail('mcp__x__y', { count: 3 })).toBeUndefined();
  });

  it('caps and flattens long input', () => {
    const d = permissionDetail('Bash', { command: `echo ${'a'.repeat(500)}` });
    expect(d!.length).toBeLessThanOrEqual(160);
    expect(d!.endsWith('…')).toBe(true);
  });

  it('returns nothing for a missing or non-object input', () => {
    expect(permissionDetail('Bash', undefined)).toBeUndefined();
    expect(permissionDetail('Bash', 'ls')).toBeUndefined();
  });
});
