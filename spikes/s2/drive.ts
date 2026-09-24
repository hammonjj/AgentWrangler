/**
 * Spike S2 driver: talks to the spike core and to hosts directly, and prints
 * process facts. THROWAWAY. Run with plain `node` (type stripping).
 *
 *   node drive.ts core '<json request>' [timeoutMs]
 *   node drive.ts host <id> '<json request>' [timeoutMs]   # hello with the 0600 token file, then the request
 *   node drive.ts ps <pid...>                               # pid ppid pgid sess rss comm, or DEAD
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const RUN = '/tmp/aw-spike-s2/run';

function rpc(sock: string, reqs: object[], timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const out: unknown[] = [];
    let buf = '';
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => reqs.forEach((r) => c.write(`${JSON.stringify(r)}\n`)));
    c.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
      if (out.length >= reqs.length) {
        clearTimeout(timer);
        c.end();
        resolve(out);
      }
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const t0 = Date.now();
try {
  if (cmd === 'core') {
    const r = await rpc(path.join(RUN, 'core.sock'), [JSON.parse(rest[0])], Number(rest[1] ?? 20000));
    console.log(JSON.stringify(r[0]));
  } else if (cmd === 'host') {
    const id = rest[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(RUN, `${id}.json`), 'utf8')) as { socket: string };
    const token = fs.readFileSync(path.join(RUN, `${id}.token`), 'utf8');
    const r = await rpc(
      manifest.socket,
      [{ id: 1, method: 'hello', params: { hostId: id, token } }, { id: 2, ...JSON.parse(rest[1]) }],
      Number(rest[2] ?? 120000),
    );
    console.log(JSON.stringify(r));
  } else if (cmd === 'ps') {
    for (const pid of rest) {
      try {
        console.log(execFileSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,sess=,rss=,comm=', '-p', pid], { encoding: 'utf8' }).trim());
      } catch {
        console.log(`${pid} DEAD`);
      }
    }
  } else if (cmd === 'check') {
    // Survival check: host + claude pids alive, reconnect with the file token, and a real turn.
    for (const id of rest) {
      const m = JSON.parse(fs.readFileSync(path.join(RUN, `${id}.json`), 'utf8')) as { socket: string; pid: number; claudePid: number };
      const token = fs.readFileSync(path.join(RUN, `${id}.token`), 'utf8');
      const ps = (pid: number): string => {
        try {
          return execFileSync('/bin/ps', ['-o', 'ppid=,pgid=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().replace(/\s+/g, ' ');
        } catch {
          return 'DEAD';
        }
      };
      const line = [`${id}: host ${m.pid} [ppid pgid rss: ${ps(m.pid)}]`, `claude ${m.claudePid} [${ps(m.claudePid)}]`];
      try {
        const t = Date.now();
        const r = (await rpc(
          m.socket,
          [
            { id: 1, method: 'hello', params: { hostId: id, token } },
            { id: 2, method: 'send', params: { text: 'Reply with exactly: pong' } },
          ],
          120000,
        )) as { result?: { text?: string; ms?: number }; error?: string }[];
        line.push(`turn=${JSON.stringify(r[1].result?.text ?? r[1].error)} in ${Date.now() - t} ms`);
      } catch (err) {
        line.push(`reconnect/turn FAILED: ${String(err)}`);
      }
      console.log(line.join(' | '));
    }
  } else {
    console.error('usage: core|host|ps|check');
    process.exit(2);
  }
} catch (err) {
  console.log(`ERROR ${String(err)} (${Date.now() - t0} ms)`);
  process.exit(1);
}
