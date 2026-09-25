import { describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';

function settings(doc: Record<string, unknown>) {
  return { get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback) };
}

/**
 * Parity with the reads `createApp` made before #26: trimmed strings, empty
 * meaning "the CLI's own default", Claude's permission mode defaulting to
 * `auto`, and a resume keeping what the registry remembers.
 */
describe('LaunchDefaults', () => {
  it('reads Claude defaults the way createApp did', () => {
    expect(new LaunchDefaults(settings({})).for('claude')).toEqual({ model: undefined, effort: undefined, permissionMode: 'auto' });
    const d = new LaunchDefaults(settings({ 'runner.model': ' opus ', 'runner.effort': 'high', 'runner.defaultPermissionMode': 'plan' }));
    expect(d.for('claude')).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' });
  });

  it('reads Codex defaults with no permission mode', () => {
    const d = new LaunchDefaults(settings({ 'codexRunner.model': 'gpt-x', 'codexRunner.effort': '  ', 'runner.model': 'opus' }));
    expect(d.for('codex')).toEqual({ model: 'gpt-x', effort: undefined });
  });

  it('re-reads on every call', () => {
    const doc: Record<string, unknown> = {};
    const d = new LaunchDefaults(settings(doc));
    doc['runner.effort'] = 'low';
    expect(d.for('claude').effort).toBe('low');
  });

  it('a resume keeps the recorded launch, field by field', () => {
    const d = new LaunchDefaults(settings({ 'runner.model': 'sonnet', 'runner.effort': 'medium' }));
    expect(d.resumed('claude', { model: 'opus', permissionMode: 'acceptEdits' })).toEqual({
      model: 'opus',
      effort: 'medium',
      permissionMode: 'acceptEdits',
    });
    expect(d.resumed('claude')).toEqual({ model: 'sonnet', effort: 'medium', permissionMode: 'auto' });
  });

  it('builds a launch request with overrides on top', () => {
    const d = new LaunchDefaults(settings({ 'runner.model': 'sonnet' }));
    expect(d.request('claude', '/Users/test/proj', { effort: 'max' })).toEqual({
      provider: 'claude',
      cwd: '/Users/test/proj',
      model: 'sonnet',
      effort: 'max',
      permissionMode: 'auto',
    });
  });
});
