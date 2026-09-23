import { describe, expect, it } from 'vitest';
import { describeDictation, joinTranscript, spliceDictation } from '../src/shared/dictationText';

describe('joinTranscript', () => {
  it('joins pieces with one space and skips silent ones', () => {
    expect(joinTranscript(['add a test', '', '  for the composer ', ''])).toBe('add a test for the composer');
  });

  it('is empty when nothing was heard', () => {
    expect(joinTranscript([])).toBe('');
    expect(joinTranscript(['', '  '])).toBe('');
  });
});

describe('spliceDictation', () => {
  it('fills an empty box without a leading space', () => {
    expect(spliceDictation('', 0, 'run the tests')).toEqual({ value: 'run the tests', caret: 13 });
  });

  it('keeps what was typed and continues after it', () => {
    const r = spliceDictation('Please', 6, 'run the tests');
    expect(r.value).toBe('Please run the tests');
    expect(r.caret).toBe(r.value.length);
  });

  it('does not double a space that is already there', () => {
    expect(spliceDictation('Please ', 7, 'run it').value).toBe('Please run it');
  });

  it('inserts mid-text with a space on each side, leaving both halves intact', () => {
    const r = spliceDictation('Fix bug', 3, 'the login');
    expect(r.value).toBe('Fix the login bug');
    expect(r.caret).toBe('Fix the login'.length);
  });

  it('leaves punctuation after the caret touching the dictated words', () => {
    expect(spliceDictation('Fix .', 4, 'this').value).toBe('Fix this.');
  });

  it('never removes existing text, even for an out-of-range caret', () => {
    expect(spliceDictation('draft', 99, 'more').value).toBe('draft more');
    expect(spliceDictation('draft', -5, 'more').value).toBe('more draft');
  });

  it('changes nothing for an empty result', () => {
    expect(spliceDictation('keep me', 4, '   ')).toEqual({ value: 'keep me', caret: 4 });
  });

  it('adds each dictation once: two in a row do not repeat or merge words', () => {
    let box = spliceDictation('Draft:', 6, 'first part');
    box = spliceDictation(box.value, box.caret, 'second part');
    expect(box.value).toBe('Draft: first part second part');
  });
});

describe('describeDictation', () => {
  const base = { state: 'recording' as const, livePreview: true, recordedMs: 2000, coveredMs: 1800 };

  it('marks the preview as provisional while listening', () => {
    const v = describeDictation(base);
    expect(v.label).toMatch(/preview, may change/);
    expect(v.tone).toBe('live');
    expect(v.detail).toBeUndefined();
  });

  it('says when the preview has fallen behind, and that nothing is lost', () => {
    const v = describeDictation({ ...base, recordedMs: 9000, coveredMs: 4000 });
    expect(v.tone).toBe('warn');
    expect(v.detail).toContain('5s behind');
    expect(v.detail).toContain('nothing is lost');
  });

  it('explains a slow first pass rather than showing nothing', () => {
    expect(describeDictation({ ...base, recordedMs: 4000, coveredMs: 0 }).detail).toMatch(/Starting the recogniser/);
  });

  it('reports a failed preview without implying the recording failed', () => {
    const v = describeDictation({ ...base, previewError: 'whisper exited 1' });
    expect(v.tone).toBe('warn');
    expect(v.detail).toContain('still transcribed');
  });

  it('distinguishes finishing from recording', () => {
    expect(describeDictation({ ...base, state: 'transcribing' })).toMatchObject({ label: 'Finishing transcription…', tone: 'busy' });
    expect(describeDictation({ ...base, state: 'transcribing', elsewhere: true }).label).toMatch(/conversation you left/);
  });

  it('does not promise a preview when live preview is off', () => {
    const v = describeDictation({ ...base, livePreview: false });
    expect(v.label).toBe('Recording');
  });
});
