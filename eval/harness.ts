import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildServer } from '../src/server.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface FixtureServer {
  origin: string;
  url: (name: string) => string;
  close: () => Promise<void>;
}

/** Serve eval/fixtures/*.html over HTTP so browser navigation exercises the real network stack. */
export async function startFixtures(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
        const file = join(fixturesDir, rel === '/' ? 'index.html' : rel);
        const data = await readFile(file);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(data);
      } catch {
        res.statusCode = 404;
        res.end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (name: string) => `${origin}/${name.replace(/^\//, '')}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Each browserhand instance needs its own Chromium remote-debugging port so
// concurrent/successive test servers never collide on the CDP port.
let nextCdpPort = 9301;

export interface BrowserhandInstance {
  baseUrl: string;
  pool: Awaited<ReturnType<typeof buildServer>>['pool'];
  close: () => Promise<void>;
}

export async function startBrowserhand(envOverrides: NodeJS.ProcessEnv = {}): Promise<BrowserhandInstance> {
  const config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'silent',
    CDP_PORT: String(nextCdpPort++),
    ...envOverrides,
  });
  const log = createLogger('silent');
  const { app, pool } = await buildServer(config, log);
  await app.listen({ host: '127.0.0.1', port: 0 });
  await pool.start();
  const port = (app.server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    close: async () => {
      await app.close();
      await pool.stop();
    },
  };
}
