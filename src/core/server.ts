// Control server: the only door agents have into the hive. Loopback-only HTTP with
// a per-agent bearer token, so the sender of every message is authenticated
// (an agent cannot impersonate another). Supports long-polling so agents wake the
// instant mail arrives instead of polling files.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RpcHandler = (agent: string, method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

export class ControlServer {
  private server: Server | null = null;
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

  close(): Promise<void> {
    return new Promise((r) => {
      if (!this.server) return r();
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    const send = (code: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' });
    const auth = req.headers.authorization ?? '';
    const agent = this.tokens.get(auth.replace(/^Bearer\s+/i, ''));
    if (!agent) return send(401, { error: 'invalid hive token' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2_000_000) return send(413, { error: 'payload too large' });
    }
    let body: { method?: string; params?: Record<string, unknown> };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return send(400, { error: 'bad json' });
    }
    if (!body.method) return send(400, { error: 'missing method' });
    try {
      const result = await this.handler(agent, body.method, body.params ?? {});
      send(200, { ok: true, result });
    } catch (e) {
      send(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
