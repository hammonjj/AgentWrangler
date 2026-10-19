/** `dictationUploadProblem` (#185): the checks a recording sent as a pane message gets. */
import { describe, expect, it } from 'vitest';
import { DICTATION_MAX_BYTES, DICTATION_MAX_MS, dictationUploadProblem } from '../src/shared/webCapabilities';

const ok = { mime: 'audio/webm;codecs=opus', durationMs: 5000, data: 'AAAA' };

describe('dictationUploadProblem', () => {
  it('accepts a short audio recording', () => {
    expect(dictationUploadProblem(ok)).toBeUndefined();
  });

  it('refuses a type that is not audio', () => {
    expect(dictationUploadProblem({ ...ok, mime: 'text/html' })).toMatch(/not audio/);
  });

  it('refuses an empty recording', () => {
    expect(dictationUploadProblem({ ...ok, data: '' })).toMatch(/empty/);
  });

  it('refuses one longer than five minutes, or with no usable duration', () => {
    expect(dictationUploadProblem({ ...ok, durationMs: DICTATION_MAX_MS + 1 })).toMatch(/too long/);
    expect(dictationUploadProblem({ ...ok, durationMs: Number.NaN })).toMatch(/too long/);
  });

  it('refuses audio over the byte cap, measured on the base64 text', () => {
    const big = 'A'.repeat(Math.ceil((DICTATION_MAX_BYTES * 4) / 3) + 8);
    expect(dictationUploadProblem({ ...ok, data: big })).toMatch(/too long/);
  });
});
