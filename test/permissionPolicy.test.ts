import { describe, expect, it } from 'vitest';
import {
  autoAllowSubagentAsk,
  bashCommandAllowed,
  normalizePart,
  parseRule,
  splitCommand,
} from '../src/claude/permissionPolicy';
import { rulesFromSettings } from '../src/claude/permissionRules';

const rules = { allow: ['Bash(git push:*)', 'Bash(tail:*)', 'Bash(npm test)', 'Read'], deny: ['Bash(git push --force:*)'] };

describe('parseRule', () => {
  it('splits tool and content', () => {
    expect(parseRule('Bash(git push:*)')).toEqual({ tool: 'Bash', content: 'git push:*' });
    expect(parseRule('Read')).toEqual({ tool: 'Read' });
  });
});

describe('splitCommand', () => {
  it('splits on pipes, && and ;', () => {
    expect(splitCommand('a && b | c; d')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('keeps quoted operators together', () => {
    expect(splitCommand('echo "a | b"')).toEqual(['echo "a | b"']);
  });
  it('refuses substitution and unbalanced quotes', () => {
    expect(splitCommand('echo $(rm -rf /)')).toBeUndefined();
    expect(splitCommand('echo `x`')).toBeUndefined();
    expect(splitCommand('echo "x')).toBeUndefined();
  });
});

describe('normalizePart', () => {
  it('drops git -C and stderr merges', () => {
    expect(normalizePart('git -C /Users/test/proj push origin main 2>&1')).toBe('git push origin main');
  });
});

describe('bashCommandAllowed', () => {
  it('allows the piped git -C push', () => {
    expect(bashCommandAllowed('git -C /Users/test/proj push origin a:refs/heads/a 2>&1 | tail -5', rules)).toBe(true);
  });
  it('needs every part covered', () => {
    expect(bashCommandAllowed('git push origin a && rm -rf x', rules)).toBe(false);
  });
  it('deny wins, even through git -C', () => {
    expect(bashCommandAllowed('git -C /Users/test/proj push --force origin a', rules)).toBe(false);
  });
  it('an exact rule matches only itself', () => {
    expect(bashCommandAllowed('npm test', rules)).toBe(true);
    expect(bashCommandAllowed('npm test -- --watch', rules)).toBe(false);
  });
  it('a command with substitution is never covered', () => {
    expect(bashCommandAllowed('git push $(echo origin)', rules)).toBe(false);
  });
});

describe('autoAllowSubagentAsk', () => {
  const bash = { toolName: 'Bash', input: { command: 'git push origin a' } };
  it('only for subagents', () => {
    expect(autoAllowSubagentAsk(bash, rules)).toBe(false);
    expect(autoAllowSubagentAsk({ ...bash, agentId: 'a1' }, rules)).toBe(true);
  });
  it('a user ask rule forces a human', () => {
    expect(autoAllowSubagentAsk({ ...bash, agentId: 'a1', matchedAskRule: { source: 'x', toolName: 'Bash' } }, rules)).toBe(false);
  });
  it('bare tool rule covers that tool; questions and plans never', () => {
    expect(autoAllowSubagentAsk({ toolName: 'Read', input: {}, agentId: 'a1' }, rules)).toBe(true);
    expect(autoAllowSubagentAsk({ toolName: 'AskUserQuestion', input: {}, agentId: 'a1' }, { allow: ['AskUserQuestion'], deny: [] })).toBe(false);
  });
});

describe('rulesFromSettings', () => {
  it('reads permissions and tolerates junk', () => {
    expect(rulesFromSettings({ permissions: { allow: ['Read', 3], deny: ['Bash(rm:*)'] } })).toEqual({ allow: ['Read'], deny: ['Bash(rm:*)'] });
    expect(rulesFromSettings(null)).toEqual({ allow: [], deny: [] });
  });
});
