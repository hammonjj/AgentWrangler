import { describe, expect, it } from 'vitest';
import {
  parsePermissionSuggestions,
  permissionDetail,
  suggestionDestination,
  suggestionLabels,
} from '../src/claude/permissionDetail';
import { askLine } from '../src/shared/model';

describe('permissionDetail', () => {
  it('keeps a Bash description and its command apart, newlines and all', () => {
    const d = permissionDetail('Bash', {
      command: 'cd /proj\ngit add -A src\ngit commit -q -m "x"',
      description: 'Commit the picker fix',
    });
    expect(d).toEqual({
      summary: 'Commit the picker fix',
      body: 'cd /proj\ngit add -A src\ngit commit -q -m "x"',
      isCommand: true,
    });
  });

  it('falls back to the command alone', () => {
    expect(permissionDetail('Bash', { command: 'rm -rf dist' })).toEqual({
      summary: undefined,
      body: 'rm -rf dist',
      isCommand: true,
    });
  });

  it('names the file for edits, relative to cwd when inside it', () => {
    expect(permissionDetail('Edit', { file_path: '/proj/src/a.ts', old_string: 'x', new_string: 'y' }, '/proj')?.body).toBe(
      'src/a.ts',
    );
    expect(permissionDetail('Write', { file_path: '/elsewhere/notes.md' }, '/proj')?.body).toBe('notes.md');
  });

  it('quotes the question for AskUserQuestion', () => {
    expect(
      permissionDetail('AskUserQuestion', {
        questions: [{ question: 'Which date library?', header: 'Library', options: [] }, { question: 'Dark mode?' }],
      })?.body,
    ).toBe('Which date library? (+1 more)');
  });

  it('uses the URL or query for web tools', () => {
    expect(permissionDetail('WebFetch', { url: 'https://example.com/x', prompt: 'summarise' })).toEqual({
      summary: 'summarise',
      body: 'https://example.com/x',
    });
    expect(permissionDetail('WebSearch', { query: 'vitest mock timers' })?.body).toBe('vitest mock timers');
  });

  it('picks the first string field of an unknown tool', () => {
    expect(permissionDetail('mcp__figma__get_screenshot', { nodeId: '1:2', name: 'Hero frame' })?.body).toBe(
      'Hero frame',
    );
    expect(permissionDetail('mcp__x__y', { count: 3 })).toBeUndefined();
  });

  it('caps a runaway command', () => {
    const d = permissionDetail('Bash', { command: `echo ${'a'.repeat(5000)}` });
    expect(d!.body!.length).toBeLessThanOrEqual(2000);
    expect(d!.body!.endsWith('…')).toBe(true);
  });

  it('returns nothing for a missing or non-object input', () => {
    expect(permissionDetail('Bash', undefined)).toBeUndefined();
    expect(permissionDetail('Bash', 'ls')).toBeUndefined();
  });
});

describe('askLine', () => {
  it('flattens the ask to one line for tooltips', () => {
    expect(askLine({ summary: 'Run the tests', body: 'npm test\n-- --watch' })).toBe(
      'Run the tests — npm test -- --watch',
    );
    expect(askLine({ body: 'src/a.ts' })).toBe('src/a.ts');
    expect(askLine({ summary: 'Approve the plan' })).toBe('Approve the plan');
    expect(askLine(undefined)).toBeUndefined();
    expect(askLine({})).toBeUndefined();
  });
});

describe('parsePermissionSuggestions', () => {
  const allowRule = {
    type: 'addRules',
    destination: 'localSettings',
    behavior: 'allow',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  };

  it('keeps the allow rules Claude Code offered', () => {
    expect(parsePermissionSuggestions([allowRule])).toEqual([allowRule]);
  });

  it('drops anything that is not an allow', () => {
    // A deny or an ask suggestion is a real thing for Claude Code to offer, and
    // exactly the wrong thing to apply from a button labelled Always allow.
    expect(parsePermissionSuggestions([{ ...allowRule, behavior: 'deny' }])).toEqual([]);
    expect(parsePermissionSuggestions([{ ...allowRule, behavior: 'ask' }])).toEqual([]);
  });

  it('keeps directory grants', () => {
    const dirs = { type: 'addDirectories', destination: 'session', directories: ['/proj/docs'] };
    expect(parsePermissionSuggestions([dirs])).toEqual([dirs]);
  });

  it('survives junk', () => {
    expect(parsePermissionSuggestions(undefined)).toEqual([]);
    expect(parsePermissionSuggestions('nope')).toEqual([]);
    expect(parsePermissionSuggestions([null, 42, {}, { type: 'setMode', destination: 'session', mode: 'plan' }])).toEqual(
      [],
    );
    expect(parsePermissionSuggestions([{ ...allowRule, destination: 'nowhere' }])).toEqual([]);
    expect(parsePermissionSuggestions([{ ...allowRule, rules: [{}, { toolName: 'Read' }] }])).toEqual([
      { type: 'addRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Read', ruleContent: undefined }] },
    ]);
  });

  it('describes what the button will do', () => {
    expect(suggestionLabels(parsePermissionSuggestions([allowRule]))).toEqual(['Bash(npm test:*)']);
    expect(suggestionDestination(parsePermissionSuggestions([allowRule]))).toBe("this project's local settings");
    expect(suggestionDestination([])).toBe('your Claude Code settings');
  });
});
