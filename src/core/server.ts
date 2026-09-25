// Control server: the only door agents have into the hive. Loopback-only HTTP with
// a per-agent bearer token, so the sender of every message is authenticated
// (an agent cannot impersonate another). Supports long-polling so agents wake the
// instant mail arrives instead of polling files.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RpcHandler = (agent: string, method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

export class ControlServer {
  private server: Server | null = null;
  private extra: Server[] = [];
  private listening = new Set<string>(['127.0.0.1']);
  /** Host headers accepted besides 127.0.0.1/localhost (e.g. host.docker.internal). */
  private hosts = new Set<string>(['127.0.0.1', 'localhost']);
  private tokens = new Map<string, string>(); // token -> agent id
  port = 0;
  requests = 0;

  constructor(private readonly handler: RpcHandler) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  register(token: string, agent: string): void {
    this.tokens.set(token, agent);
  }
  revokeAgent(agent: string): void {
    for (const [t, a] of this.tokens) if (a === agent) this.tokens.delete(t);
  }

  listen(port = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => void this.handle(req, res));
      srv.keepAliveTimeout = 65_000;
      srv.requestTimeout = 0; // long-polls
      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        this.port = (srv.address() as AddressInfo).port;
        this.server = srv;
        resolve();
      });
    });
  }

  /** Accept requests whose Host is this name (containers reach us as host.docker.internal). */
  allowHost(name: string): void {
    this.hosts.add(name);
  }

  /**
   * Also listen on another local address on the same port, e.g. the Linux docker0
   * gateway so sandboxed agents can connect. Still token-protected. Idempotent.
   */
  async listenAlso(address: string): Promise<void> {
    if (this.listening.has(address)) return;
    this.listening.add(address);
    const srv = createServer((req, res) => void this.handle(req, res));
    srv.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      srv.once('error', (e) => {
        this.listening.delete(address);
        reject(e);
      });
      srv.listen(this.port, address, () => resolve());
    });
    this.extra.push(srv);
    this.hosts.add(address);
  }

  close(): Promise<void> {
    const all = [this.server, ...this.extra].filter((s): s is Server => !!s);
    this.extra = [];
    return Promise.all(
      all.map(
        (srv) =>
          new Promise<void>((r) => {
            srv.closeAllConnections?.();
            srv.close(() => r());
          })
      )
    ).then(() => undefined);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    const send = (code: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    // DNS-rebinding guard: a browser tab pointed at an attacker hostname that resolves
    // to 127.0.0.1 carries that hostname in Host. Agents always use 127.0.0.1:<port>.
    const host = req.headers.host ?? '';
    const sep = host.lastIndexOf(':');
    if (sep < 0 || host.slice(sep + 1) !== String(this.port) || !this.hosts.has(host.slice(0, sep))) return send(403, { error: 'bad host' });
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' });
    const auth = req.headers.authorization ?? '';
    const agent = this.tokens.get(auth.replace(/^Bearer\s+/i, ''));
    if (!agent) return send(401, { error: 'invalid hive token' });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        send(413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: { method?: string; params?: Record<string, unknown> };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return send(400, { error: 'bad json' });
    }
    if (!body || typeof body.method !== 'string') return send(400, { error: 'missing method' });
    const params = body.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) return send(400, { error: 'params must be an object' });
    try {
      const result = await this.handler(agent, body.method, params);
      send(200, { ok: true, result });
    } catch (e) {
      send(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
