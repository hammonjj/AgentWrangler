import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { DiscordGateway, type GatewayDispatch } from '../src/remote/discord/gateway';
import { DiscordRest } from '../src/remote/discord/rest';
import { DiscordTransport } from '../src/remote/discord/transport';
import { encodeCustomId } from '../src/remote/discord/ids';
import type { RemoteInvocation } from '../src/remote/transport';
import type { RemoteAsk } from '../src/shared/remote';

const INTERACTION = 'AbCd1234_-efGhIjKlMn';
const CHANNEL = '111111111111111111';
const GUILD = '222222222222222222';

function ask(): RemoteAsk {
  return {
    askKey: 'claude:sess-a#100-1',
    sessionKey: 'claude:sess-a',
    requestId: '100-1',
    kind: 'permission',
    title: 'agent-a needs permission for Bash',
    toolName: 'Bash',
    subject: { summary: 'Publish', body: 'git push', isCommand: true },
    context: { agent: 'agent-a' },
    choices: [
      { action: 'allow', label: 'Allow once', tone: 'primary' },
      { action: 'deny', label: 'Deny', tone: 'danger' },
    ],
  };
}

/** A gateway stand-in we can push dispatches through. */
class FakeGateway {
  connected = false;
  fatalError: string | undefined;
  private dispatch = new Emitter<GatewayDispatch>();
  private state = new Emitter<void>();
  onDispatch = (l: (d: GatewayDispatch) => void) => this.dispatch.event(l);
  onDidChangeState = (l: () => void) => this.state.event(l);
  async connect(): Promise<void> {
    this.connected = true;
    this.state.fire();
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.state.fire();
  }
  dispose(): void {
    this.dispatch.dispose();
    this.state.dispose();
  }
  press(customId: string, extra: Record<string, unknown> = {}): void {
    this.dispatch.fire({
      t: 'INTERACTION_CREATE',
      d: {
        id: 'INT1',
        token: 'interaction-token',
        application_id: 'APP1',
        type: 3,
        data: { custom_id: customId, component_type: 2 },
        guild_id: GUILD,
        channel_id: CHANNEL,
        member: { user: { id: 'U-allowed', username: 'jhammond', global_name: 'James' } },
        message: { id: 'M1' },
        ...extra,
      },
    });
  }
  emit(d: GatewayDispatch): void {
    this.dispatch.fire(d);
  }
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function build() {
  const sent: Sent[] = [];
  const rest = {
    request: async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      if (method === 'POST' && path.endsWith('/messages')) return { id: 'M-new' };
      return {};
    },
  } as unknown as DiscordRest;
  const gateway = new FakeGateway();
  const transport = new DiscordTransport({
    config: () => ({ guildId: GUILD, channelId: CHANNEL }),
    rest,
    gateway: gateway as unknown as DiscordGateway,
    log: () => undefined,
  });
  return { transport, gateway, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DiscordTransport', () => {
  it('publishes to the configured channel and returns the message ref', async () => {
    const { transport, sent } = build();
    const ref = await transport.publish(INTERACTION, ask());
    expect(ref).toEqual({ channelId: CHANNEL, messageId: 'M-new' });
    expect(sent[0]).toMatchObject({ method: 'POST', path: `/channels/${CHANNEL}/messages` });
    transport.dispose();
  });

  it('edits through the channel endpoint, not the interaction token', async () => {
    // A prompt can outlive the interaction token's 15 minutes; the bot token
    // has no such limit, so every edit must go this way.
    const { transport, sent } = build();
    await transport.close({ channelId: CHANNEL, messageId: 'M1' }, ask(), {
      outcome: 'allowed',
      atMs: Date.now(),
    });
    expect(sent[0].method).toBe('PATCH');
    expect(sent[0].path).toBe(`/channels/${CHANNEL}/messages/M1`);
    expect((sent[0].body as { components: unknown[] }).components).toEqual([]);
    transport.dispose();
  });

  describe('a button press', () => {
    it('acknowledges before anything else, inside the three-second budget', async () => {
      // Discord invalidates the interaction after 3s, and deciding a permission
      // takes a file write and a store round trip. Acknowledge first.
      const { transport, gateway, sent } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));

      gateway.press(encodeCustomId(INTERACTION, 'allow'));
      await tick();

      expect(sent[0]).toMatchObject({
        method: 'POST',
        path: '/interactions/INT1/interaction-token/callback',
        body: { type: 6 },
      });
      expect(seen).toHaveLength(1);
      transport.dispose();
    });

    it('translates it into a transport-agnostic invocation', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.press(encodeCustomId(INTERACTION, 'deny'));
      await tick();

      expect(seen[0]).toEqual({
        interactionId: INTERACTION,
        choiceId: 'deny',
        actor: { id: 'U-allowed', displayName: 'James' },
        scope: { guildId: GUILD, channelId: CHANNEL },
      });
      transport.dispose();
    });

    it('reads the actor from member.user in a guild', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.press(encodeCustomId(INTERACTION, 'allow'));
      await tick();
      expect(seen[0].actor.id).toBe('U-allowed');
      transport.dispose();
    });

    it('falls back to user when there is no member, as in a DM', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.press(encodeCustomId(INTERACTION, 'allow'), {
        member: undefined,
        user: { id: 'U-dm', username: 'dmuser' },
      });
      await tick();
      expect(seen[0].actor).toEqual({ id: 'U-dm', displayName: 'dmuser' });
      transport.dispose();
    });

    it('ignores a component that is not ours', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.press('someotherbot:thing:go');
      await tick();
      expect(seen).toHaveLength(0);
      transport.dispose();
    });

    it('ignores an interaction that is not a button', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.press(encodeCustomId(INTERACTION, 'allow'), { type: 2 }); // a slash command
      await tick();
      expect(seen).toHaveLength(0);
      transport.dispose();
    });

    it('ignores dispatches other than INTERACTION_CREATE', async () => {
      const { transport, gateway } = build();
      const seen: RemoteInvocation[] = [];
      transport.onDidInvoke((i) => seen.push(i));
      gateway.emit({ t: 'MESSAGE_CREATE', d: { id: 'x' } });
      await tick();
      expect(seen).toHaveLength(0);
      transport.dispose();
    });
  });

  describe('replying privately', () => {
    it('uses a followup webhook, flagged ephemeral', async () => {
      // The press was already acknowledged with a type-6 callback, so an
      // initial response is no longer available.
      const { transport, gateway, sent } = build();
      gateway.press(encodeCustomId(INTERACTION, 'allow'));
      await tick();
      sent.length = 0;

      await transport.reply(
        { interactionId: INTERACTION, choiceId: 'allow', actor: { id: 'U', displayName: 'U' }, scope: {} },
        'You are not authorised.',
      );
      expect(sent[0]).toMatchObject({
        method: 'POST',
        path: '/webhooks/APP1/interaction-token',
        body: { content: 'You are not authorised.', flags: 64 },
      });
      transport.dispose();
    });

    it('says nothing when there is no interaction token, rather than throwing', async () => {
      // After a restart the token is gone; the message itself still tells the
      // story, so silence is the right failure.
      const { transport, sent } = build();
      await expect(
        transport.reply(
          { interactionId: 'unknown-one', choiceId: 'allow', actor: { id: 'U', displayName: 'U' }, scope: {} },
          'hello',
        ),
      ).resolves.toBeUndefined();
      expect(sent).toHaveLength(0);
      transport.dispose();
    });
  });

  it('reports the gateway connection state', async () => {
    const { transport } = build();
    const changes: boolean[] = [];
    transport.onDidChangeConnection(() => changes.push(transport.connected));
    expect(transport.connected).toBe(false);
    await transport.connect();
    expect(transport.connected).toBe(true);
    await transport.disconnect();
    expect(changes).toEqual([true, false]);
    transport.dispose();
  });
});
