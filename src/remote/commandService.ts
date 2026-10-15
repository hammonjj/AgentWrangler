/**
 * Runs remote commands (#59) from whichever transport has them, through the same checks a
 * button press passes (`service.ts`): scope, the authorised-user allowlist, `authorize()`, and a
 * line in the audit log either way. Separate from `RemoteControlService`, which may answer
 * prompts and nothing else; this owns the command registry and nothing else.
 *
 * Commands work while notifications are off: that is the point of `/enable-notifications`.
 */
import { authorize as defaultAuthorize, ownerContext, type Authorizer } from '../core/access';
import type { Disposable } from '../core/events';
import { runInRequest } from '../core/requestScope';
import type { AuditLog } from './audit';
import type { CommandRegistry } from './commands';
import type { RemoteConfig } from './service';
import type { RemoteCommandInvocation, RemoteTransport } from './transport';

const DISCORD_CONTEXT = ownerContext('discord');

export class RemoteCommandService implements Disposable {
  private subs: Disposable[] = [];

  constructor(
    private readonly registry: CommandRegistry,
    private readonly config: () => RemoteConfig,
    private readonly audit: AuditLog,
    private readonly log: (message: string) => void = () => undefined,
    private readonly authorize: Authorizer = defaultAuthorize,
  ) {}

  setTransport(transport: RemoteTransport | undefined): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    if (!transport?.onDidCommand || !transport.setCommands) return;
    transport.setCommands(this.registry.list().map((c) => ({ name: c.name, description: c.description })));
    this.subs.push(transport.onDidCommand((inv) => void this.run(transport, inv).catch((e) => this.log(`remote: command failed: ${String(e)}`))));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  /** Exposed for tests: one invocation, start to reply. */
  async run(transport: RemoteTransport, inv: RemoteCommandInvocation): Promise<void> {
    const cfg = this.config();
    const reply = (text: string) => transport.replyToCommand?.(inv, text) ?? Promise.resolve();
    const base = { interactionId: inv.invocationId, actorId: inv.actor.id, actorName: inv.actor.displayName, via: 'discord' as const, detail: inv.name.slice(0, 40) };

    if ((inv.scope.guildId !== undefined && inv.scope.guildId !== cfg.guildId) || (inv.scope.channelId !== undefined && inv.scope.channelId !== cfg.channelId)) {
      this.audit.write({ event: 'refused-out-of-scope', ...base });
      await reply('Agent Wrangler only answers commands in its own channel.');
      return;
    }
    if (!cfg.authorizedUserIds.includes(inv.actor.id)) {
      this.audit.write({ event: 'refused-unauthorised', ...base });
      this.log(`remote: unauthorised command by ${inv.actor.id}`);
      await reply('You are not authorised to use Agent Wrangler’s commands.');
      return;
    }
    const command = this.registry.get(inv.name);
    if (!command) {
      this.audit.write({ event: 'refused-unknown', ...base });
      await reply('Agent Wrangler does not know that command. Try /help.');
      return;
    }
    const action = command.mutates ? ('settings.write' as const) : ('view.read' as const);
    const resource = { kind: 'setting' as const, id: `command.${command.name}` };
    const who = { ...base, principal: DISCORD_CONTEXT.principal.id, action, resource };
    if (this.authorize(DISCORD_CONTEXT, action, resource) !== 'allow') {
      this.audit.write({ event: 'refused-unauthorised', ...who });
      await reply('You are not authorised to use Agent Wrangler’s commands.');
      return;
    }
    this.audit.write({ event: 'command', ...who });
    let text: string;
    try {
      text = await runInRequest(DISCORD_CONTEXT, () => command.run());
    } catch (e) {
      text = `That did not work: ${e instanceof Error ? e.message : String(e)}`;
    }
    await reply(text);
  }
}
