/**
 * `RemoteTransport` over Discord.
 *
 * The boundary: above this file nothing knows what an embed, a gateway op or a
 * snowflake is; below it nothing knows what a hook, a marker or a permission
 * is. This class speaks both and translates, and holds the one piece of
 * genuinely Discord-shaped state — the short-lived interaction tokens needed to
 * reply privately to whoever pressed.
 */
import { Emitter, type Disposable } from '../../core/events';
import type { RemoteAsk, RemoteNotice } from '../../shared/remote';
import type {
  RemoteClose,
  RemoteInvocation,
  RemoteMessageRef,
  RemoteTransport,
} from '../transport';
import { askPayload, closedPayload, noticePayload } from './format';
import { DiscordGateway, type GatewayDeps } from './gateway';
import { decodeCustomId } from './ids';
import { DiscordHttpError, DiscordRest, PRIORITY, type DiscordRestDeps } from './rest';

export interface DiscordConfig {
  guildId: string;
  channelId: string;
}

export interface DiscordTransportDeps {
  config: () => DiscordConfig;
  rest?: DiscordRest;
  gateway?: DiscordGateway;
  restDeps?: DiscordRestDeps;
  gatewayDeps?: Omit<GatewayDeps, 'gatewayUrl'> & { gatewayUrl?: GatewayDeps['gatewayUrl'] };
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * How long an interaction token is worth keeping. Discord's is valid for 15
 * minutes; we only ever use it within a second or two of the press, so this is
 * housekeeping rather than a deadline.
 */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Interaction callback types. 6 acknowledges without changing the message yet. */
const DEFERRED_UPDATE_MESSAGE = 6;
/** Only the presser sees it. */
const EPHEMERAL = 64;

interface PendingInteraction {
  token: string;
  applicationId: string;
  receivedAtMs: number;
}

export class DiscordTransport implements RemoteTransport {
  readonly id = 'discord';

  private invokeEmitter = new Emitter<RemoteInvocation>();
  private connectionEmitter = new Emitter<void>();
  private subs: Disposable[] = [];
  /** interactionId -> what is needed to answer the presser privately. */
  private pending = new Map<string, PendingInteraction>();

  private rest: DiscordRest;
  private gateway: DiscordGateway;
  private log: (message: string) => void;
  private now: () => number;

  constructor(private deps: DiscordTransportDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => Date.now());
    this.rest = deps.rest ?? new DiscordRest(deps.restDeps!);
    this.gateway =
      deps.gateway ??
      new DiscordGateway({
        ...(deps.gatewayDeps as GatewayDeps),
        gatewayUrl:
          deps.gatewayDeps?.gatewayUrl ??
          (async () => {
            const res = await this.rest.request<{ url: string }>('GET', '/gateway/bot');
            return res.url;
          }),
      });

    this.subs.push(
      this.gateway.onDispatch((d) => void this.onDispatch(d.t, d.d)),
      this.gateway.onDidChangeState(() => this.connectionEmitter.fire()),
    );
  }

  readonly onDidInvoke = (l: (i: RemoteInvocation) => void): Disposable => this.invokeEmitter.event(l);
  readonly onDidChangeConnection = (l: () => void): Disposable => this.connectionEmitter.event(l);

  get connected(): boolean {
    return this.gateway.connected;
  }

  /** Set when connecting failed in a way retrying cannot fix — a bad token. */
  get fatalError(): string | undefined {
    return this.gateway.fatalError;
  }

  async connect(): Promise<void> {
    await this.gateway.connect();
  }

  async disconnect(): Promise<void> {
    await this.gateway.disconnect();
    this.pending.clear();
  }

  wake(): void {
    this.gateway.wake();
  }

  async publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef> {
    const { channelId } = this.deps.config();
    const message = await this.rest.request<{ id: string }>(
      'POST',
      `/channels/${channelId}/messages`,
      askPayload(interactionId, ask),
      { priority: PRIORITY.publish },
    );
    return { channelId, messageId: message.id };
  }

  /**
   * A one-way announcement. Lowest priority of anything that posts: a card with
   * a live button always matters more than news about something already done.
   */
  async notify(notice: RemoteNotice): Promise<void> {
    const { channelId } = this.deps.config();
    await this.rest.request('POST', `/channels/${channelId}/messages`, noticePayload(notice), {
      priority: PRIORITY.reply,
    });
  }

  async update(ref: RemoteMessageRef, interactionId: string, ask: RemoteAsk): Promise<void> {
    await this.edit(ref, askPayload(interactionId, ask), PRIORITY.update);
  }

  async close(ref: RemoteMessageRef, ask: RemoteAsk, outcome: RemoteClose): Promise<void> {
    // Highest priority: a button that can still be pressed but should not be is
    // the worst state this feature has, so removing it outranks posting a new
    // card for something else.
    await this.edit(ref, closedPayload(ask, outcome), PRIORITY.close);
  }

  /**
   * A private word with whoever pressed.
   *
   * A followup rather than an initial response, because the press was already
   * acknowledged with a type-6 callback the moment it arrived — that had to
   * happen inside three seconds, long before Agent Wrangler had decided
   * anything. Without the interaction token (a restart, or a very old press)
   * there is nowhere to send it, and saying nothing is the right failure: the
   * message itself still tells the story.
   */
  async reply(invocation: RemoteInvocation, text: string): Promise<void> {
    const pending = this.pending.get(invocation.interactionId);
    if (!pending) {
      this.log(`no interaction token for ${invocation.interactionId}; cannot reply privately`);
      return;
    }
    try {
      await this.rest.request(
        'POST',
        `/webhooks/${pending.applicationId}/${pending.token}`,
        { content: text, flags: EPHEMERAL },
        { priority: PRIORITY.reply },
      );
    } catch (err) {
      this.log(`ephemeral reply failed: ${String(err)}`);
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.gateway.dispose();
    this.invokeEmitter.dispose();
    this.connectionEmitter.dispose();
    this.pending.clear();
  }

  // ---- internals ----

  private async edit(ref: RemoteMessageRef, payload: unknown, priority: number): Promise<void> {
    try {
      await this.rest.request('PATCH', `/channels/${ref.channelId}/messages/${ref.messageId}`, payload, { priority });
    } catch (err) {
      // Someone deleted the message. There is nothing to edit and never will
      // be, so let the caller drop its record rather than retry forever.
      if (err instanceof DiscordHttpError && err.isUnknownMessage) {
        this.log(`message ${ref.messageId} is gone; nothing to edit`);
        return;
      }
      throw err;
    }
  }

  /**
   * A button press.
   *
   * Order matters and is not negotiable: acknowledge first, decide later.
   * Discord invalidates the interaction three seconds after it is delivered,
   * and answering a permission involves a file write and a store round trip, so
   * doing that first would routinely blow the budget and show the user
   * "interaction failed" even when the decision landed.
   */
  private async onDispatch(type: string, data: Record<string, unknown>): Promise<void> {
    if (type !== 'INTERACTION_CREATE') return;

    // 3 = MESSAGE_COMPONENT, 2 = button. Anything else is not ours.
    const interactionData = data.data as { custom_id?: unknown; component_type?: number } | undefined;
    if (data.type !== 3 || interactionData?.component_type !== 2) return;

    const parsed = decodeCustomId(interactionData?.custom_id);
    if (!parsed) return; // another application's component, or an older build

    const id = String(data.id ?? '');
    const token = String(data.token ?? '');
    const applicationId = String(data.application_id ?? '');
    if (id && token) {
      await this.acknowledge(id, token);
      this.pending.set(parsed.interactionId, { token, applicationId, receivedAtMs: this.now() });
      this.prunePending();
    }

    // In a guild the presser is `member.user`; in a DM there is no member and
    // it is `user`. Verified against a real press — see the plan's §0.1.
    const member = data.member as { user?: { id?: string; username?: string; global_name?: string } } | undefined;
    const bare = data.user as { id?: string; username?: string; global_name?: string } | undefined;
    const user = member?.user ?? bare;
    if (!user?.id) return;

    this.invokeEmitter.fire({
      interactionId: parsed.interactionId,
      choiceId: parsed.choiceId,
      actor: { id: user.id, displayName: user.global_name ?? user.username ?? user.id },
      scope: {
        guildId: typeof data.guild_id === 'string' ? data.guild_id : undefined,
        channelId: typeof data.channel_id === 'string' ? data.channel_id : undefined,
      },
    });
  }

  /** Type 6: "got it", with no visible change and no loading state on the button. */
  private async acknowledge(interactionId: string, token: string): Promise<void> {
    try {
      await this.rest.request(
        'POST',
        `/interactions/${interactionId}/${token}/callback`,
        { type: DEFERRED_UPDATE_MESSAGE },
        { priority: PRIORITY.close }, // beats everything: three seconds is not much
      );
    } catch (err) {
      // The press is still worth acting on even if the acknowledgement failed;
      // the user sees "interaction failed" but the decision lands, and the
      // message edit that follows is what actually reports the outcome.
      this.log(`interaction ack failed: ${String(err)}`);
    }
  }

  private prunePending(): void {
    const cutoff = this.now() - TOKEN_TTL_MS;
    for (const [key, value] of this.pending) {
      if (value.receivedAtMs < cutoff) this.pending.delete(key);
    }
  }
}
