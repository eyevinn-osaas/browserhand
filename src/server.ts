import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { SessionPool } from './sessions/pool.js';
import { makeAuthHook } from './api/auth.js';
import { registerRoutes } from './api/routes.js';
import { registerCdpProxy } from './api/cdp.js';
import { BrowserhandError, errors } from './types.js';

export const OPENAPI_INFO = {
  title: 'browserhand',
  description:
    'A reliable, deterministic web-automation API for AI agents. Managed headless-browser ' +
    'sessions with selector-free perception (accessibility snapshot + stable refs, page content, ' +
    'screenshots) and structured action primitives. No server-side LLM — the calling agent reasons; ' +
    'browserhand executes. Each endpoint maps cleanly to a single tool.',
  version: '0.1.0',
} as const;

export interface Server {
  app: FastifyInstance;
  pool: SessionPool;
}

/** Build the Fastify app and wire in the browser pool, routes, docs, and error model. */
export async function buildServer(config: Config, log: Logger): Promise<Server> {
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    bodyLimit: 25 * 1024 * 1024,
  });
  const pool = new SessionPool(config, log);

  // Tolerate an empty body even when a client defaults Content-Type to
  // application/json (common in HTTP libraries) — GET/DELETE carry no body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : body;
    if (!raw || raw.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifySwagger, {
    openapi: {
      info: OPENAPI_INFO,
      tags: [
        { name: 'Sessions', description: 'Create and manage browser sessions.' },
        { name: 'Perception', description: 'See what is on the page: snapshot, content, screenshot.' },
        { name: 'Actions', description: 'Operate the page by element ref.' },
        { name: 'Observability', description: 'Logs, downloads, and portable session context.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Set only if BROWSERHAND_API_KEY is configured.' },
        },
      },
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/documentation' });

  // Structured, agent-actionable error model for the whole API.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BrowserhandError) {
      reply.code(error.statusCode).send(error.toJSON());
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    if ((error as { validation?: unknown }).validation || (typeof status === 'number' && status >= 400 && status < 500)) {
      const be = errors.invalidRequest((error as Error).message);
      reply.code(typeof status === 'number' ? status : be.statusCode).send(be.toJSON());
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    const be = errors.internal('Unexpected server error.');
    reply.code(be.statusCode).send(be.toJSON());
  });

  // Auth guard for the operational API (health/docs stay open).
  const authHook = makeAuthHook(config.apiKey);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/')) await authHook(request, reply);
  });

  // Health / readiness — no auth, no heavy work.
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    if (!pool.isReady) {
      reply.code(503);
      return { status: 'starting' };
    }
    return { status: 'ready', sessions: pool.size };
  });
  app.get('/', { schema: { hide: true } }, async () => ({
    name: 'browserhand',
    version: OPENAPI_INFO.version,
    docs: '/documentation',
    openapi: '/documentation/json',
  }));

  const connectUrlFor = (req: FastifyRequest, sessionId: string): string => {
    const host = req.headers.host ?? `localhost:${config.port}`;
    const scheme = req.protocol === 'https' ? 'wss' : 'ws';
    return `${scheme}://${host}/v1/connect/${sessionId}`;
  };

  await registerRoutes(app, { pool, config, connectUrlFor });
  await registerCdpProxy(app, pool, log);

  return { app, pool };
}
