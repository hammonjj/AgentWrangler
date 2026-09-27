/**
 * A fake OpenAI-compatible server on loopback, for #51's integration tests:
 * a real HTTP listener, so the probe, the health checks and the completion
 * client go through real `fetch`, real SSE and real socket failures.
 *
 * It plays one runtime's routes (`llama.cpp`-shaped by default: `/health`,
 * `/props`, `/v1/models`) and scripts `chat/completions` replies. `stall`
 * sends one chunk and then nothing, so a test can pull the server out from
 * under a call part-way (`kill`). Synthetic content only.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ChatReply {
  /** Text content, streamed in a few chunks. */
  content?: string;
  /** A tool call instead of content. */
  toolCall?: { name: string; arguments: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** llama.cpp's `timings`. */
  timings?: { predicted_per_second: number };
  /** Send the first chunk, then hang until the server is killed. */
  stall?: boolean;
  /** Answer with this HTTP status and no stream. */
  status?: number;
}

export interface FakeServerOptions {
  models?: string[];
  /** `/props` → `total_slots` and `n_ctx`. Omit for a server with no `/props`. */
  props?: { totalSlots?: number; nCtx?: number };
  /** Serve `/v1/responses` (answers 400 to an empty body) or 404. */
  responses?: boolean;
  messages?: boolean;
  /** Require `Authorization: Bearer <key>` on every route. */
  key?: string;
  /** How `chat/completions` answers, in order; the last repeats. Or a function of the request body. */
  replies?: ChatReply[] | ((body: Record<string, any>) => ChatReply);
}

export interface FakeServer {
  url: string;
  /** Every request, method and path, in order. */
  requests: { method: string; path: string; auth?: string; body?: Record<string, any> }[];
  /** Destroy every open socket now (a server that died), and stop answering. */
  kill(): void;
  /** Answer again after `kill`. */
  revive(): void;
  close(): Promise<void>;
  /** Replace the scripted replies. */
  setReplies(replies: FakeServerOptions['replies']): void;
}

function sse(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const models = opts.models ?? ['test-model'];
  let replies = opts.replies ?? [{ content: '{}' }];
  let n = 0;
  let dead = false;
  const sockets = new Set<import('node:net').Socket>();
  const requests: FakeServer['requests'] = [];

  const nextReply = (body: Record<string, any>): ChatReply => {
    if (typeof replies === 'function') return replies(body);
    const r = replies[Math.min(n, replies.length - 1)];
    n++;
    return r;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      let body: Record<string, any> | undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method ?? 'GET', path, auth: req.headers.authorization, ...(body ? { body } : {}) });
      if (dead) {
        req.socket.destroy();
        return;
      }
      if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' });
      if (req.method === 'GET' && path === '/props' && opts.props) {
        return json(200, { total_slots: opts.props.totalSlots ?? 1, default_generation_settings: { n_ctx: opts.props.nCtx ?? 8192 } });
      }
      if (req.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'local' })) });
      if (req.method === 'POST' && path === '/v1/responses') return opts.responses ? json(400, { error: 'missing model' }) : json(404, { error: 'not found' });
      if (req.method === 'POST' && path === '/v1/messages') return opts.messages ? json(400, { error: 'missing model' }) : json(404, { error: 'not found' });
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const reply = nextReply(body ?? {});
        if (reply.status) return json(reply.status, { error: 'scripted' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const id = `c${requests.length}`;
        if (reply.toolCall) {
          sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: reply.toolCall.name, arguments: '' } }] } }] });
          sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: reply.toolCall.arguments } }] } }] });
        } else {
          const text = reply.content ?? '';
          const cut = Math.max(1, Math.floor(text.length / 3));
          const chunks = text.length > 0 ? [text.slice(0, cut), text.slice(cut, cut * 2), text.slice(cut * 2)].filter(Boolean) : [''];
          sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[0] } }] });
          if (reply.stall) return; // hang: the test kills the server
          for (const c of chunks.slice(1)) sse(res, { id, choices: [{ index: 0, delta: { content: c } }] });
        }
        sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: reply.toolCall ? 'tool_calls' : 'stop' }], ...(reply.timings ? { timings: reply.timings } : {}) });
        sse(res, { id, choices: [], usage: reply.usage ?? { prompt_tokens: 20, completion_tokens: 10 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    kill: () => {
      dead = true;
      for (const s of sockets) s.destroy();
    },
    revive: () => {
      dead = false;
    },
    setReplies: (r) => {
      replies = r ?? [{ content: '{}' }];
      n = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
