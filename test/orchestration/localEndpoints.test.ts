/** The local endpoint registry's pure rules (#51): loopback, defaults, parsing, changes. */
import { describe, expect, it } from 'vitest';
import {
  addEndpoint,
  endpointEnabled,
  endpointIdOf,
  endpointIsLocal,
  endpointLocation,
  isLoopbackUrl,
  isPrivateNetworkUrl,
  localEndpointChange,
  newEndpointId,
  normaliseEndpointUrl,
  parseLocalEndpoints,
} from '../../src/shared/orchestration/localEndpoints';

describe('isLoopbackUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://127.8.9.10', true],
    ['http://localhost:1234/v1', true],
    ['http://[::1]:8080', true],
    ['http://api.localhost', true],
    ['http://0.0.0.0:8080', false],
    ['http://192.168.1.20:8080', false],
    ['https://api.example.com', false],
    ['http://128.0.0.1', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe('defaults', () => {
  it('loopback is on and local; anything else is off and hosted until turned on', () => {
    expect(endpointEnabled({ url: 'http://127.0.0.1:1' })).toBe(true);
    expect(endpointLocation({ url: 'http://127.0.0.1:1' })).toBe('local');
    expect(endpointEnabled({ url: 'http://10.0.0.5:1' })).toBe(false);
    expect(endpointLocation({ url: 'http://10.0.0.5:1' })).toBe('hosted');
    expect(endpointEnabled({ url: 'http://10.0.0.5:1', enabled: true })).toBe(true);
    expect(endpointEnabled({ url: 'http://127.0.0.1:1', enabled: false })).toBe(false);
  });

  it('a private-network endpoint declared local is on and local by default', () => {
    const lan = { url: 'http://192.168.4.20:8080', location: 'local' as const };
    expect(endpointIsLocal(lan)).toBe(true);
    expect(endpointEnabled(lan)).toBe(true);
    expect(endpointLocation(lan)).toBe('local');
    expect(endpointEnabled({ ...lan, enabled: false })).toBe(false);
    // Declared on a public host (settings edited by hand, skipping the parser): still hosted.
    const pub = { url: 'https://api.example.com', location: 'local' as const };
    expect(endpointIsLocal(pub)).toBe(false);
    expect(endpointEnabled(pub)).toBe(false);
    expect(endpointLocation(pub)).toBe('hosted');
  });
});

describe('isPrivateNetworkUrl', () => {
  it.each([
    ['http://10.0.0.5:8080', true],
    ['http://172.16.0.1', true],
    ['http://172.31.255.255', true],
    ['http://172.15.0.1', false],
    ['http://172.32.0.1', false],
    ['http://192.168.4.73:8080', true],
    ['http://192.169.0.1', false],
    ['http://100.64.0.1', true],
    ['http://100.127.255.1', true],
    ['http://100.128.0.1', false],
    ['http://[fd12:3456::1]:8080', true],
    ['http://[fc00::1]', true],
    ['http://[2001:db8::1]', false],
    ['http://neuralnexus:8080', true],
    ['http://box.local:8080', true],
    ['http://box.lan', true],
    ['http://box.home.arpa', true],
    ['http://box.internal', true],
    ['https://box.tailnet-123.ts.net', true],
    ['http://.local', false],
    ['https://api.example.com', false],
    ['https://ts.net.example.com', false],
    ['http://127.0.0.1:8080', false],
    ['http://localhost:8080', false],
    ['http://8.8.8.8', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isPrivateNetworkUrl(url)).toBe(expected);
  });
});

describe('normaliseEndpointUrl', () => {
  it('keeps http(s), drops a trailing slash and /v1, refuses credentials in the URL', () => {
    expect(normaliseEndpointUrl(' http://127.0.0.1:8080/v1/ ')).toBe('http://127.0.0.1:8080');
    expect(normaliseEndpointUrl('https://host.example/api')).toBe('https://host.example/api');
    expect(normaliseEndpointUrl('ftp://host')).toBeUndefined();
    expect(normaliseEndpointUrl('http://user:secret@127.0.0.1:8080')).toBeUndefined();
  });
});

describe('parseLocalEndpoints', () => {
  it('keeps well-formed entries and drops the rest, one at a time', () => {
    const list = parseLocalEndpoints([
      { id: 'box', name: 'Box', url: 'http://127.0.0.1:8080/v1', maxConcurrency: 2, models: { m: { contextWindow: 8192, toolCalling: 'basic', junk: 1 } } },
      { id: 'box', url: 'http://127.0.0.1:9' }, // duplicate id
      { id: 'Bad Id', url: 'http://127.0.0.1:9' },
      { id: 'nourl' },
      { id: 'lan', url: 'http://192.168.1.2:1234', enabled: true, hasKey: true, runtime: 'vllm', device: 'Test box' },
      'nonsense',
    ]);
    expect(list).toEqual([
      { id: 'box', name: 'Box', url: 'http://127.0.0.1:8080', maxConcurrency: 2, models: { m: { contextWindow: 8192, toolCalling: 'basic' } } },
      { id: 'lan', name: 'lan', url: 'http://192.168.1.2:1234', enabled: true, hasKey: true, runtime: 'vllm', device: 'Test box' },
    ]);
    expect(parseLocalEndpoints('nope')).toEqual([]);
  });

  it('keeps location: local only on a private host', () => {
    const list = parseLocalEndpoints([
      { id: 'nexus', url: 'http://192.168.4.73:8080', location: 'local' },
      { id: 'tail', url: 'https://nexus.tailnet-1.ts.net', location: 'local' },
      { id: 'cloud', url: 'https://api.example.com', location: 'local' },
      { id: 'here', url: 'http://127.0.0.1:8080', location: 'local' },
      { id: 'odd', url: 'http://10.0.0.2:1', location: 'hosted' },
    ]);
    expect(list.map((e) => [e.id, e.location])).toEqual([
      ['nexus', 'local'],
      ['tail', 'local'],
      ['cloud', undefined],
      ['here', undefined],
      ['odd', undefined],
    ]);
  });
});

describe('addEndpoint and changes', () => {
  it('adds with an id from the name, refuses duplicates and bad URLs', () => {
    const a = addEndpoint([], { url: 'http://127.0.0.1:11434', name: 'Ollama here' });
    expect(a.ok && a.endpoint).toEqual({ id: 'ollama-here', name: 'Ollama here', url: 'http://127.0.0.1:11434' });
    const list = a.ok ? a.list : [];
    expect(addEndpoint(list, { url: 'http://127.0.0.1:11434/' })).toMatchObject({ ok: false });
    expect(addEndpoint(list, { url: 'nope' })).toMatchObject({ ok: false });
    const b = addEndpoint(list, { url: 'http://127.0.0.1:1', name: 'Ollama here' });
    expect(b.ok && b.endpoint.id).toBe('ollama-here-2');
    // A non-loopback endpoint is stored without `enabled`: off by default.
    const c = addEndpoint([], { url: 'http://192.168.1.2:1234' });
    expect(c.ok && c.endpoint).toEqual({ id: '192-168-1-2-1234', name: '192.168.1.2:1234', url: 'http://192.168.1.2:1234' });
    expect(c.ok && endpointEnabled(c.endpoint)).toBe(false);
    expect(newEndpointId('', [])).toBe('endpoint');
  });

  it('accepts only the change shapes a window sends', () => {
    expect(localEndpointChange({ op: 'add', url: 'http://127.0.0.1:1' })).toEqual({ op: 'add', url: 'http://127.0.0.1:1' });
    expect(localEndpointChange({ op: 'enable', id: 'box', enabled: true })).toEqual({ op: 'enable', id: 'box', enabled: true });
    expect(localEndpointChange({ op: 'qualify', id: 'box', model: 'm' })).toEqual({ op: 'qualify', id: 'box', model: 'm' });
    expect(localEndpointChange({ op: 'setLocal', id: 'box', local: true })).toEqual({ op: 'setLocal', id: 'box', local: true });
    expect(localEndpointChange({ op: 'setLocal', id: 'box', local: 'yes' })).toBeUndefined();
    expect(localEndpointChange({ op: 'enable', id: 'box' })).toBeUndefined();
    expect(localEndpointChange({ op: 'remove', id: '../etc' })).toBeUndefined();
    expect(localEndpointChange({ op: 'run', id: 'box' })).toBeUndefined();
    expect(localEndpointChange({ op: 'cancelQualifyTasks', id: 'box', model: 'm', harness: 'codex' })).toEqual({ op: 'cancelQualifyTasks', id: 'box', model: 'm' });
    expect(localEndpointChange({ op: 'cancelQualifyTasks', id: 'box' })).toBeUndefined();
  });

  it('endpointIdOf reads local:<id> sources only', () => {
    expect(endpointIdOf('local:box')).toBe('box');
    expect(endpointIdOf('openai')).toBeUndefined();
  });
});
