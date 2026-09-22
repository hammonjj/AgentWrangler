import { describe, expect, it } from 'vitest';
import { bucketOf, DiscordHttpError, DiscordRest, PRIORITY, scrub } from '../src/remote/discord/rest';

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string;
}

/** A `fetch` that replies from a script and records what it was asked. */
function fakeFetch(replies: (() => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: String((init.headers as Record<string, string>).Authorization),
    });
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return reply();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown = { id: 'M1' }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });
const status = (code: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers });

function build(replies: (() => Response)[]) {
  const { impl, calls } = fakeFetch(replies);
  const slept: number[] = [];
  const rest = new DiscordRest({
    token: () => 'SECRET-TOKEN',
    fetchImpl: impl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 1_000_000,
    log: () => undefined,
  });
  return { rest, calls, slept };
}

describe('DiscordRest', () => {
  it('sends the bot token and parses the reply', async () => {
    const { rest, calls } = build([() => ok({ id: 'M42' })]);
    const res = await rest.request<{ id: string }>('POST', '/channels/C1/messages', { content: 'x' });
    expect(res.id).toBe('M42');
    expect(calls[0].authorization).toBe('Bot SECRET-TOKEN');
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/C1/messages');
    expect(calls[0].body).toEqual({ content: 'x' });
  });

  it('reads the token freshly each time, so a reconnect picks up a new one', async () => {
    let token = 'first';
    const { impl, calls } = fakeFetch([() => ok()]);
    const rest = new DiscordRest({ token: () => token, fetchImpl: impl, sleep: async () => undefined });
    await rest.request('GET', '/users/@me');
    token = 'second';
    await rest.request('GET', '/users/@me');
    expect(calls.map((c) => c.authorization)).toEqual(['Bot first', 'Bot second']);
  });

  describe('rate limits', () => {
    it('waits the time a 429 asks for, then retries', async () => {
      const { rest, slept, calls } = build([
        () => status(429, { retry_after: 1.5 }, { 'retry-after': '1.5' }),
        () => ok(),
      ]);
      await rest.request('POST', '/channels/C1/messages', {});
      expect(slept[0]).toBeGreaterThanOrEqual(1500);
      expect(calls).toHaveLength(2);
    });

    it('falls back to the body when there is no retry-after header', async () => {
      const { rest, slept } = build([() => status(429, { retry_after: 2 }), () => ok()]);
      await rest.request('POST', '/channels/C1/messages', {});
      expect(slept[0]).toBeGreaterThanOrEqual(2000);
    });

    it('gives up rather than retrying a 429 forever', async () => {
      const { rest, calls } = build([() => status(429, { retry_after: 0 }, { 'retry-after': '0' })]);
      await expect(rest.request('POST', '/channels/C1/messages', {})).rejects.toThrow(/rate limited/);
      expect(calls.length).toBeLessThanOrEqual(4);
    });

    it('waits out a bucket it has exhausted before the next call', async () => {
      const { rest, slept } = build([
        () => ok({ id: 'M1' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' }),
        () => ok(),
      ]);
      await rest.request('POST', '/channels/C1/messages', {});
      await rest.request('POST', '/channels/C1/messages', {});
      expect(slept).toContain(3000);
    });

    it('retries a 5xx', async () => {
      const { rest, calls } = build([() => status(500), () => ok()]);
      await rest.request('GET', '/users/@me');
      expect(calls).toHaveLength(2);
    });
  });

  describe('errors', () => {
    it('surfaces a 403 as forbidden, which is configuration not weather', async () => {
      const { rest } = build([() => status(403, { message: 'Missing Access', code: 50001 })]);
      await rest.request('GET', '/channels/C1').then(
        () => expect.unreachable('should have thrown'),
        (err: DiscordHttpError) => {
          expect(err.isForbidden).toBe(true);
          expect(err.message).toContain('Missing Access');
        },
      );
    });

    it('recognises a deleted message, which must not be retried', async () => {
      const { rest } = build([() => status(404, { message: 'Unknown Message', code: 10008 })]);
      await rest.request('PATCH', '/channels/C1/messages/M1', {}).then(
        () => expect.unreachable('should have thrown'),
        (err: DiscordHttpError) => expect(err.isUnknownMessage).toBe(true),
      );
    });

    it('never puts the token in a thrown error', async () => {
      const { rest } = build([() => status(401, { message: 'Unauthorized: Bot SECRET-TOKEN' })]);
      await rest.request('GET', '/users/@me').then(
        () => expect.unreachable('should have thrown'),
        (err: Error) => {
          expect(err.message).not.toContain('SECRET-TOKEN');
          expect(err.message).toContain('‹redacted›');
        },
      );
    });
  });

  describe('ordering', () => {
    it('runs an edit before publishes already queued behind it', async () => {
      // A button that can still be pressed but should not be is the worst state
      // this feature has, so removing it outranks posting the next card.
      const { rest, calls } = build([() => ok()]);
      const done: string[] = [];
      const p1 = rest.request('POST', '/channels/C1/messages', { n: 1 }, { priority: PRIORITY.publish }).then(() => done.push('publish-1'));
      const p2 = rest.request('POST', '/channels/C1/messages', { n: 2 }, { priority: PRIORITY.publish }).then(() => done.push('publish-2'));
      const p3 = rest.request('PATCH', '/channels/C1/messages/M1', { n: 3 }, { priority: PRIORITY.close }).then(() => done.push('close'));
      await Promise.all([p1, p2, p3]);

      // The first was already in flight; the close jumps the rest of the queue.
      expect(done[0]).toBe('publish-1');
      expect(done[1]).toBe('close');
      expect(calls.map((c) => c.body)).toEqual([{ n: 1 }, { n: 3 }, { n: 2 }]);
    });

    it('serialises requests rather than firing them at once', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const impl = (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return ok();
      }) as unknown as typeof fetch;
      const rest = new DiscordRest({ token: () => 't', fetchImpl: impl, sleep: async () => undefined });
      await Promise.all([
        rest.request('GET', '/a'),
        rest.request('GET', '/b'),
        rest.request('GET', '/c'),
      ]);
      expect(maxInFlight).toBe(1);
    });
  });
});

describe('bucketOf', () => {
  it('keeps the major parameter so one channel does not throttle another', () => {
    expect(bucketOf('/channels/123456789012345678/messages')).toContain('123456789012345678');
  });

  it('collapses the message id, which does not have its own limit', () => {
    expect(bucketOf('/channels/123456789012345678/messages/987654321098765432')).toBe(
      '/channels/123456789012345678/messages/:id',
    );
  });

  it('collapses an interaction token', () => {
    expect(bucketOf(`/webhooks/123456789012345678/${'t'.repeat(60)}`)).toBe('/webhooks/123456789012345678/:token');
  });
});

describe('scrub', () => {
  it('removes a bot authorization header', () => {
    expect(scrub('Authorization: Bot abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('removes a token-shaped run', () => {
    const token = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(38)}`;
    expect(scrub(`failed with ${token}`)).toBe('failed with ‹redacted›');
  });

  it('leaves ordinary text alone', () => {
    expect(scrub('discord POST /channels/1/messages: 403 Missing Access')).toBe(
      'discord POST /channels/1/messages: 403 Missing Access',
    );
  });
});
