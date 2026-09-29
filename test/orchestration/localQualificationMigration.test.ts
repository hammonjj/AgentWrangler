import { describe, expect, it } from 'vitest';
import { LocalEndpointService } from '../../src/orchestration/local/localEndpointService';
import { known, UNKNOWN } from '../../src/shared/orchestration/catalog';
import type { EndpointProbe, Qualification } from '../../src/shared/orchestration/localModels';

const probe: EndpointProbe = {
  at: 1,
  reachable: true,
  runtime: known('llama.cpp', 'probed'),
  models: [{ id: 'qwen', contextWindow: known(65536, 'probed'), vision: UNKNOWN }],
  slots: known(1, 'probed'),
  routes: { responses: known(true, 'probed'), messages: known(true, 'probed') },
  structuredOutput: UNKNOWN,
  healthPath: '/v1/models',
};
const qualification: Qualification = {
  model: 'qwen', at: 2, toolCalls: { ok: 10, runs: 10 }, roundTrips: { ok: 10, runs: 10 },
  json: { ok: 20, runs: 20 }, toolCalling: 'basic', structuredOutput: 'json', streaming: true, verdict: 'agentic',
};

describe('local qualification storage', () => {
  it('migrates an old model result to Codex without qualifying Claude Code', () => {
    const service = new LocalEndpointService({
      settings: {
        get: (_key, fallback) => ([{ id: 'box', name: 'Box', url: 'http://127.0.0.1:18080' }] as unknown as typeof fallback),
        update: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
      },
      storage: { get: <T>() => ({ v: 1, probes: { box: probe }, qualifications: { box: { qwen: qualification } } }) as T, update: () => undefined },
    });
    expect(service.reports()[0].descriptor.qualifiedHarnesses).toEqual(['codex']);
    expect(service.view()[0].models[0].qualifications).toMatchObject({ codex: expect.stringContaining('Agentic') });
    expect(service.view()[0].models[0].qualifications?.['claude-code']).toBeUndefined();
    service.dispose();
  });

  it('stores task qualification for the harness that ran it', async () => {
    const service = new LocalEndpointService({
      settings: {
        get: (_key, fallback) => ([{ id: 'box', name: 'Box', url: 'http://127.0.0.1:18080' }] as unknown as typeof fallback),
        update: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
      },
      storage: { get: <T>() => ({ v: 1, probes: { box: probe }, qualifications: {} }) as T, update: () => undefined },
    });
    service.useTaskQualifier(async ({ onStart, onRun }) => {
      const run = { fixture: 'synthetic', n: 1, pass: true, testsPass: true, testsUntouched: true, diffInside: true, turns: 1, toolCalls: 1, wallMs: 10 };
      onStart(1);
      onRun(run);
      return { runs: [run], k: 1 };
    }, 'claude-code');
    expect((await service.qualifyTasks('box', 'qwen', 'claude-code')).ok).toBe(true);
    expect(service.taskQualification('box', 'qwen', 'claude-code')).toMatchObject({ runnable: true, passed: 1 });
    expect(service.taskQualification('box', 'qwen', 'codex')).toBeUndefined();
    service.dispose();
  });
});
