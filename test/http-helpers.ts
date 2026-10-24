import http from 'node:http';
import { Scanner } from '../dist/scanner.js';
import { startServer, type RunningServer, type ServerOptions } from '../dist/server.js';
import { makeTempDir, write } from './helpers.js';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => unknown;
}

/** Raw request so tests can set any Host header or method (fetch cannot). */
export function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; host?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Host: opts.host ?? `localhost:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as unknown });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export interface TestServer {
  running: RunningServer;
  port: number;
  webDir: string;
  get: (path: string, extra?: { host?: string; headers?: Record<string, string> }) => Promise<Reply>;
  stop: () => Promise<void>;
}

export async function startTestServer(
  configDir: string,
  extra: Partial<ServerOptions> = {},
): Promise<TestServer> {
  const web = await makeTempDir('cmv-web-');
  await write(`${web.dir}/index.html`, '<!doctype html><title>t</title>');
  await write(`${web.dir}/app.js`, 'export {};');
  await write(`${web.dir}/style.css`, 'body{}');
  const running = await startServer({
    scanner: new Scanner({ configDir }),
    host: '127.0.0.1',
    port: 0,
    webDir: web.dir,
    ...extra,
  });
  return {
    running,
    port: running.port,
    webDir: web.dir,
    get: (p, e) => request(running.port, { path: p, ...(e?.host ? { host: e.host } : {}), ...(e?.headers ? { headers: e.headers } : {}) }),
    stop: async () => {
      await running.close();
      await web.cleanup();
    },
  };
}
