import { describe, expect, it } from 'vitest';
import { hookBanner, type HookHealth } from '../src/shared/model';

const health = (kind: HookHealth['kind'], why?: string): HookHealth => ({ kind, reporting: false, why });

describe('hookBanner', () => {
  it('says nothing until the host has checked settings.json', () => {
    expect(hookBanner(undefined, 3)).toBeUndefined();
  });

  it('absent → warning with an install button, and the user may hide it', () => {
    const b = hookBanner(health('absent'), 0)!;
    expect(b.tone).toBe('warn');
    expect(b.action).toBe('install');
    expect(b.dismissible).toBe(true);
    expect(b.text).toMatch(/estimated/);
    expect(b.text).toMatch(/permission prompt/);
  });

  it('stale → update button, not hideable (it will keep being wrong)', () => {
    const b = hookBanner(health('stale'), 0)!;
    expect(b.action).toBe('update');
    expect(b.dismissible).toBe(false);
  });

  it('disabled quotes the reason and offers no button — installing would not help', () => {
    const b = hookBanner(health('disabled', 'disableAllHooks is true in settings.json'), 0)!;
    expect(b.tone).toBe('warn');
    expect(b.action).toBeUndefined();
    expect(b.dismissible).toBe(false);
    expect(b.text).toContain('disableAllHooks is true in settings.json');
  });

  it('unreadable is a hideable warning', () => {
    const b = hookBanner(health('unreadable', 'not valid JSON'), 0)!;
    expect(b.action).toBeUndefined();
    expect(b.dismissible).toBe(true);
    expect(b.text).toContain('not valid JSON');
  });

  it('installed with nothing estimated → nothing to say', () => {
    expect(hookBanner(health('installed'), 0)).toBeUndefined();
  });

  it('installed with pre-install sessions → info note that resolves itself, so not hideable', () => {
    const one = hookBanner(health('installed'), 1)!;
    expect(one.tone).toBe('info');
    expect(one.action).toBeUndefined();
    expect(one.dismissible).toBe(false);
    expect(one.text).toMatch(/^1 live session started/);
    expect(one.text).toMatch(/Restart it/);

    const many = hookBanner(health('installed'), 3)!;
    expect(many.text).toMatch(/^3 live sessions started/);
    expect(many.text).toMatch(/Restart them/);
  });
});
