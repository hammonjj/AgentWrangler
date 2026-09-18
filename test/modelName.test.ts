import { describe, expect, it } from 'vitest';
import { modelChoiceLabel, modelLabel, normalizeModelId } from '../src/shared/modelName';

describe('modelLabel', () => {
  it('shortens the ids that actually appear in transcripts', () => {
    // Every one of these was read off ~/.claude/projects on this machine.
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-fable-5')).toBe('Fable 5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('puts the family first however the id ordered it', () => {
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1');
  });

  it('sees through provider prefixes and revision suffixes', () => {
    expect(modelLabel('us.anthropic.claude-opus-5-v1:0')).toBe('Opus 5');
    expect(modelLabel('anthropic/claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-sonnet-5-latest')).toBe('Sonnet 5');
  });

  it('drops a context-window suffix, which is not part of the model name', () => {
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5');
  });

  it('says nothing for a message Claude Code generated itself', () => {
    // `<synthetic>` is stamped on interrupts and local errors; it names no model.
    expect(modelLabel('<synthetic>')).toBeUndefined();
    expect(modelLabel(undefined)).toBeUndefined();
    expect(modelLabel('')).toBeUndefined();
    expect(modelLabel('   ')).toBeUndefined();
  });

  it('shows an unfamiliar model as itself rather than as a blank cell', () => {
    // A model released after this build ships must still appear in the column.
    expect(modelLabel('claude-something-9')).toBe('something-9');
    expect(modelLabel('gpt-4o')).toBe('gpt-4o');
  });

  it('normalizes without inventing a name', () => {
    expect(normalizeModelId('CLAUDE-Opus-5')).toBe('opus-5');
    expect(normalizeModelId('claude-')).toBeUndefined();
  });
});

describe('modelChoiceLabel', () => {
  it('names the model the default resolves to, instead of recommending it', () => {
    expect(modelChoiceLabel('Default (recommended)', 'claude-sonnet-4-5-20250929')).toBe('Default (Sonnet 4.5)');
  });

  it('leaves a row that already names its model alone', () => {
    // Otherwise this would read "Opus (Opus 4.1)".
    expect(modelChoiceLabel('Opus', 'claude-opus-4-1-20250805')).toBe('Opus');
    expect(modelChoiceLabel('Sonnet (with 1M context)', 'claude-sonnet-5[1m]')).toBe('Sonnet (with 1M context)');
  });

  it('drops the empty advice when there is no model to put there', () => {
    expect(modelChoiceLabel('Default (recommended)', undefined)).toBe('Default');
    expect(modelChoiceLabel('Default (recommended)', '<synthetic>')).toBe('Default');
  });
});
