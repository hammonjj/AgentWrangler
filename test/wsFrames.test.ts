import { describe, expect, it } from 'vitest';
import { isLoopbackHost, readCookie } from '../src/core/web/wsFrames';

describe('request guards', () => {
  it('accepts loopback hosts on our port only', () => {
    expect(isLoopbackHost('127.0.0.1:7391', 7391)).toBe(true);
    expect(isLoopbackHost('localhost:7391', 7391)).toBe(true);
    expect(isLoopbackHost('[::1]:7391', 7391)).toBe(true);
    expect(isLoopbackHost('evil.example:7391', 7391)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:80', 7391)).toBe(false);
    expect(isLoopbackHost(undefined, 7391)).toBe(false);
  });

  it('reads a cookie', () => {
    expect(readCookie('a=1; aw_web=tok; b=2', 'aw_web')).toBe('tok');
    expect(readCookie('aw_webx=tok', 'aw_web')).toBeUndefined();
  });
});
