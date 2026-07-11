import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { SessionPool } from '../sessions/pool.js';
import type { Logger } from '../logger.js';

/**
 * WebSocket CDP proxy. A remote Playwright/Puppeteer client connects to
 * wss://.../v1/connect/:id and drives the browser directly over the Chrome
 * DevTools Protocol. We pipe frames verbatim between the client and Chromium's
 * internal CDP endpoint — the power-user escape hatch beyond the REST primitives.
 */
export async function registerCdpProxy(app: FastifyInstance, pool: SessionPool, log: Logger): Promise<void> {
  app.get('/v1/connect/:id', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };

    // Validate the session and CDP availability before wiring anything up.
    try {
      pool.get(id);
    } catch {
      socket.close(1008, 'session_not_found');
      return;
    }
    const endpoint = pool.getCdpEndpoint();
    if (!endpoint) {
      socket.close(1011, 'cdp_unavailable');
      return;
    }

    const upstream = new WebSocket(endpoint);
    const pending: Array<Buffer | string> = [];

    upstream.on('open', () => {
      for (const msg of pending) upstream.send(msg);
      pending.length = 0;
    });
    upstream.on('message', (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data as Buffer);
    });
    upstream.on('close', () => socket.close());
    upstream.on('error', (err) => {
      log.warn({ err, sessionId: id }, 'CDP upstream error');
      socket.close(1011, 'cdp_error');
    });

    socket.on('message', (data: Buffer) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else pending.push(data);
    });
    socket.on('close', () => upstream.close());
    socket.on('error', () => upstream.close());
  });
}
