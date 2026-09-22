import { describe, expect, it } from 'vitest';
import { finishedTurnStatus, needsReply } from '../src/core/needsReply';

describe('needsReply', () => {
  it('treats a closing question as needing an answer', () => {
    expect(needsReply('I found two ways to do this.\n\nWhich one do you want?')).toBe(true);
    expect(needsReply('Ready to push. Shall I go ahead?')).toBe(true);
    // Trailing markdown after the question mark is still a question.
    expect(needsReply('**Proceed with option B?**')).toBe(true);
  });

  it('treats a decision phrase without a question mark as needing an answer', () => {
    expect(needsReply('Both are one-line changes. Let me know which you prefer.')).toBe(true);
    expect(needsReply('Two options are on the table.\n\nYour call.')).toBe(true);
    expect(needsReply('I have not pushed anything. Want me to open the PR')).toBe(true);
    expect(needsReply('Choose option A or B.')).toBe(true);
    expect(needsReply('Please provide the deployment region.')).toBe(true);
    expect(needsReply('I need your approval before I can continue.')).toBe(true);
  });

  it('treats a plain report as done', () => {
    // The bulksource-frontend-68 case: a completion report that mentions open
    // review points without asking the reader to decide them now.
    const report = [
      'Option C is built, pushed, and running on feature-3.',
      '',
      '## The key call',
      '',
      "I didn't edit 60 call sites. All ~98 usages got the new UI without changing.",
      '',
      'Still open from review: whether the range popover gains an **Apply** step, and whether',
      '*this week* should mean the whole calendar period. Both are one-line changes once you decide.',
    ].join('\n');
    expect(needsReply(report)).toBe(false);
    expect(needsReply('All three fixes are implemented and committed on main as 88fa26c. I did not push.')).toBe(false);
    expect(needsReply('Implemented Select all behavior and confirmed the control works.')).toBe(false);
  });

  it('ignores question marks that are not asking the reader anything', () => {
    // Rhetorical, mid-report — only the tail is judged.
    const rhetorical = [
      'Why did the build fail? The lockfile was stale.',
      '',
      'Regenerated it and the build passes.',
      '',
      'Nothing is committed.',
    ].join('\n');
    expect(needsReply(rhetorical)).toBe(false);
    // Inside code, or a URL query string.
    expect(needsReply('Run this:\n\n```sh\ncurl "https://x.test/a?b=1"\n```')).toBe(false);
    expect(needsReply('Docs: https://example.com/search?q=picker — the field is documented there.')).toBe(false);
  });

  it('assumes a human is needed when there is nothing to judge', () => {
    // A wrong "waiting" costs a glance; a wrong "done" leaves an agent idle unnoticed.
    expect(needsReply(undefined)).toBe(true);
    expect(needsReply('')).toBe(true);
    expect(needsReply('```\nonly code\n```')).toBe(true);
  });
});

describe('finishedTurnStatus', () => {
  it.each([
    ['Implemented and pushed. All tests pass.', 'completed', 'done'],
    ['Implemented. Should I push it?', 'completed', 'waiting'],
    ['Choose option A or B.', 'completed', 'waiting'],
    [undefined, 'completed', 'waiting'],
    ['Partial output before the error.', 'failed', 'waiting'],
    ['Stopped at your request.', 'interrupted', 'waiting'],
  ] as const)('classifies %s / %s as %s', (text, outcome, expected) => {
    expect(finishedTurnStatus(text, outcome)).toBe(expected);
  });
});
