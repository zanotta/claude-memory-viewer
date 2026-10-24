import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Scanner } from './scanner.js';
import { isCrossSiteRequest, isHostAllowed } from './security.js';
import type { ApiError, ChangeEvent, SearchResponse } from './shared/types.js';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const MAX_URL_LENGTH = 4096;
const MAX_SSE_CLIENTS = 50;
const HEARTBEAT_MS = 25_000;

/** Server-sent events fan-out. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | undefined;

  get size(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): boolean {
    if (this.clients.size >= MAX_SSE_CLIENTS) return false;
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stopHeartbeat();
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.write(': keep-alive\n\n'), HEARTBEAT_MS);
      this.timer.unref();
    }
    return true;
  }

  broadcast(event: ChangeEvent): void {
    this.write(`event: changed\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

/** Anything that can answer `GET /api/search`. */
export interface SearchProvider {
  search(query: string): Promise<SearchResponse>;
}

export interface ServerOptions {
  scanner: Scanner;
  host: string;
  port: number;
  /** Directory with the compiled frontend (`dist/web`). */
  webDir: string;
  /** How many consecutive ports to try when the first one is busy. */
  portAttempts?: number;
  search?: SearchProvider;
  events?: EventHub;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  events: EventHub;
  close(): Promise<void>;
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, api = true): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...(api ? { 'Cache-Control': 'no-store' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  const body: ApiError = { error: message };
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function listStaticFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) files.set(`/${prefix}${e.name}`, path.join(dir, e.name));
    }
  };
  await walk(root, '');
  return files;
}

export function listenWithRetry(server: Server, host: string, port: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && port !== 0 && attempt < attempts - 1) {
          attempt++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryListen(port);
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { scanner, host, webDir } = options;
  const events = options.events ?? new EventHub();
  const staticFiles = await listStaticFiles(webDir);
  let actualPort = options.port;

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (isCrossSiteRequest(req.headers)) return sendError(req, res, 403, 'Cross-site requests are not allowed.');
    const route = url.pathname;

    if (route === '/api/overview') return sendJson(req, res, 200, await scanner.overview());

    if (route.startsWith('/api/projects/')) {
      const raw = route.slice('/api/projects/'.length);
      let id: string;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return sendError(req, res, 400, 'Invalid project id.');
      }
      if (!id || id.includes('/')) return sendError(req, res, 404, 'Unknown project.');
      const detail = await scanner.project(id);
      if (!detail) return sendError(req, res, 404, 'Unknown project.');
      return sendJson(req, res, 200, detail);
    }

    if (route === '/api/file') {
      const project = url.searchParams.get('project');
      const filePath = url.searchParams.get('path');
      if (!project || !filePath || project.length > 1024 || filePath.length > 1024) {
        return sendError(req, res, 400, 'Both "project" and "path" are required.');
      }
      const result = await scanner.readFile(project, filePath);
      if (!result.ok) return sendError(req, res, result.status, result.message);
      return sendJson(req, res, 200, result.content);
    }

    if (route === '/api/search') {
      if (!options.search) return sendError(req, res, 404, 'Search is not available.');
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      return sendJson(req, res, 200, await options.search.search(q));
    }

    if (route === '/api/events') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      if (!events.add(res)) {
        res.end();
        return;
      }
      res.write('retry: 2000\n: connected\n\n');
      return;
    }

    return sendError(req, res, 404, 'Not found.');
  };

  const handleStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    const key = pathname === '/' ? '/index.html' : pathname;
    const file = staticFiles.get(key);
    if (!file) return sendError(req, res, 404, 'Not found.');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return sendError(req, res, 404, 'Not found.');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!isHostAllowed(req.headers.host, { port: actualPort, boundHost: host })) {
          return sendError(req, res, 403, 'Forbidden: unexpected Host header.');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendError(req, res, 405, 'This server is read-only.', { Allow: 'GET, HEAD' });
        }
        const rawUrl = req.url ?? '/';
        if (rawUrl.length > MAX_URL_LENGTH) return sendError(req, res, 414, 'URL too long.');
        if (!rawUrl.startsWith('/')) return sendError(req, res, 400, 'Bad request.');
        let url: URL;
        try {
          url = new URL(rawUrl, 'http://localhost');
        } catch {
          return sendError(req, res, 400, 'Bad request.');
        }
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return sendError(req, res, 400, 'Bad request.');
        }
        return await handleStatic(req, res, pathname);
      } catch (err) {
        if (process.env['DEBUG'] === '1') console.error(err);
        if (!res.headersSent) sendError(req, res, 500, 'Internal error.');
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 5_000;

  actualPort = await listenWithRetry(server, host, options.port, options.portAttempts ?? 20);

  return {
    server,
    host,
    port: actualPort,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        events.closeAll();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
