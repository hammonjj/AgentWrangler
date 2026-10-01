import { describe, expect, it } from 'vitest';
import { localModelName, modelChoiceLabel, modelLabel, normalizeModelId } from '../src/shared/modelName';

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

describe('modelLabel for local paths', () => {
  it('shows the model directory, not the machine path', () => {
    expect(modelLabel('/Users/test/Models/Qwen3.5-4B-MLX-4bit')).toBe('Qwen3.5-4B-MLX-4bit');
    expect(modelLabel('local:/Users/test/Models/Qwen3.5-4B-MLX-4bit')).toBe('Qwen3.5-4B-MLX-4bit');
    expect(modelLabel('~/models/llama-3-8b-q4_k_m.gguf')).toBe('llama-3-8b-q4_k_m.gguf');
  });

  it('handles trailing separators and Windows paths', () => {
    expect(modelLabel('/Users/test/Models/qwen-4bit/')).toBe('qwen-4bit');
    expect(modelLabel('C:\\models\\qwen-4bit')).toBe('qwen-4bit');
    expect(modelLabel('C:/models/qwen-4bit\\')).toBe('qwen-4bit');
    expect(modelLabel('\\\\nas\\share\\qwen-4bit')).toBe('qwen-4bit');
  });

  it('keeps variant and quantization, which tell two builds apart', () => {
    expect(modelLabel('/m/qwen-4bit')).not.toBe(modelLabel('/m/qwen-8bit'));
  });

  it('leaves hosted ids, repo ids and URLs to the normal rules', () => {
    expect(modelLabel('gpt-4o')).toBe('gpt-4o');
    expect(modelLabel('anthropic/claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('mlx-community/Qwen-4bit')).toBe('mlx-community/qwen-4bit');
    expect(modelLabel('https://example.test/models/qwen')).toBe('https://example.test/models/qwen');
    expect(localModelName('gpt-4o')).toBeUndefined();
  });

  it('does not invent a name for a bare root or an empty value', () => {
    expect(localModelName('/')).toBeUndefined();
    expect(localModelName('C:\\')).toBeUndefined();
    expect(localModelName('local:')).toBeUndefined();
    expect(localModelName(undefined)).toBeUndefined();
    expect(modelLabel('')).toBeUndefined();
  });

  it('shares the label for same-named models in different directories', () => {
    // Deliberate: the tooltip carries the full path, which is what tells them apart.
    expect(modelLabel('/a/qwen')).toBe(modelLabel('/b/qwen'));
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
