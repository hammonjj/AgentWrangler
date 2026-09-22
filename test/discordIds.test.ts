import { describe, expect, it } from 'vitest';
import { decodeCustomId, encodeCustomId, MAX_CUSTOM_ID } from '../src/remote/discord/ids';

const ID = 'AbCd1234_-efGhIjKlMn';

describe('custom_id', () => {
  it('round-trips', () => {
    expect(decodeCustomId(encodeCustomId(ID, 'allow'))).toEqual({ interactionId: ID, choiceId: 'allow' });
  });

  it('round-trips every choice v1 offers', () => {
    for (const choice of ['allow', 'always', 'deny']) {
      expect(decodeCustomId(encodeCustomId(ID, choice))?.choiceId).toBe(choice);
    }
  });

  it('stays inside Discord’s length limit for a real id', () => {
    // 16 random bytes as base64url is 22 chars; the longest label we build.
    expect(encodeCustomId('A'.repeat(22), 'always').length).toBeLessThanOrEqual(MAX_CUSTOM_ID);
  });

  describe('rejects', () => {
    const bad: [string, unknown][] = [
      ['a non-string', 12345],
      ['undefined', undefined],
      ['an empty string', ''],
      ['another app’s component', 'other:abcdefgh:allow'],
      ['no prefix', `${ID}:allow`],
      ['too few parts', 'aw:allow'],
      ['too many parts', `aw:${ID}:allow:extra`],
      ['an empty interaction id', 'aw::allow'],
      ['an empty choice', `aw:${ID}:`],
      ['a short interaction id', 'aw:abc:allow'],
      ['punctuation in the interaction id', 'aw:abcd/efgh.ijkl:allow'],
      ['uppercase in the choice', `aw:${ID}:ALLOW`],
      ['a choice with digits', `aw:${ID}:allow1`],
      ['something longer than the limit', `aw:${'A'.repeat(200)}:allow`],
    ];
    for (const [name, input] of bad) {
      it(name, () => expect(decodeCustomId(input)).toBeUndefined());
    }
  });

  it('refuses to build an id that Discord would reject', () => {
    // Better to throw where the cause is visible than to publish a card whose
    // buttons silently fail to render.
    expect(() => encodeCustomId('A'.repeat(200), 'allow')).toThrow(/too long/);
    expect(() => encodeCustomId('short', 'allow')).toThrow(/alphabet/);
    expect(() => encodeCustomId(ID, 'Allow')).toThrow(/alphabet/);
  });

  it('cannot be made to impersonate two fields with one', () => {
    // A separator smuggled into either field would otherwise reshape the id.
    expect(() => encodeCustomId(`${ID}:deny`, 'allow')).toThrow();
    expect(decodeCustomId(`aw:${ID}:deny:allow`)).toBeUndefined();
  });

  it('carries nothing but the handle and the choice', () => {
    // Discord echoes this back from the client, so it must confer no authority
    // and disclose nothing: no session id, no marker id, no path, no tool name.
    const id = encodeCustomId(ID, 'allow');
    expect(id).toBe(`aw:${ID}:allow`);
    expect(id).not.toMatch(/claude:|\/|\.jsonl|Bash/);
  });
});
