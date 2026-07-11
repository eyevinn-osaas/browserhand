import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionPool } from '../sessions/pool.js';
import type { Config } from '../config.js';
import * as S from './schemas.js';

interface RoutesDeps {
  pool: SessionPool;
  config: Config;
  /** Builds the wss://.../v1/connect/:id URL advertised to CDP clients. */
  connectUrlFor: (req: FastifyRequest, sessionId: string) => string;
}

const ok = { type: 'object', additionalProperties: true } as const;
const errs = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [c, S.errorResponse]));

/** All /v1 REST routes. Handlers stay thin — logic lives in the session/pool. */
export async function registerRoutes(app: FastifyInstance, deps: RoutesDeps): Promise<void> {
  const { pool } = deps;

  // --- Sessions ----------------------------------------------------------
  app.post('/v1/sessions', {
    schema: {
      tags: ['Sessions'],
      summary: 'Create a browser session',
      description: 'Opens an isolated headless browser session and returns its id plus a CDP connect URL.',
      body: S.createSessionBody,
      response: { 201: ok, 429: S.errorResponse, 503: S.errorResponse },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = await pool.createSession(body);
    reply.code(201);
    return {
      ...session.info(),
      connectUrl: deps.connectUrlFor(req, session.id),
    };
  });

  app.get('/v1/sessions', {
    schema: { tags: ['Sessions'], summary: 'List open sessions', response: { 200: ok } },
  }, async () => ({ sessions: pool.list().map((s) => s.info()) }));

  app.get('/v1/sessions/:id', {
    schema: { tags: ['Sessions'], summary: 'Get session status', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => pool.get((req.params as { id: string }).id).info());

  app.delete('/v1/sessions/:id', {
    schema: { tags: ['Sessions'], summary: 'Close a session', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => {
    await pool.destroy((req.params as { id: string }).id);
    return { closed: true };
  });

  // --- Perception --------------------------------------------------------
  app.get('/v1/sessions/:id/snapshot', {
    schema: {
      tags: ['Perception'],
      summary: 'Accessibility snapshot with stable element refs',
      description: 'Returns the interactive/structural elements on the page, each with a `ref` used by the action endpoints, plus a readable outline. This is the selector-free basis for acting.',
      params: S.sessionIdParam,
      response: { 200: ok, ...errs(404) },
    },
  }, async (req) => pool.get((req.params as { id: string }).id).snapshot());

  app.get('/v1/sessions/:id/content', {
    schema: {
      tags: ['Perception'],
      summary: 'Readable page text',
      description: 'Returns the visible text of the page for the agent to read/extract. `truncated` signals the text was clipped.',
      params: S.sessionIdParam,
      response: { 200: ok, ...errs(404) },
    },
  }, async (req) => pool.get((req.params as { id: string }).id).content());

  app.get('/v1/sessions/:id/screenshot', {
    schema: {
      tags: ['Perception'],
      summary: 'PNG screenshot',
      description: 'Returns image/png so the agent can see the page. Use ?fullPage=true for the whole page or ?ref=eN for one element.',
      params: S.sessionIdParam,
      querystring: S.screenshotQuery,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { fullPage?: boolean; ref?: string };
    const png = await pool.get(id).screenshot({ fullPage: q.fullPage, ref: q.ref });
    reply.header('content-type', 'image/png');
    return reply.send(png);
  });

  // --- Actions -----------------------------------------------------------
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.post('/v1/sessions/:id/navigate', {
    schema: { tags: ['Actions'], summary: 'Navigate to a URL', params: S.sessionIdParam, body: S.navigateBody, response: { 200: ok, ...errs(404, 502) } },
  }, async (req) => pool.get(idOf(req)).navigate((req.body as { url: string }).url));

  app.post('/v1/sessions/:id/back', {
    schema: { tags: ['Actions'], summary: 'Go back', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => pool.get(idOf(req)).back());

  app.post('/v1/sessions/:id/forward', {
    schema: { tags: ['Actions'], summary: 'Go forward', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => pool.get(idOf(req)).forward());

  app.post('/v1/sessions/:id/reload', {
    schema: { tags: ['Actions'], summary: 'Reload the page', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => pool.get(idOf(req)).reload());

  app.post('/v1/sessions/:id/click', {
    schema: { tags: ['Actions'], summary: 'Click an element by ref', params: S.sessionIdParam, body: S.clickBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    await pool.get(idOf(req)).click((req.body as { ref: string }).ref);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/type', {
    schema: { tags: ['Actions'], summary: 'Type into a field by ref', params: S.sessionIdParam, body: S.typeBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    const b = req.body as { ref: string; text: string; submit?: boolean };
    await pool.get(idOf(req)).type(b.ref, b.text, b.submit ?? false);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/select', {
    schema: { tags: ['Actions'], summary: 'Select option(s) by ref', params: S.sessionIdParam, body: S.selectBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    const b = req.body as { ref: string; values: string[] };
    const selected = await pool.get(idOf(req)).select(b.ref, b.values);
    return { ok: true, selected };
  });

  app.post('/v1/sessions/:id/hover', {
    schema: { tags: ['Actions'], summary: 'Hover an element by ref', params: S.sessionIdParam, body: S.hoverBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    await pool.get(idOf(req)).hover((req.body as { ref: string }).ref);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/press', {
    schema: { tags: ['Actions'], summary: 'Press a key or chord', params: S.sessionIdParam, body: S.pressBody, response: { 200: ok, ...errs(404) } },
  }, async (req) => {
    await pool.get(idOf(req)).press((req.body as { key: string }).key);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/scroll', {
    schema: { tags: ['Actions'], summary: 'Scroll the page or an element into view', params: S.sessionIdParam, body: S.scrollBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    const b = (req.body ?? {}) as { direction?: 'up' | 'down' | 'left' | 'right'; ref?: string };
    await pool.get(idOf(req)).scroll(b.direction ?? 'down', b.ref);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/wait', {
    schema: { tags: ['Actions'], summary: 'Wait for text/ref/timeout', params: S.sessionIdParam, body: S.waitBody, response: { 200: ok, ...errs(404, 504) } },
  }, async (req) => {
    await pool.get(idOf(req)).wait((req.body ?? {}) as { text?: string; ref?: string; timeoutMs?: number });
    return { ok: true };
  });

  app.post('/v1/sessions/:id/upload', {
    schema: { tags: ['Actions'], summary: 'Set files on a file input by ref', params: S.sessionIdParam, body: S.uploadBody, response: { 200: ok, ...errs(404, 409) } },
  }, async (req) => {
    const b = req.body as { ref: string; files: Array<{ name: string; mimeType: string; contentBase64: string }> };
    const files = b.files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.contentBase64, 'base64') }));
    await pool.get(idOf(req)).upload(b.ref, files);
    return { ok: true };
  });

  // --- Observability & artifacts ----------------------------------------
  app.get('/v1/sessions/:id/logs', {
    schema: {
      tags: ['Observability'],
      summary: 'Captured console or network logs',
      description: 'Returns ring-buffered console messages or network responses for debugging a web flow.',
      params: S.sessionIdParam,
      querystring: S.logsQuery,
      response: { 200: ok, ...errs(404) },
    },
  }, async (req) => {
    const q = req.query as { type: 'console' | 'network'; limit?: number };
    return { type: q.type, entries: pool.get(idOf(req)).logs(q.type, q.limit) };
  });

  app.get('/v1/sessions/:id/downloads', {
    schema: { tags: ['Observability'], summary: 'List captured downloads', params: S.sessionIdParam, response: { 200: ok, ...errs(404) } },
  }, async (req) => ({ downloads: pool.get(idOf(req)).listDownloads() }));

  app.get('/v1/sessions/:id/downloads/:downloadId', {
    schema: {
      tags: ['Observability'],
      summary: 'Fetch a downloaded file',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, downloadId: { type: 'string' } },
        required: ['id', 'downloadId'],
      },
    },
  }, async (req, reply) => {
    const { id, downloadId } = req.params as { id: string; downloadId: string };
    const { path, info } = pool.get(id).getDownloadPath(downloadId);
    const { createReadStream } = await import('node:fs');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${info.filename}"`);
    return reply.send(createReadStream(path));
  });

  app.get('/v1/sessions/:id/context', {
    schema: {
      tags: ['Observability'],
      summary: 'Export session context (cookies + localStorage)',
      description: 'Returns a portable state object. Pass it back as `context` in POST /v1/sessions to reuse a logged-in session.',
      params: S.sessionIdParam,
      response: { 200: ok, ...errs(404) },
    },
  }, async (req) => pool.get(idOf(req)).exportContext());
}
