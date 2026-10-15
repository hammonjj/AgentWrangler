/** Discord's half of remote commands (#59): registration on connect, and slash interactions. */
import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import type { DiscordGateway, GatewayDispatch } from '../src/remote/discord/gateway';
import { DiscordHttpError, type DiscordRest } from '../src/remote/discord/rest';
import { DiscordTransport } from '../src/remote/discord/transport';
import type { RemoteCommandInvocation } from '../src/remote/transport';

const GUILD = '222222222222222222';
const CHANNEL = '111111111111111111';

class FakeGateway {
  connected = false;
  applicationId: string | undefined = 'APP1';
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
  dispose(): void {}
  emit(d: GatewayDispatch): void {
    this.dispatch.fire(d);
  }
}

function build(fail?: DiscordHttpError) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const rest = {
    request: async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      if (fail && method === 'PUT') throw fail;
      return {};
    },
  } as unknown as DiscordRest;
  const gateway = new FakeGateway();
  const transport = new DiscordTransport({ config: () => ({ guildId: GUILD, channelId: CHANNEL }), rest, gateway: gateway as unknown as DiscordGateway, log: () => undefined });
  return { transport, gateway, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Discord slash commands (#59)', () => {
  it('registers the commands for the guild on connect, as one bulk overwrite', async () => {
    const { transport, gateway, sent } = build();
    transport.setCommands([{ name: 'usage', description: 'Plan usage.' }]);
    expect(sent).toEqual([]); // not connected yet
    await gateway.connect();
    await tick();
    expect(sent).toEqual([{ method: 'PUT', path: `/applications/APP1/guilds/${GUILD}/commands`, body: [{ name: 'usage', description: 'Plan usage.', type: 1 }] }]);
    expect(transport.commandProblem).toBeUndefined();
    transport.dispose();
  });

  it('says plainly when the bot lacks the commands scope', async () => {
    const { transport, gateway } = build(new DiscordHttpError(403, 50001, 'Missing Access'));
    transport.setCommands([{ name: 'usage', description: 'x' }]);
    await gateway.connect();
    await tick();
    expect(transport.commandProblem).toMatch(/applications\.commands/);
    transport.dispose();
  });

  it('defers a slash command privately, reports it, and answers by editing the response', async () => {
    const { transport, gateway, sent } = build();
    const got: RemoteCommandInvocation[] = [];
    transport.onDidCommand((i) => got.push(i));
    gateway.emit({
      t: 'INTERACTION_CREATE',
      d: {
        id: 'INT9',
        token: 'tok',
        application_id: 'APP1',
        type: 2,
        data: { name: 'status' },
        guild_id: GUILD,
        channel_id: CHANNEL,
        member: { user: { id: 'U1', username: 'owner' } },
      },
    });
    await tick();
    expect(sent[0]).toEqual({ method: 'POST', path: '/interactions/INT9/tok/callback', body: { type: 5, data: { flags: 64 } } });
    expect(got).toEqual([{ invocationId: 'INT9', name: 'status', actor: { id: 'U1', displayName: 'owner' }, scope: { guildId: GUILD, channelId: CHANNEL } }]);
    await transport.replyToCommand(got[0], 'Notifications: on.');
    expect(sent[1]).toEqual({ method: 'PATCH', path: '/webhooks/APP1/tok/messages/@original', body: { content: 'Notifications: on.' } });
    transport.dispose();
  });
});
