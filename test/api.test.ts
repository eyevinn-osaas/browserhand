import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBrowserhand, startFixtures, type BrowserhandInstance, type FixtureServer } from '../eval/harness.js';
import { makeClient, findNode } from './client.js';
import type { SnapshotResult } from '../src/types.js';

let bh: BrowserhandInstance;
let fx: FixtureServer;
let api: ReturnType<typeof makeClient>;

beforeAll(async () => {
  fx = await startFixtures();
  bh = await startBrowserhand();
  api = makeClient(bh.baseUrl);
});

afterAll(async () => {
  await bh?.close();
  await fx?.close();
});

async function newSession(context?: unknown): Promise<string> {
  const { status, body } = await api.json<{ sessionId: string }>('POST', '/v1/sessions', context ? { context } : {});
  expect(status).toBe(201);
  return body.sessionId;
}

describe('health', () => {
  it('serves healthz and readyz', async () => {
    expect((await api.json('GET', '/healthz')).body).toMatchObject({ status: 'ok' });
    expect((await api.json('GET', '/readyz')).body).toMatchObject({ status: 'ready' });
  });
  it('serves the OpenAPI spec', async () => {
    const { status, body } = await api.json<{ paths: object }>('GET', '/documentation/json');
    expect(status).toBe(200);
    expect(Object.keys(body.paths).length).toBeGreaterThan(15);
  });
});

describe('session lifecycle', () => {
  it('creates, gets, lists and deletes a session', async () => {
    const id = await newSession();
    const got = await api.json<{ sessionId: string; connectUrl: string }>('GET', `/v1/sessions/${id}`);
    expect(got.body.sessionId).toBe(id);

    const list = await api.json<{ sessions: unknown[] }>('GET', '/v1/sessions');
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(1);

    expect((await api.json('DELETE', `/v1/sessions/${id}`)).body).toMatchObject({ closed: true });
    expect((await api.json('GET', `/v1/sessions/${id}`)).status).toBe(404);
  });

  it('returns a connect URL for the CDP proxy', async () => {
    const { body } = await api.json<{ connectUrl: string; sessionId: string }>('POST', '/v1/sessions', {});
    expect(body.connectUrl).toMatch(/^ws:\/\/.+\/v1\/connect\/.+/);
    await api.json('DELETE', `/v1/sessions/${body.sessionId}`);
  });
});

describe('perception + actions', () => {
  it('snapshots refs and drives a login form to change the page', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('login.html') });

    const snap = (await api.json<SnapshotResult>('GET', `/v1/sessions/${id}/snapshot`)).body;
    expect(snap.title).toBe('Sign in');
    const username = findNode(snap.nodes, (n) => n.name === 'Username');
    const button = findNode(snap.nodes, (n) => n.role === 'button');

    await api.json('POST', `/v1/sessions/${id}/type`, { ref: username.ref, text: 'jonas' });
    expect((await api.json('POST', `/v1/sessions/${id}/click`, { ref: button.ref })).status).toBe(200);

    const content = (await api.json<{ text: string }>('GET', `/v1/sessions/${id}/content`)).body;
    expect(content.text).toContain('Welcome, jonas');
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('selects an option by ref', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('catalog.html') });
    const snap = (await api.json<SnapshotResult>('GET', `/v1/sessions/${id}/snapshot`)).body;
    const combo = findNode(snap.nodes, (n) => n.role === 'combobox');
    await api.json('POST', `/v1/sessions/${id}/select`, { ref: combo.ref, values: ['b'] });
    const content = (await api.json<{ text: string }>('GET', `/v1/sessions/${id}/content`)).body;
    expect(content.text).toContain('Category: Bananas');
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('returns a PNG screenshot', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('catalog.html') });
    const shot = await api.raw('GET', `/v1/sessions/${id}/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.contentType).toBe('image/png');
    expect(shot.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic
    await api.json('DELETE', `/v1/sessions/${id}`);
  });
});

describe('instructive errors', () => {
  it('returns a stale_ref error for an unknown ref', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('login.html') });
    const { status, body } = await api.json<{ error: { code: string; message: string } }>(
      'POST', `/v1/sessions/${id}/click`, { ref: 'e9999' },
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('stale_ref');
    expect(body.error.message).toMatch(/snapshot/i);
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('404s on an unknown session and 400s on a bad body', async () => {
    expect((await api.json('GET', '/v1/sessions/does-not-exist')).status).toBe(404);
    expect((await api.json('POST', '/v1/sessions/x/navigate', {})).status).toBe(400); // missing url
  });
});

describe('observability + artifacts', () => {
  it('captures network logs', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('catalog.html') });
    const logs = (await api.json<{ entries: unknown[] }>('GET', `/v1/sessions/${id}/logs?type=network`)).body;
    expect(logs.entries.length).toBeGreaterThan(0);
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('captures a download and serves its bytes', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('files.html') });
    const snap = (await api.json<SnapshotResult>('GET', `/v1/sessions/${id}/snapshot`)).body;
    const link = findNode(snap.nodes, (n) => n.role === 'link');
    await api.json('POST', `/v1/sessions/${id}/click`, { ref: link.ref });

    // Downloads resolve asynchronously — poll briefly.
    let downloads: Array<{ downloadId: string; filename: string }> = [];
    for (let i = 0; i < 20 && downloads.length === 0; i++) {
      downloads = (await api.json<{ downloads: typeof downloads }>('GET', `/v1/sessions/${id}/downloads`)).body.downloads;
      if (downloads.length === 0) await new Promise((r) => setTimeout(r, 150));
    }
    expect(downloads.length).toBe(1);
    expect(downloads[0]!.filename).toBe('report.txt');

    const file = await api.raw('GET', `/v1/sessions/${id}/downloads/${downloads[0]!.downloadId}`);
    expect(file.bytes.toString()).toContain('browserhand-report-ok');
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('uploads a file to a file input', async () => {
    const id = await newSession();
    await api.json('POST', `/v1/sessions/${id}/navigate`, { url: fx.url('files.html') });
    const snap = (await api.json<SnapshotResult>('GET', `/v1/sessions/${id}/snapshot`)).body;
    const input = findNode(snap.nodes, (n) => n.tag === 'input' && n.name === 'Attachment');
    await api.json('POST', `/v1/sessions/${id}/upload`, {
      ref: input.ref,
      files: [{ name: 'note.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') }],
    });
    const content = (await api.json<{ text: string }>('GET', `/v1/sessions/${id}/content`)).body;
    expect(content.text).toContain('uploaded note.txt');
    await api.json('DELETE', `/v1/sessions/${id}`);
  });

  it('exports and re-imports session context (cookies + localStorage)', async () => {
    const a = await newSession();
    await api.json('POST', `/v1/sessions/${a}/navigate`, { url: fx.url('storage.html') });
    const tokenA = (await api.json<{ text: string }>('GET', `/v1/sessions/${a}/content`)).body.text;
    expect(tokenA).toMatch(/token: tok-/);

    const context = (await api.json('GET', `/v1/sessions/${a}/context`)).body;
    await api.json('DELETE', `/v1/sessions/${a}`);

    const b = await newSession(context);
    await api.json('POST', `/v1/sessions/${b}/navigate`, { url: fx.url('storage.html') });
    const tokenB = (await api.json<{ text: string }>('GET', `/v1/sessions/${b}/content`)).body.text;
    expect(tokenB).toBe(tokenA); // reused, not regenerated
    await api.json('DELETE', `/v1/sessions/${b}`);
  });
});

describe('concurrency limit', () => {
  it('rejects sessions beyond the cap with 429', async () => {
    const inst = await startBrowserhand({ MAX_CONCURRENT_SESSIONS: '1' });
    const c = makeClient(inst.baseUrl);
    try {
      const first = await c.json<{ sessionId: string }>('POST', '/v1/sessions', {});
      expect(first.status).toBe(201);
      const second = await c.json<{ error: { code: string } }>('POST', '/v1/sessions', {});
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('session_limit_reached');
    } finally {
      await inst.close();
    }
  });
});

describe('auth', () => {
  it('enforces the bearer token when configured', async () => {
    const inst = await startBrowserhand({ BROWSERHAND_API_KEY: 'secret' });
    try {
      const noAuth = makeClient(inst.baseUrl);
      expect((await noAuth.json('GET', '/v1/sessions')).status).toBe(401);
      // health stays open
      expect((await noAuth.json('GET', '/healthz')).status).toBe(200);

      const withAuth = makeClient(inst.baseUrl, { authorization: 'Bearer secret' });
      expect((await withAuth.json('GET', '/v1/sessions')).status).toBe(200);
    } finally {
      await inst.close();
    }
  });
});
